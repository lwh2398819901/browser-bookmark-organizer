#!/usr/bin/env python3
"""Create a deterministic audit and HTML profile from browser bookmarks.

Supports Chromium Bookmarks JSON and Netscape bookmark exports without third-party
packages. Link checks are opt-in and deliberately distinguish unavailable from
unverified responses.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import html
import json
import re
import sys
from collections import Counter, defaultdict
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

TRACKING_KEYS = {"fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "_hsenc", "_hsmi"}
UNVERIFIED_CODES = {401, 403, 407, 408, 409, 425, 429, 451}

CONTENT_TYPE_RULES = {
    "文档／参考": ("docs.", "documentation", "官方", "reference", "manual", "wiki", "帮助中心"),
    "课程／教程": ("教程", "课程", "guide", "learn", "学习", "入门", "training"),
    "文章／资讯": ("blog", "news", "article", "weekly", "文章", "资讯", "专栏"),
    "代码／项目": ("github.com", "gitlab.com", "gitee.com", "repository", "repo"),
    "工具／服务": ("tool", "工具", "converter", "generator", "在线", "console", "dashboard", "calculator"),
    "视频／社区": ("bilibili", "youtube", "forum", "社区", "问答", "v2ex"),
}


def normalized_url(value: str, *, keep_fragment: bool = False) -> str:
    """Normalize only safe URL differences and remove known tracking parameters."""
    try:
        parts = urlsplit(value.strip())
        scheme = parts.scheme.lower()
        host = (parts.hostname or "").lower()
        port = parts.port
        netloc = host
        if port and not ((scheme == "https" and port == 443) or (scheme == "http" and port == 80)):
            netloc = f"{host}:{port}"
        path = parts.path.rstrip("/") or "/"
        pairs = [
            (key, val) for key, val in parse_qsl(parts.query, keep_blank_values=True)
            if key.lower() not in TRACKING_KEYS and not key.lower().startswith("utm_")
        ]
        fragment = parts.fragment if keep_fragment else ""
        return urlunsplit((scheme, netloc, path, urlencode(pairs, doseq=True), fragment))
    except ValueError:
        return value.strip()


class NetscapeBookmarks(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.items: list[dict[str, Any]] = []
        self._folder_stack: list[tuple[str, int]] = []
        self._dl_depth = 0
        self._pending_folder: str | None = None
        self._capturing: str | None = None
        self._attrs: dict[str, str] = {}
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = {key.lower(): value or "" for key, value in attrs}
        if tag.lower() == "dl":
            self._dl_depth += 1
            if self._pending_folder:
                self._folder_stack.append((self._pending_folder, self._dl_depth))
                self._pending_folder = None
        elif tag.lower() in {"h3", "a"}:
            self._capturing = tag.lower()
            self._attrs = attrs_dict
            self._text = []

    def handle_endtag(self, tag: str) -> None:
        lowered = tag.lower()
        if lowered == "dl":
            while self._folder_stack and self._folder_stack[-1][1] == self._dl_depth:
                self._folder_stack.pop()
            self._dl_depth = max(0, self._dl_depth - 1)
        elif lowered == self._capturing:
            title = " ".join("".join(self._text).split())
            if lowered == "h3":
                self._pending_folder = title
            elif lowered == "a" and self._attrs.get("href"):
                self.items.append({
                    "id": None,
                    "title": title,
                    "url": self._attrs["href"],
                    "path": [name for name, _depth in self._folder_stack],
                })
            self._capturing = None
            self._attrs = {}
            self._text = []

    def handle_data(self, data: str) -> None:
        if self._capturing:
            self._text.append(data)


def chromium_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []

    def visit(node: dict[str, Any], path: list[str]) -> None:
        node_type = node.get("type")
        name = str(node.get("name", ""))
        next_path = path + ([name] if node_type == "folder" and name else [])
        if node_type == "url":
            entries.append({"id": str(node.get("id", "")), "title": name, "url": str(node.get("url", "")), "path": path})
        for child in node.get("children", []):
            visit(child, next_path)

    roots = payload.get("roots", {})
    labels = {"bookmark_bar": "收藏夹栏", "other": "其他收藏夹", "synced": "移动设备收藏夹"}
    for key, root in roots.items():
        if not isinstance(root, dict):
            continue
        root_copy = dict(root)
        root_copy["name"] = labels.get(key, root.get("name", key))
        root_copy["type"] = "folder"
        visit(root_copy, [])
    return entries


def load_items(source: Path, explicit_format: str) -> tuple[list[dict[str, Any]], str]:
    raw = source.read_text(encoding="utf-8-sig", errors="replace")
    fmt = explicit_format
    if fmt == "auto":
        fmt = "chromium" if raw.lstrip().startswith("{") else "html"
    if fmt == "chromium":
        return chromium_items(json.loads(raw)), fmt
    if fmt == "html":
        parser = NetscapeBookmarks()
        parser.feed(raw)
        return parser.items, fmt
    raise ValueError(f"Unsupported format: {fmt}")


def title_from_bytes(content: bytes) -> str | None:
    match = re.search(rb"<title[^>]*>(.*?)</title>", content, re.IGNORECASE | re.DOTALL)
    if not match:
        return None
    return " ".join(html.unescape(match.group(1).decode("utf-8", errors="replace")).split())[:300]


def check_one(url: str, timeout: float) -> dict[str, Any]:
    headers = {"User-Agent": "Mozilla/5.0 BookmarkOrganizer/1.0", "Accept": "text/html,*/*;q=0.8"}
    try:
        request = Request(url, headers=headers, method="HEAD")
        with urlopen(request, timeout=timeout) as response:
            return {"status": "available", "http_status": response.status, "final_url": response.geturl(), "page_title": None}
    except HTTPError as error:
        if error.code not in {405, 501}:
            status = "unverified" if error.code in UNVERIFIED_CODES else "unavailable"
            return {"status": status, "http_status": error.code, "final_url": error.geturl(), "page_title": None}
    except (URLError, TimeoutError, ValueError) as error:
        return {"status": "unverified", "http_status": None, "final_url": None, "page_title": None, "error": str(error)[:180]}
    try:
        request = Request(url, headers={**headers, "Range": "bytes=0-65535"}, method="GET")
        with urlopen(request, timeout=timeout) as response:
            return {"status": "available", "http_status": response.status, "final_url": response.geturl(), "page_title": title_from_bytes(response.read(65536))}
    except HTTPError as error:
        status = "unverified" if error.code in UNVERIFIED_CODES else "unavailable"
        return {"status": status, "http_status": error.code, "final_url": error.geturl(), "page_title": None}
    except (URLError, TimeoutError, ValueError) as error:
        return {"status": "unverified", "http_status": None, "final_url": None, "page_title": None, "error": str(error)[:180]}


def duplicate_groups(items: list[dict[str, Any]], key_name: str) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        grouped[item[key_name]].append(item)
    return [
        {"normalized_url": key, "bookmarks": [{"id": x["id"], "title": x["title"], "path": x["path"], "url": x["url"]} for x in value]}
        for key, value in grouped.items() if len(value) > 1
    ]


def compare_baseline(current: list[dict[str, Any]], baseline_path: Path | None) -> list[dict[str, Any]]:
    if not baseline_path:
        return []
    previous = json.loads(baseline_path.read_text(encoding="utf-8"))
    prior_links = previous.get("link_results", {})
    changes = []
    for item in current:
        prior = prior_links.get(item["normalized_url"])
        now = item.get("link")
        if not prior or not now:
            continue
        fields = [field for field in ("status", "final_url", "page_title") if prior.get(field) != now.get(field)]
        if fields:
            changes.append({"url": item["url"], "title": item["title"], "changed_fields": fields, "before": prior, "after": now})
    return changes


def classify_item(item: dict[str, Any], rules: dict[str, tuple[str, ...]], fallback: str) -> str:
    text = " ".join([item["title"], item["url"], *item["path"]]).lower()
    scores = {label: sum(1 for word in words if word.lower() in text) for label, words in rules.items()}
    label, score = max(scores.items(), key=lambda pair: pair[1])
    return label if score else fallback


def collection_overview(items: list[dict[str, Any]], domains: Counter[str]) -> dict[str, Any]:
    folders: dict[str, list[dict[str, Any]]] = defaultdict(list)
    content_types: Counter[str] = Counter()
    for item in items:
        folder = item["path"][1] if len(item["path"]) > 1 else item["path"][0] if item["path"] else "未分类"
        folders[folder].append(item)
        content_types[classify_item(item, CONTENT_TYPE_RULES, "其他页面")]+= 1
    folder_counts = Counter({label: len(group) for label, group in folders.items()})
    top_five_share = round(sum(count for _domain, count in domains.most_common(5)) / max(1, len(items)) * 100, 1)
    samples = {
        label: [
            {"title": item["title"], "url": item["url"], "path": item["path"]}
            for item in group[:5]
        ]
        for label, group in sorted(folders.items(), key=lambda pair: len(pair[1]), reverse=True)
    }
    return {
        "folder_distribution": dict(folder_counts.most_common()),
        "content_type_distribution": dict(content_types.most_common()),
        "structure": {
            "deep_folder_bookmarks": sum(1 for item in items if len(item["path"]) >= 3),
            "top_five_domain_share_percent": top_five_share,
            "other_content_type_bookmarks": content_types.get("其他页面", 0),
        },
        "folder_samples": samples,
    }


def bar_rows(counter: Counter[str], limit: int = 10) -> str:
    if not counter:
        return "<p>暂无数据</p>"
    maximum = max(counter.values())
    rows = []
    for label, count in counter.most_common(limit):
        width = max(2, round(count / maximum * 100))
        rows.append(f"<div class='bar-row'><div><span>{html.escape(label)}</span><b>{count}</b></div><i><em style='width:{width}%'></em></i></div>")
    return "".join(rows)


def escaped_lines(values: Any) -> str:
    if not isinstance(values, list):
        return ""
    return "".join(f"<li>{html.escape(str(value))}</li>" for value in values if str(value).strip())


def insight_section(insights: dict[str, Any]) -> str:
    if not insights:
        return """<section class='ai-panel'><p class='eyebrow'>AI 语义层</p><h2>等待一次证据驱动的解读</h2><p>本页已有完整统计。通过技能生成 <code>ai-insights.json</code> 并再次运行审计后，这里会显示由大模型根据书签证据写出的知识主线、信息习惯与下一步建议。</p></section>"""
    headline = html.escape(str(insights.get("headline", "基于收藏证据的综合解读")))
    narrative = html.escape(str(insights.get("summary", "")))
    focus = insights.get("focus_areas", [])
    focus_html = "".join(
        "<article><h3>{}</h3><p>{}</p><small>{}</small></article>".format(
            html.escape(str(item.get("name", "主题"))),
            html.escape(str(item.get("interpretation", ""))),
            html.escape(str(item.get("evidence", ""))),
        )
        for item in focus if isinstance(item, dict)
    )
    actions = insights.get("next_actions", [])
    actions_html = "".join(
        "<li><b>{}</b><span>{}</span><small>{}</small></li>".format(
            html.escape(str(item.get("priority", "建议"))),
            html.escape(str(item.get("action", ""))),
            html.escape(str(item.get("evidence", ""))),
        )
        for item in actions if isinstance(item, dict)
    )
    habits = escaped_lines(insights.get("information_habits", []))
    taxonomy = insights.get("taxonomy", [])
    taxonomy_html = "".join(
        "<article><h3>{}</h3><p>{}</p><small>{}</small></article>".format(
            html.escape(str(item.get("name", "主题"))),
            html.escape(str(item.get("definition", ""))),
            html.escape(str(item.get("evidence", ""))),
        )
        for item in taxonomy if isinstance(item, dict)
    )
    taxonomy_section = f"<h3>本次收藏夹的动态主题体系</h3><div class='focus-grid'>{taxonomy_html}</div>" if taxonomy_html else ""
    return f"""<section class='ai-panel'><p class='eyebrow'>AI 语义层 · 结论均应回溯至书签证据</p><h2>{headline}</h2><p class='lead'>{narrative}</p>
    {taxonomy_section}
    <div class='focus-grid'>{focus_html}</div>
    <div class='ai-columns'><div><h3>可见的信息习惯</h3><ul>{habits}</ul></div><div><h3>建议的下一步</h3><ol class='actions'>{actions_html}</ol></div></div></section>"""


def profile_html(audit: dict[str, Any]) -> str:
    stats = audit["stats"]
    overview = audit["collection_overview"]
    topics = Counter(overview["folder_distribution"])
    content_types = Counter(overview["content_type_distribution"])
    domains = Counter(audit["profile"]["top_domains"])
    link = Counter(result.get("status") for result in audit.get("link_results", {}).values())
    cards = "".join(f"<article><strong>{count}</strong><span>{html.escape(label)}</span></article>" for label, count in [
        ("条收藏", stats["bookmark_count"]), ("个文件夹", stats["folder_count"]), ("精确重复", stats["duplicate_group_count"]), ("关联入口", stats["related_url_group_count"])
    ])
    structure = overview["structure"]
    observations = [
        f"当前目录中收藏最多的分类是「{'、'.join(label for label, _count in topics.most_common(3))}」。",
        f"{structure['deep_folder_bookmarks']} 条收藏位于三级及更深目录，反映出已有的组织层次。",
        f"前五个来源占全部收藏的 {structure['top_five_domain_share_percent']}%，可用于判断来源是否过度集中。",
    ]
    quality = [("精确重复链接", stats["duplicate_group_count"]), ("同页不同章节／参数", stats["related_url_group_count"]), ("链接可用", link.get("available", 0)), ("链接不可用", link.get("unavailable", 0)), ("需要人工复核", link.get("unverified", 0)), ("相较基线有变化", len(audit["changes"]))]
    quality_html = "".join(f"<tr><td>{html.escape(label)}</td><td>{count}</td></tr>" for label, count in quality)
    return f"""<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>知识版图 · 收藏夹画像</title>
<style>:root{{--paper:#f5f1e8;--ink:#17221f;--muted:#64736d;--line:#d5d0c4;--green:#1f5b4e;--clay:#a5513a;--gold:#af7a26;--panel:#fcfaf5}}*{{box-sizing:border-box}}body{{margin:0;background:var(--paper);color:var(--ink);font:16px/1.65 "Microsoft YaHei UI","Noto Sans SC",sans-serif;text-wrap:pretty}}main{{max-width:1180px;margin:auto;padding:30px 32px 64px}}.masthead{{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(260px,.7fr);gap:36px;padding:42px 0 34px;border-bottom:1px solid var(--ink)}}.eyebrow{{margin:0 0 8px;color:var(--green);font-size:12px;letter-spacing:.14em;font-weight:700}}h1,h2,h3{{font-family:"Iowan Old Style","Songti SC",Georgia,serif;line-height:1.12}}h1{{font-size:clamp(42px,7vw,78px);margin:0;letter-spacing:-.05em}}h2{{font-size:28px;margin:0 0 18px}}h3{{font-size:18px;margin:0 0 7px}}p{{margin:0 0 12px}}.masthead aside{{align-self:end;color:var(--muted);font-size:14px}}.cards{{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid var(--line)}}.cards article{{padding:22px 18px 24px 0;border-right:1px solid var(--line)}}.cards article+article{{padding-left:18px}}.cards article:last-child{{border:0}}.cards strong{{display:block;font:44px/1 "Iowan Old Style",Georgia,serif;letter-spacing:-.04em}}.cards span{{color:var(--muted);font-size:13px}}.section{{padding:34px 0;border-bottom:1px solid var(--line)}}.split{{display:grid;grid-template-columns:1fr 1fr;gap:52px}}.bar-row{{margin:0 0 14px}}.bar-row>div{{display:flex;justify-content:space-between;gap:16px;font-size:14px}}.bar-row b{{font-weight:600}}.bar-row i{{display:block;height:5px;background:#e2ddd2;margin-top:7px}}.bar-row em{{display:block;height:100%;background:var(--green)}}.evidence{{padding:20px 22px;background:#e8eee6;border-left:3px solid var(--green)}}.evidence ul{{padding-left:19px;margin:10px 0 0}}.ai-panel{{margin-top:34px;padding:30px 34px;background:var(--ink);color:#f6f2e9}}.ai-panel .eyebrow{{color:#b6d2bd}}.ai-panel .lead{{max-width:850px;font-size:19px;color:#e1e6dd}}.focus-grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#405149;margin:28px 0}}.focus-grid article{{background:var(--ink);padding:18px}}.focus-grid p{{color:#d9e1da;font-size:14px}}.focus-grid small,.actions small{{color:#aab8af;font-size:12px}}.ai-columns{{display:grid;grid-template-columns:1fr 1fr;gap:32px;border-top:1px solid #405149;padding-top:22px}}.ai-columns ul,.actions{{margin:8px 0;padding-left:20px}}.actions li{{padding:0 0 12px 6px}}.actions b{{display:block;color:#d9b96f;font-size:12px;letter-spacing:.08em}}.actions span{{display:block}}table{{width:100%;border-collapse:collapse;font-size:14px}}td,th{{padding:11px 0;text-align:left;border-bottom:1px solid var(--line)}}td:last-child,th:last-child{{text-align:right}}.note{{color:var(--muted);font-size:13px;margin-top:16px}}code{{font-family:ui-monospace,Consolas,monospace}}@media(max-width:760px){{main{{padding:18px}}.masthead,.split,.ai-columns{{grid-template-columns:1fr;gap:24px}}.cards{{grid-template-columns:1fr 1fr}}.cards article:nth-child(2){{border-right:0}}.cards article:nth-child(n+3){{border-top:1px solid var(--line)}}.focus-grid{{grid-template-columns:1fr}}.ai-panel{{padding:24px 20px}}}}</style></head><body><main>
<header class='masthead'><div><p class='eyebrow'>KNOWLEDGE FOOTPRINT / 书签内容分析</p><h1>你的知识版图</h1><p>这不是书签清单，而是从目录、来源与内容类型中提取出的可验证知识结构。</p></div><aside>生成于 {html.escape(audit['generated_at'])}<br>输入：{html.escape(audit['format'])} 收藏夹<br>统计层由本地命令生成；语义层标明 AI 解读。</aside></header>
<section class='cards'>{cards}</section>
{insight_section(audit.get('ai_insights', {}))}
<section class='section split'><div><p class='eyebrow'>现有目录结构</p><h2>当前如何组织</h2>{bar_rows(topics)}</div><div><p class='eyebrow'>内容形态</p><h2>你保存的是什么</h2>{bar_rows(content_types)}</div></section>
<section class='section split'><div><p class='eyebrow'>来源结构</p><h2>高频信息来源</h2>{bar_rows(domains)}</div><div class='evidence'><p class='eyebrow'>数据所见</p><h2>结构性信号</h2><ul>{escaped_lines(observations)}</ul></div></section>
<section class='section'><p class='eyebrow'>健康度</p><h2>需要处理的不是“多”，而是“失去可用性”</h2><table><thead><tr><th>检查项</th><th>数量</th></tr></thead><tbody>{quality_html}</tbody></table><p class='note'>不同章节锚点不视为重复。重定向、标题变化、登录限制和超时均只作为复核信号，不会自动删除。</p></section>
</main></body></html>"""


def ai_brief_markdown(audit: dict[str, Any]) -> str:
    overview = audit["collection_overview"]
    lines = ["# 收藏夹 AI 语义画像简报", "", "只根据下面的书签证据作出结论；不要推断敏感个人属性。", "", "## 确定事实", ""]
    for key, value in audit["stats"].items():
        lines.append(f"- {key}: {value}")
    lines.extend(["", "## 现有目录样本", ""])
    for theme, samples in overview["folder_samples"].items():
        lines.append(f"### {theme}")
        for item in samples:
            lines.append(f"- {item['title']} ｜ {' / '.join(item['path'])} ｜ {item['url']}")
        lines.append("")
    lines.extend(["## 输出要求", "", "不要沿用任何预设主题。先从当前收藏夹的目录、标题、来源与样本中归纳最能解释这位用户的 4 至 8 个主题；尊重已有稳定目录，必要时提出更好的分类方案。生成 JSON 对象，字段为：headline、summary、taxonomy（name、definition、evidence）、focus_areas（name、interpretation、evidence）、information_habits（字符串数组）、next_actions（priority、action、evidence）。每项都应能回溯到上述书签证据。"])
    return "\n".join(lines)


def load_ai_insights(path: Path | None) -> dict[str, Any]:
    if not path:
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Cannot read AI insights: {error}") from error
    if not isinstance(payload, dict):
        raise ValueError("AI insights must be a JSON object.")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit browser bookmarks and create an HTML profile.")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--format", choices=("auto", "chromium", "html"), default="auto")
    parser.add_argument("--check-links", action="store_true")
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--ai-insights", type=Path, help="Optional evidence-based AI interpretation JSON.")
    args = parser.parse_args()

    items, detected_format = load_items(args.input, args.format)
    for item in items:
        item["normalized_url"] = normalized_url(item["url"])
        item["exact_url"] = normalized_url(item["url"], keep_fragment=True)
    folders = {tuple(item["path"]) for item in items if item["path"]}
    folder_count = len(folders)
    domains = Counter((urlsplit(item["url"]).hostname or "(无域名)").lower() for item in items)
    topics = Counter((item["path"][1] if len(item["path"]) > 1 else item["path"][0] if item["path"] else "未分类") for item in items)
    overview = collection_overview(items, domains)
    links: dict[str, dict[str, Any]] = {}
    if args.check_links:
        unique_urls = sorted({item["normalized_url"]: item["url"] for item in items}.items())
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
            futures = {executor.submit(check_one, url, args.timeout): key for key, url in unique_urls}
            for future in concurrent.futures.as_completed(futures):
                key = futures[future]
                try:
                    links[key] = future.result()
                except Exception as error:  # defensive: all input URLs must remain reportable
                    links[key] = {"status": "unverified", "http_status": None, "final_url": None, "page_title": None, "error": str(error)[:180]}
        for item in items:
            item["link"] = links.get(item["normalized_url"])

    exact_duplicates = duplicate_groups(items, "exact_url")
    related_url_groups = [
        group for group in duplicate_groups(items, "normalized_url")
        if len({normalized_url(item["url"], keep_fragment=True) for item in group["bookmarks"]}) > 1
    ]
    audit = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": str(args.input),
        "format": detected_format,
        "stats": {"bookmark_count": len(items), "folder_count": folder_count, "duplicate_group_count": len(exact_duplicates), "related_url_group_count": len(related_url_groups)},
        "profile": {"top_folders": dict(topics.most_common()), "top_domains": dict(domains.most_common())},
        "collection_overview": overview,
        "ai_insights": load_ai_insights(args.ai_insights),
        "duplicates": exact_duplicates,
        "related_url_groups": related_url_groups,
        "link_results": links,
        "bookmarks": items,
        "changes": compare_baseline(items, args.baseline),
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
    (args.output_dir / "bookmark-profile.html").write_text(profile_html(audit), encoding="utf-8")
    (args.output_dir / "ai-profile-brief.md").write_text(ai_brief_markdown(audit), encoding="utf-8")
    print(json.dumps({"bookmarks": len(items), "folders": folder_count, "duplicate_groups": len(audit["duplicates"]), "output": str(args.output_dir)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

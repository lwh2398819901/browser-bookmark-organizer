---
name: bookmark-organizer
description: 审计、生成画像、去重并按内容语义整理浏览器收藏夹；适用于首次全量整理或定期处理“临时收藏”。
---

# 收藏夹整理

优先使用命令完成可验证的工作。打开网页或提出移动建议前，先运行确定性审计；将 URL、目录路径、重定向目标、HTTP 状态和标题变化作为证据。仅在语义分类、保留判断和结果模糊时使用 AI。

## 选择运行模式

具体中文触发词与授权边界见[触发词与授权边界](references/triggers.md)。

- 首次整理：审计整个收藏夹，先生成可复核的重组建议，再考虑移动或删除。阅读[首次整理](references/modes.md#first-time-cleanup)。
- 日常整理：仅处理 `临时收藏`，与全库 URL 比较后，通过浏览器收藏夹 API 移动。阅读[临时收藏归档](references/modes.md#recurring-temporary-folder)。
- 收藏夹画像：从审计数据生成 HTML 画像。需要深度画像时，阅读生成的 `ai-profile-brief.md`，创建有证据的 `ai-insights.json`，再使用 `--ai-insights` 运行。阅读[画像与变化检测](references/modes.md#profile-and-change-detection)。

## 审计命令

对 Chromium 的 `Bookmarks` 文件或 Netscape/Edge HTML 导出使用 `scripts/audit_bookmarks.py`。它会向输出目录写入 `audit.json` 和 `bookmark-profile.html`。

```text
python scripts/audit_bookmarks.py --input <Bookmarks-or-export.html> --output-dir <report-directory>
```

仅在用户要求可用性检查时使用 `--check-links`。检查重定向、标题和可用性变化时使用 `--baseline <previous-audit.json>`。401、403、429 或超时不能判定为失效链接，只能报告为“无法确认”。

## AI 语义画像

审计始终会写入 `ai-profile-brief.md`，其中包含受控范围的事实和代表书签。用户要求深度画像时，使用当前模型将有证据支撑的结论整理成 `ai-insights.json`，再重新生成报告：

```text
python scripts/audit_bookmarks.py --input <source> --output-dir <report-directory> --ai-insights <ai-insights.json>
```

包含知识主题、可观察的信息习惯和具体维护动作。不得推断敏感特质、编造证据，或把 AI 解读表述为确定事实；仅在证据简报无法解决重要语义问题时阅读单个网页。

## 改动规则

- Edge 运行时不得编辑 Chromium 正在使用的 `Bookmarks` 文件。实时批量移动使用已安装本地扩展的 `chrome.bookmarks` API；离线整理则生成新的 HTML 导入文件。
- 保持源导出文件不变。离线重组写入新的同级输出文件。
- 仅在用户已授权删除时，才可自动移除精确重复 URL。近似重复、重定向或不可用链接都必须先给出可复核清单并获得明确决定。
- 批量移动前重新扫描临时文件夹，展示每条目标路径并校验全部 ID；应用计划后验证临时文件夹已清空。

# Browser Bookmark Organizer

This repository contains a local-first bookmark workflow. For any request about browser bookmarks, read `.agents/skills/bookmark-organizer/SKILL.md` before acting.

## Operating boundary

- Run the deterministic audit before opening pages or proposing changes.
- Never edit a live Chromium `Bookmarks` file while its browser is running.
- Preserve the user's export and browser data. Generated reports belong in a user-chosen output folder and must not be committed.
- A request to “organize bookmarks” means audit and propose by default. Moving or deleting requires an explicit approved plan.
- Treat timeouts, 401, 403, 429, and login pages as unverified—not dead links.
- The Edge extension under `extension/edge-bookmark-organizer` may apply a reviewed move plan through `chrome.bookmarks`; it does not delete bookmarks.

## Intent routing

| User wording | Workflow |
|---|---|
| 整理收藏夹 / 首次整理 / 全量审计 | First-time audit and reviewable proposal |
| 整理临时收藏夹 / 归档临时收藏 | Inbox triage, exact deduplication, move plan |
| 检查重复收藏 / 收藏夹去重 | Exact duplicate report; related fragments stay distinct |
| 检查失效链接 / 检查链接变化 | Opt-in availability and baseline comparison |
| 收藏夹画像 / 深度画像 | HTML profile; AI interpretation must be evidence-backed |
| 执行移动计划 / 应用归档计划 | Validate and apply an already approved plan |

Do not infer sensitive personal traits from bookmark content. Keep command-generated facts distinct from AI interpretation.

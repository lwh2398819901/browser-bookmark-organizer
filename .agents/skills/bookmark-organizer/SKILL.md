---
name: bookmark-organizer
description: 快速收藏、防重复、备份恢复、审计、生成画像并按内容语义整理浏览器收藏夹；适用于日常收集、单独备份、首次全量整理或定期处理“临时收藏”。
---

# 收藏夹整理

先选择足以完成任务的最低成本可靠数据源。日常处理 `临时收藏`、备份、查看归档和撤销时，优先调用 `scripts/bookmarkctl.py` 与配套扩展通信，不操作插件页面、不解析浏览器数据文件，也不编写一次性脚本。首次全量整理、画像和链接健康检查才运行审计脚本。先完成 URL、目录、ID、重定向和状态等确定性判断，仅在语义分类、保留判断和结果模糊时使用 AI。

默认采用低打扰交互：不主动打开整理中心，不使用浏览器原生 `alert`、`confirm` 或 `prompt`，成功结果在当前界面或 Agent 回复中简短报告。用户点击指向明确对象的“删除备份”“撤销本次整理”“清空记录”等按钮即可视为该动作授权，不再二次弹窗。只有批量移动、删除书签、替换整个收藏夹等范围较大的改动，才需要在执行前展示范围并获得一次明确确认。

## 选择运行模式

具体中文触发词与授权边界见[触发词与授权边界](references/triggers.md)。

- 仅备份：将当前完整收藏夹导出为可重新导入的 HTML，不审计、不移动、不删除或修改书签。阅读[运行模式详解](references/modes.md)。
- 快速收藏：通过扩展工具栏把当前 HTTP(S) 网页加入 `临时收藏`；若全库已有相同规范化网址，只报告原位置，不创建副本。
- 恢复与撤销：插件执行过的移动优先从“操作记录”撤销；HTML 深度恢复使用浏览器原生导入。阅读[运行模式详解](references/modes.md)。
- 首次整理：审计整个收藏夹，先生成可复核的重组建议，再考虑移动或删除。阅读[运行模式详解](references/modes.md)。
- 日常整理：仅处理 `临时收藏`，优先使用扩展的轻量扫描、全库重复结果和现有目录；不默认启动全量审计。阅读[运行模式详解](references/modes.md)。
- 收藏夹画像：从审计数据生成 HTML 画像。需要深度画像时，阅读生成的 `ai-profile-brief.md`，创建有证据的 `ai-insights.json`，再使用 `--ai-insights` 运行。阅读[运行模式详解](references/modes.md)。

## 日常整理最短路径

直接调用本技能的本地命令，不要求用户打开整理中心、扫描、复制或粘贴：

```text
python scripts/bookmarkctl.py --pretty scan
```

命令返回实时 ID、全库精确重复路径和已有目录。根据这些数据生成 `[{"id":"...","folderPath":"..."}]`；只阅读标题和 URL 不足以判断的网页。目标路径必须以收藏夹栏开头（例如 `收藏夹栏/开发/Git`），扩展不会移动或创建收藏夹栏之外的位置。把方案写入临时 JSON 数据文件后校验：

```text
python scripts/bookmarkctl.py --pretty validate-plan --file <plan.json>
```

向用户展示返回的逐条预览。得到对当前预览的明确确认后，使用返回的短时 `planToken` 执行：

```text
python scripts/bookmarkctl.py --pretty apply-plan --plan-token <token> --confirmed
```

一次正常的日常整理只调用三次扩展：`scan → validate-plan → apply-plan`。`apply-plan` 内部会先创建完整 HTML 归档，Agent 不得在它之前额外调用 `backup`；否则同一次整理会产生重复备份。`status` 只用于桥接失败后的诊断，`archives` 和 `operations` 只在用户明确查询或需要核对不确定结果时调用，不得作为每次整理的固定步骤。若命令结果丢失或超时，先用 `scan`、`archives` 或 `operations` 核对实际状态，再决定是否重试，禁止盲目重复调用写入命令。

实时 ID 只能原样取自 `bookmarkctl scan`。不得从 Chromium `Bookmarks`、HTML 导出或自行编写的解析脚本中提取、猜测或生成执行 ID。`bookmarkctl` 已支持的动作不得另写脚本重复实现；确有通用能力缺口时报告缺口并扩展正式工具，不在单次任务中造临时工具。插件页面只作为人工备用入口。

若桥接命令失败，先运行 `status` 并根据错误检查安装、浏览器和扩展是否已重新加载；不得立即回退到视觉点击。只有用户明确要求使用页面，或本地桥接确实不可恢复时，才使用人工界面流程。

## 全量审计命令

对 Chromium 的 `Bookmarks` 文件或 Netscape/Edge HTML 导出使用 `scripts/audit_bookmarks.py`。它会向输出目录写入 `audit.json` 和 `bookmark-profile.html`。

```text
python scripts/audit_bookmarks.py --input <Bookmarks-or-export.html> --output-dir <report-directory>
```

仅在用户要求可用性检查时使用 `--check-links`。检查重定向、标题和可用性变化时使用 `--baseline <previous-audit.json>`。401、403、429 或超时不能判定为失效链接，只能报告为“无法确认”。

`--baseline` 会自动启用当前链接检查，避免产生“零变化”的静默假象。大量检查可按需调整 `--timeout`、`--workers`、`--per-domain-delay` 和 `--retries`。`audit.json` 与 `ai-profile-brief.md` 已包含目录分布、精确重复和目录样本，优先复用这些结果，不再写一次性脚本重复提取。HTML 导出不包含可信的浏览器运行时 ID，只用于审计、画像和离线重组。

## AI 语义画像

审计始终会写入 `ai-profile-brief.md`，其中包含受控范围的事实和代表书签。命令不会预设用户的主题分类；用户要求深度画像或语义归档时，使用当前 AI 大模型从该用户数据中动态归纳主题，再整理成 `ai-insights.json` 或可复核的移动计划。阅读[动态分类](references/dynamic-classification.md)。

```text
python scripts/audit_bookmarks.py --input <source> --output-dir <report-directory> --ai-insights <ai-insights.json>
```

包含知识主题、可观察的信息习惯和具体维护动作。不得推断敏感特质、编造证据，或把 AI 解读表述为确定事实；仅在证据简报无法解决重要语义问题时阅读单个网页。

## 改动规则

- 用户只要求备份、归档或导出收藏夹时，进入“仅备份”模式并调用 `python scripts/bookmarkctl.py --pretty backup`，不附带整理、去重、链接检查或移动。成功后报告文件路径，并明确说明没有修改收藏夹。桥接不可用时才使用插件页面或浏览器原生“导出收藏夹/书签”；不得通过构造空移动计划冒充备份。
- 浏览器（例如 Edge）运行期间，不得直接编辑其正在使用的 Chromium `Bookmarks` 文件。实时批量移动只能使用本技能配套的本地扩展 **`收藏夹整理助手（本地）`** 的 `chrome.bookmarks` API；不得把任何名称相近或功能相似的第三方扩展当作执行器。执行器的位置、版本和校验方式见[本地执行扩展](references/local-extension.md)；离线整理则生成新的 HTML 导入文件。
- 通过扩展执行任何移动前，必须由 `apply-plan` 内部创建完整收藏夹 HTML 归档并等待成功；归档失败时停止改动，Agent 不得另行提前备份。扩展归档保留最近 30 份，自动清理只针对它自己创建的最早归档；用户点击某一项的“删除备份”即视为对该文件的明确指定，插件会直接删除该备份文件，不再二次弹窗，也不会修改收藏夹。
- 用户要求撤销插件刚执行的整理时，优先使用整理中心的操作记录；撤销前再次备份，并只恢复记录中的原父目录、位置和顺序。用户要求从 HTML 归档恢复时，说明浏览器导入通常会与当前收藏夹合并，不得自动清空当前收藏夹。
- 保持源导出文件不变。离线重组写入新的同级输出文件。
- 删除必须获得用户对明确对象或已展示清单的授权。当前扩展不执行书签删除；实时整理只能报告精确重复并说明需由用户使用浏览器原生操作。离线重组时可以在明确授权后从新 HTML 中剔除精确重复项，但必须保留源导出文件。近似重复、重定向或不可用链接都必须先给出可复核清单并获得明确决定。
- 批量移动前由 `bookmarkctl validate-plan` 重新扫描临时文件夹并校验全部 ID；以它返回的预览为准。`planToken` 只对应本次短时方案，收藏夹状态变化或令牌过期时必须重新校验。应用计划后验证计划内条目已离开临时文件夹。

# Browser Bookmark Organizer

一个本地优先的浏览器收藏夹整理工具包：AI Agent 通过统一的 `bookmarkctl` 命令与 Chromium 扩展通信，自动取得实时收藏夹、生成方案并安全执行；插件页面保留为人工备用控制台。

不会上传收藏夹内容，也不在代码中存储任何模型 API 密钥。启用链接检查时，脚本会访问被检查的网址。

## 当前范围

当前 2.0.5 只实现本地使用方案：本机 Agent 加载技能，通过短时 localhost 桥接调用本地扩展。它不需要长期开放端口，不连接远端收藏夹服务，也不建设插件内置的云端 Agent。

2.0.5 在原有移动闭环上增加软删除、回收站清空、空目录清理、目录重命名和目录移动。删除和目录变更都先给出预览；执行前自动归档，并可通过操作记录撤销。书签默认移入 `回收站`，只有显式 `--purge` 才永久删除。计划令牌有效期为 30 分钟。全库扫描仍覆盖全部根目录，变更仅支持收藏夹栏内条目。离线 HTML 重组尚未提供正式工具。

2.0.4 增加归档下载诊断（`downloads`）、超时取消、逐项操作记录和冲突撤销；CLI 与整理中心共用后台执行器。链接检查使用有读取上限的 GET，显示标题采集与比较覆盖率。

安装检查 `installer/doctor.ps1` 只证明文件与配置一致；加 `-RuntimeCheck` 核对浏览器已加载版本，加 `-ArchiveTest` 会实际创建备份。升级扩展后需要重新加载。协议、错误状态和恢复方式见 [本地 Agent 桥接](docs/local-agent-bridge.md)。

## 能做什么

- 首次全量整理：分析目录、重复、失效/变更链接，给出可复核的分类与清理建议。
- 日常整理 `临时收藏`：与全库精确去重，理解内容后归档到已有或新建目录。
- 生成 HTML 收藏夹画像：主题、内容类型、来源结构、质量指标，以及基于证据的 AI 深度解读。
- 链接健康检查：区分不可用和“无法确认”，支持用历史审计结果检测标题、重定向和状态变化。
- 独立备份：无需整理或移动，直接将当前完整收藏夹导出为可重新导入的 HTML，并保留最近 30 份。
- 快速收藏与防重复：从工具栏把当前网页加入 `临时收藏`；全库已有相同网址时显示原位置，不再创建副本。
- 备份与恢复中心：按日期展示最近备份，可定位文件、复制路径并查看安全恢复步骤。
- 可视化整理与撤销：把 Agent JSON 转换成逐条移动预览；执行前自动备份，并可通过本地操作记录撤销插件完成的移动。
- Chromium 安全批量移动：通过 `chrome.bookmarks` API 执行经过确认的移动计划；不自动删除、重命名或替换网址。
- 删除与目录维护：书签默认移入 `回收站`；空目录可清理；目录可重命名和移动。永久删除需要单独确认，执行前都会先归档。
- Agent 自动接管：实时扫描、备份、方案校验、移动、查看记录和撤销均可通过命令完成，无需复制粘贴或视觉点击插件页面。

## 快速安装（Windows + Edge）

前提：已安装 Git、Python 3.10+ 与 Microsoft Edge。

```powershell
git clone https://github.com/lwh2398819901/browser-bookmark-organizer.git
cd browser-bookmark-organizer
powershell -ExecutionPolicy Bypass -File .\installer\bootstrap.ps1 -Browser Edge -OpenExtensionsPage
```

脚本会：

1. 验证 Python、技能和扩展的文件完整性。
2. 将技能链接到 `~\.agents\skills\bookmark-organizer`；若无法创建链接则复制。
3. 将 Edge 扩展复制到 `D:\Microsoft-Edge\Local-Extensions\bookmark-organizer`；没有 D 盘时使用 `%LOCALAPPDATA%\BrowserLocalExtensions\Microsoft-Edge\bookmark-organizer`。传入 `-Browser Chrome` 或 `-Browser Brave` 时，对应目录名分别为 `Google-Chrome` 和 `Brave`。
4. 生成仅保存在本机的随机桥接令牌，并输出下一步的人为确认操作。
5. 可打开 `edge://extensions`。

### 唯一必须由人确认的步骤

在 Edge 的 `edge://extensions` 页面：

1. 开启“开发人员模式”。
2. 点击“加载解压缩的扩展”。
3. 选择脚本输出的 `bookmark-organizer` 扩展目录。

这是浏览器的安全边界，安装脚本不会绕过。更新到 2.0 后必须在扩展卡片点击一次“重新加载”；之后重启 Cursor、Codex 或其他支持 Agent Skills 的 Agent，它们会发现 `~\.agents\skills\bookmark-organizer`。

## Agent 自动操作

安装并重新加载扩展后，Agent 使用技能目录中的 `scripts/bookmarkctl.py`。命令执行时会短暂出现一个约 420×240 的桥接小窗口，完成后自动关闭；用户不需要在插件页面扫描、复制或粘贴。

```powershell
# 检查连接
python .\.agents\skills\bookmark-organizer\scripts\bookmarkctl.py --pretty status

# 实时读取“临时收藏”、已有目录和全库重复位置
python .\.agents\skills\bookmark-organizer\scripts\bookmarkctl.py --pretty scan

# 单独备份，不修改收藏夹
python .\.agents\skills\bookmark-organizer\scripts\bookmarkctl.py --pretty backup

# 校验 Agent 生成的移动方案，返回预览和 30 分钟有效的 planToken
python .\.agents\skills\bookmark-organizer\scripts\bookmarkctl.py --pretty validate-plan --file .\plan.json

# 用户确认预览后执行；扩展会先备份
python .\.agents\skills\bookmark-organizer\scripts\bookmarkctl.py --pretty apply-plan --plan-token <token> --confirmed
```

还支持 `folders`、`prune-folders`、`rename-folder`、`move-folder`、`purge-recycle`、`archives`、`operations` 和 `undo --operation-id <id> --confirmed`。目录命令不带 `--confirmed` 时只返回预览。所有输出均为 JSON，需要给人看的表格可加 `--markdown`。Claude Code、Codex、Cursor 或其他能运行本地命令的 Agent 不需要单独适配。插件页面仍可独立完成原有人工操作。

协议、安全边界与排障见[本地 Agent 桥接](docs/local-agent-bridge.md)。

## 跨平台安装

扩展与 Python 审计脚本支持 Windows、macOS 和 Linux。安装器会为技能优先创建软链接，无法创建时才复制；扩展会放到当前操作系统的稳定用户目录。

```bash
python installer/install.py --browser edge
# 也可使用 --browser chrome 或 --browser brave
```

更新已有副本时使用：

```bash
python installer/install.py --browser edge --update-extension --update-skill
```

更新扩展时，安装器会先在同一磁盘创建并校验完整临时副本，成功后再替换旧目录；失败时自动恢复旧版本。这样可以清除上一版本已经移除的文件，避免新旧文件混用。Windows 目录联接（junction）也会按目录链接识别，不会被误当成普通技能目录合并复制。

脚本结束后仍需用户在浏览器扩展页开启开发者模式并“加载已解压的扩展程序”。这是所有操作系统都保留的人机安全确认。不同 Agent 对共享技能目录的发现方式可能不同；本仓库默认安装到 `~/.agents/skills/bookmark-organizer`。

## 给 Agent 的常用说法

| 说法 | 默认结果 |
|---|---|
| `备份我的收藏夹` | 仅生成完整可导入 HTML，不修改收藏夹 |
| `整理收藏夹` | 全量审计和建议，不直接改动 |
| `整理临时收藏夹` | Agent 自动实时扫描并生成预览；你确认后自动备份和移动 |
| `检查重复收藏` | 输出精确重复；章节锚点不会被误删 |
| `检查失效链接` | 进行网络检查，输出待复核清单 |
| `生成收藏夹深度画像` | 输出 HTML 事实层与 AI 语义层 |
| `执行已确认的移动计划` | 通过本地命令让扩展应用计划；删除默认进入回收站 |
| `删掉这些空目录` | 先预览空目录，确认后删除并可撤销 |

详细触发词和授权边界见 [工作流说明](docs/workflows.md)。

## 手动使用

```powershell
python .\.agents\skills\bookmark-organizer\scripts\audit_bookmarks.py `
  --input "<Edge Bookmarks 文件或 HTML 导出>" `
  --output-dir ".\reports\first-audit"
```

加入 `--check-links` 才会检查链接。用 `--baseline <旧 audit.json>` 检查链接状态、标题和重定向变化。脚本还会生成 `ai-profile-brief.md`；Agent 据此写出可审查的 `ai-insights.json` 后，以 `--ai-insights` 再运行一次即可得到深度画像。

日常使用时，点击扩展图标即可把当前网页加入 `临时收藏`；如果全库已有相同网址，扩展只显示原位置。整理和备份默认由 Agent 通过 `bookmarkctl` 完成，不需要用户复制粘贴，也不使用视觉自动化。整理中心继续展示临时收藏、备份列表、可视化方案与操作记录，供不使用 Agent 时手动操作或排障。任何情况下都不能改从离线文件获取实时 ID。扩展接收的计划示例见 [sample-move-plan.json](examples/sample-move-plan.json)。

备份会将完整收藏夹导出为带根目录和时间属性的可导入 HTML，写入浏览器下载目录下的 `Bookmark-Organizer-Archives`。移动和撤销都会先等待备份成功；自动按下载时间保留严格命名且仍存在的最近 30 份，已经在磁盘删除或移动的文件不会继续显示。工具栏备份由后台直接完成，不再打开整理中心。用户点击明确的“删除备份”“撤销本次整理”或“清空记录”按钮后直接执行，并在页面内显示结果，不再弹出浏览器确认框；删除备份只影响指定文件，清空记录不影响收藏夹和备份文件。

如需从 HTML 深度恢复，在整理中心选择备份并按“恢复方法”操作。浏览器没有向扩展开放原生 HTML 导入接口，导入通常会与现有收藏夹合并，因此扩展不会自动清空或覆盖当前收藏夹。归档位置跟随浏览器当前的下载目录；若希望放在其他磁盘，请先在浏览器设置中修改下载位置。

## 维护与排障

```powershell
.\installer\doctor.ps1 -Browser Edge
# 使用 Chrome 时：.\installer\doctor.ps1 -Browser Chrome
# 使用 Brave 时：.\installer\doctor.ps1 -Browser Brave
```

自检会核验扩展名称、Manifest V3、最低版本 `2.0.1`、固定扩展 ID、localhost 来源、本地桥接后台，以及 CLI 与扩展两侧令牌是否一致；同时检查 `bookmarks`、`downloads`、`activeTab`、`storage` 四项必要权限。自检不会输出令牌。

开发改动可运行回归测试：

```powershell
python -m unittest discover -s .\tests -p "test_*.py"
node .\tests\test_manager.js
```

- 更新仓库后，如需覆盖扩展源码，显式运行 `bootstrap.ps1 -Browser Edge -UpdateExtension`；如需覆盖按副本安装的技能，再加上 `-UpdateSkill`。两者都会先在同盘生成完整临时副本校验通过后再整体替换，然后请在 Edge 扩展页点击“重新加载”。
- 如果全局技能已存在，安装脚本不会覆盖它；这是为了保护你本机的定制。可以先比较差异后再手动迁移。
- 不要将真实 `Bookmarks`、HTML 导出、审计结果或深度画像提交到 Git；`.gitignore` 已覆盖常见情况。

## 开源许可

本项目采用 [MIT License](LICENSE)。欢迎 fork、修改、重新发布和商用，无需事先申请或通知作者；再分发时请保留许可证和版权声明。

## 目录说明

- `.agents/skills/bookmark-organizer/`：跨 Agent 共用的技能、脚本与规范。
- `extension/edge-bookmark-organizer/`：Edge、Chrome、Brave 等 Chromium 浏览器的解压缩扩展源码。
- `installer/`：安装、自检与维护脚本。
- `docs/`：流程、隐私和浏览器扩展说明。

## 未来方向

如果未来面向没有本机 Agent 的普通用户，可以考虑让插件连接统一的远端 Agent 与技能服务。该方向的适用条件、候选架构、数据边界和安全前提见 [未来方向：可选的远端智能服务](docs/future-remote-service.md)。它目前只是设计记录，不代表已有功能或近期实现承诺。

## 安全与隐私

默认仅在本机读取书签。链接检查会向目标站点发出请求；AI 语义分析应仅基于本地审计简报，除非用户明确要求阅读外部网页。更多内容见 [隐私与安全](docs/privacy-and-security.md)。

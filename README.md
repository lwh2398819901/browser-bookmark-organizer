# Browser Bookmark Organizer

一个本地优先的浏览器收藏夹整理工具包：AI Agent 通过统一的 `bookmarkctl` 命令与 Chromium 扩展通信，自动取得实时收藏夹、生成方案并安全执行；插件页面保留为人工备用控制台。

不会上传收藏夹内容，也不在代码中存储任何模型 API 密钥。启用链接检查时，脚本会访问被检查的网址。

## 当前范围

当前 2.0.11 只在本机工作：Agent 经短时 localhost 桥接调用扩展，不长期监听、不连远端，插件里也没有云端 Agent。

助手删除默认进 `回收站`，只有 `--purge` 才永久删除；`purge-recycle --older-than-days` 按进入回收站的时间算，没有记录的条目会跳过。工具栏「取消收藏」按规范化网址直接删除当前页的全部匹配，不进回收站，也不能撤销。删除候选进已有或新建的 `待删除`。空目录可用 `--path` 和重复的 `--exclude` 限定，`临时收藏` 与 `回收站` 不会被全局清理删掉。备份可按天数（默认 7 天，0 表示全部）或日期段预览后删除，不改收藏夹。计划令牌 30 分钟；全库可扫描，变更只在收藏夹栏内。链接检查用有上限的 GET。命令超时先查状态，不要立刻重试。离线 HTML 重组尚无正式工具。

安装检查 `installer/doctor.ps1` 只证明文件与配置一致；加 `-RuntimeCheck` 核对浏览器已加载版本，加 `-ArchiveTest` 会实际创建备份。升级扩展后需要重新加载。协议、错误状态和恢复方式见 [本地 Agent 桥接](docs/local-agent-bridge.md)。

## 能做什么

- 首次全量整理：分析目录、重复、失效/变更链接，给出可复核的分类与清理建议。
- 日常整理 `临时收藏`：与全库精确去重，理解内容后归档到已有或新建目录。
- 生成 HTML 收藏夹画像：主题、内容类型、来源结构、质量指标，以及基于证据的 AI 深度解读。
- 链接健康检查：区分不可用和“无法确认”，支持用历史审计结果检测标题、重定向和状态变化。
- 独立备份：无需整理或移动，直接将当前完整收藏夹导出为可重新导入的 HTML，并保留最近 30 份。
- 快速收藏：工具栏把当前页加入 `临时收藏`；已有相同规范化网址时显示原位置，按钮变为「取消收藏」。
- 整理中心：按日期看最近备份、定位文件、查看恢复步骤，也可把 Agent JSON 做成逐条预览，并用操作记录撤销已完成的移动。
- 批量变更：移动、软删除、目录重命名和目录移动都要确认后才执行，不改书签网址。
- 命令接管：扫描、备份、校验、移动、清目录、清备份、看记录和撤销都走命令，不用在插件页复制粘贴。

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

脚本不会替你在浏览器里加载扩展；更新扩展后还要点一次“重新加载”。技能默认在 `~\.agents\skills\bookmark-organizer`，不同 Agent 不一定能发现它；打开本仓库时可直接读 `.agents/skills/bookmark-organizer`。

## Agent 自动操作

安装并重新加载扩展后，Agent 用技能里的 `scripts/bookmarkctl.py`；每次命令会短暂打开约 420×240 的桥接窗口，完成后自动关闭，不用在插件页复制粘贴。

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

还支持 `folders`、`prune-folders`、`rename-folder`、`move-folder`、`purge-recycle`、`purge-archives`、`archives`、`downloads`、`operations` 和 `undo --operation-id <id> --confirmed`。会改收藏夹或备份的命令，不带 `--confirmed` 只返回预览。输出是 JSON，给人看可加 `--markdown`。能跑本地命令的 Agent 不用单独适配；只装 Agent、不打开本仓库也不跑安装脚本，不会因此得到技能和扩展。插件页仍可手工操作。

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

更新扩展时，安装器先在同盘写好并校验临时副本，再整体替换；失败会恢复旧版，并按目录链接识别 Windows junction，避免新旧文件混在一起。加载扩展仍须人工确认，技能默认在 `~/.agents/skills/bookmark-organizer`。

## 给 Agent 的常用说法

| 说法 | 默认结果 |
|---|---|
| `备份我的收藏夹` | 仅生成完整可导入 HTML，不修改收藏夹 |
| `整理收藏夹` | 全量审计和建议，不直接改动 |
| `整理临时收藏夹` | Agent 自动实时扫描并生成预览；你确认后自动备份和移动 |
| `检查重复收藏` | 输出精确重复；章节锚点不会被误删 |
| `检查失效链接` | 进行网络检查，输出待复核清单 |
| `生成收藏夹深度画像` | 输出 HTML 事实层与 AI 语义层 |
| `执行已确认的移动计划` | 通过本地命令让扩展应用明确范围内的移动 |
| `这些可以删` | 移入 `待删除`，由你手工删除 |
| `删完了` | 检查 `待删除`：有剩余则放回合适位置，已空则删除该文件夹 |
| `删掉这些空目录` | 先预览空目录，确认后删除并可撤销；可用路径和排除参数限定范围 |
| `清掉 7 天前的备份` | 先列出将删除的备份文件，确认后删除；不改收藏夹 |

详细触发词和授权边界见 [工作流说明](docs/workflows.md)。

## 手动使用

```powershell
python .\.agents\skills\bookmark-organizer\scripts\audit_bookmarks.py `
  --input "<Edge Bookmarks 文件或 HTML 导出>" `
  --output-dir ".\reports\first-audit"
```

加入 `--check-links` 才会检查链接。用 `--baseline <旧 audit.json>` 检查链接状态、标题和重定向变化。脚本还会生成 `ai-profile-brief.md`；Agent 据此写出可审查的 `ai-insights.json` 后，以 `--ai-insights` 再运行一次即可得到深度画像。

点扩展图标把当前页加入 `临时收藏`；已有相同规范化网址时，按钮变为「取消收藏」，并说明同站有多少条、大多在哪个目录。整理和备份默认走 `bookmarkctl`，实时 ID 只能来自扩展扫描。计划示例见 [sample-move-plan.json](examples/sample-move-plan.json)。整理中心供手工操作和排障。

备份是可导入的 HTML，写在下载目录的 `Bookmark-Organizer-Archives`；移动和撤销前都会先归档成功，并只保留最近 30 份仍在磁盘上的严格命名文件。工具栏备份在后台完成。「删除备份」「清空 N 天前的备份」「清空该时段的备份」只删这些文件，「清空记录」只删操作历史，都不改收藏夹；点一下即执行，不再弹窗。`purge-archives` 不带 `--confirmed` 只返回清单。

HTML 恢复用浏览器自己的导入，通常与现有收藏合并，扩展不会清空或覆盖当前收藏夹。备份跟着浏览器的下载目录走。

## 维护与排障

```powershell
.\installer\doctor.ps1 -Browser Edge
# 使用 Chrome 时：.\installer\doctor.ps1 -Browser Chrome
# 使用 Brave 时：.\installer\doctor.ps1 -Browser Brave
```

自检核对名称、Manifest V3、版本不低于 `2.0.1`、固定扩展 ID、localhost 来源、桥接后台、四项权限，以及两侧令牌是否一致，但不显示令牌。

开发改动可运行回归测试：

```powershell
python -m unittest discover -s .\tests -p "test_*.py"
node .\tests\test_manager.js
```

- 覆盖已安装的扩展或技能副本时，分别加 `-UpdateExtension`、`-UpdateSkill`；替换前会先校验同盘临时副本，然后重新加载扩展。已有技能目录默认不覆盖。
- 不要把真实 `Bookmarks`、HTML 导出、审计或画像提交到 Git。

## 开源许可

本项目采用 [MIT License](LICENSE)：可以 fork、修改、再发布和商用；再分发时保留许可证和版权声明。

## 目录说明

- `.agents/skills/bookmark-organizer/`：跨 Agent 共用的技能、脚本与规范。
- `extension/edge-bookmark-organizer/`：Edge、Chrome、Brave 等 Chromium 浏览器的解压缩扩展源码。
- `installer/`：安装、自检与维护脚本。
- `docs/`：流程、隐私和浏览器扩展说明。

## 未来方向

远端服务只是候选设计，见 [未来方向：可选的远端智能服务](docs/future-remote-service.md)，不是现有功能。

## 安全与隐私

默认只在本机读书签；链接检查会访问目标网址，AI 解读应以本地审计简报为准。详见 [隐私与安全](docs/privacy-and-security.md)。

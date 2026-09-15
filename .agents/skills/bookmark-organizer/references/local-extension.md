# 本地执行扩展

实时操作浏览器收藏夹时，唯一配套执行器是名称为 **`收藏夹整理助手（本地）`** 的解压缩 Chromium 扩展。它支持 Windows、macOS 与 Linux 上的 Edge、Chrome、Brave 等 Chromium 浏览器。不要使用或调用名称相近的第三方扩展（例如“懒猫书签清理”）；它们不属于本技能，权限、计划格式和备份保障均不可假定。

## 使用前校验

优先运行仓库的 `installer/doctor.ps1`：Edge 使用 `-Browser Edge`，Chrome 使用 `-Browser Chrome`。该脚本会检查 `manifest.json` 是否同时满足：

- `name` 为 `收藏夹整理助手（本地）`；
- `manifest_version` 为 `3`；
- 版本不低于 `1.0.2`；
- `permissions` 同时包含 `bookmarks`、`downloads`、`activeTab` 与 `storage`。

有 D 盘时，默认位置分别是 `D:\Microsoft-Edge\Local-Extensions\bookmark-organizer` 和 `D:\Google-Chrome\Local-Extensions\bookmark-organizer`。没有 D 盘时，分别使用 `%LOCALAPPDATA%\BrowserLocalExtensions\Microsoft-Edge\bookmark-organizer` 和 `%LOCALAPPDATA%\BrowserLocalExtensions\Google-Chrome\bookmark-organizer`。不要依据扩展 ID 判断身份：解压缩扩展移动目录后 ID 可能变化，应以清单内容校验。

macOS、Linux 或 Brave 优先运行仓库的 `python installer/install.py --browser <edge|chrome|brave>`。Windows 也可以使用该跨平台安装器；原有 PowerShell 安装器继续可用。安装脚本不能代替用户在浏览器扩展页完成“加载已解压的扩展程序”的确认。

## 执行边界

- 工具栏小窗口用于把当前网页加入 `临时收藏`、阻止全库精确重复、备份和打开整理中心。不同 URL 片段代表不同章节，不得作为精确重复阻止。
- 用户只要求备份时，点击工具栏小窗口的“立即备份”（它会打开整理中心并自动开始备份），或整理中心的“一键备份收藏夹”。两者都会创建完整、可重新导入的 HTML，报告路径、生成时间与条目数量，不扫描临时收藏、不移动或修改任何书签。
- 整理中心按日期展示最近 30 份备份，并可显示文件、复制路径或查看恢复方法。浏览器没有供扩展调用的原生 HTML 导入接口；不得把恢复方法按钮描述成自动恢复。
- 备份列表中的每一份都可以单独“删除备份”。它会删除该备份文件本身、不影响收藏夹，且需要用户在浏览器中二次确认；不得代替用户确认，也不得把它当作清理收藏夹的方式。
- 归属明显且便于逐条复核的临时收藏，可以在整理中心勾选并指定目录，无需运行全量审计。条目较多或需要语义判断时使用“复制整理任务给 Agent”；其中的 ID 是实时计划的唯一来源，Agent 只能原样回传，不能从离线文件重新提取。用户可把 Agent 的整段回复粘贴到“使用 Agent 自动分类”，扩展会提取其中的 JSON 方案；必须先查看逐条移动预览，再点击“备份并执行整理”。
- 它会先生成包含根目录语义和时间属性的完整 HTML 归档，归档成功后才移动。归档清理依据专属目录与严格文件名前缀，不依赖会随解压缩目录变化的扩展 ID；只保留最近 30 份。
- 每次插件整理在本地保存原目录与位置，最近 20 次显示在操作记录中。撤销前再次备份，只把书签移回原位置与原有顺序，不删除整理过程中创建的空目录。
- 操作记录的“清空记录”只删除插件本地保存的这些记录，不动收藏夹、也不删除任何备份文件；清空后无法再通过记录撤销，需由用户确认后执行。
- 当前版本不执行标题重命名、URL 替换、书签删除或目录删除；这些动作必须另行生成经过支持和复核的执行计划。

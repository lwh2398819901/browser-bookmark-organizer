# 本地执行扩展

实时操作浏览器收藏夹时，唯一配套执行器是名称为 **`收藏夹整理助手（本地）`** 的解压缩 Chromium 扩展。它支持 Windows、macOS 与 Linux 上的 Edge、Chrome、Brave 等 Chromium 浏览器。不要使用或调用名称相近的第三方扩展（例如“懒猫书签清理”）；它们不属于本技能，权限、计划格式和备份保障均不可假定。

## 使用前校验

优先运行仓库的 `installer/doctor.ps1`：Edge 使用 `-Browser Edge`，Chrome 使用 `-Browser Chrome`。该脚本会检查 `manifest.json` 是否同时满足：

- `name` 为 `收藏夹整理助手（本地）`；
- `manifest_version` 为 `3`；
- 版本不低于 `2.0.1`；
- `permissions` 同时包含 `bookmarks`、`downloads`、`activeTab` 与 `storage`。
- `background.service_worker` 为 `bridge.js`，并包含固定 ID 公钥和仅限 localhost 的外部消息来源。

有 D 盘时，默认位置分别是 `D:\Microsoft-Edge\Local-Extensions\bookmark-organizer` 和 `D:\Google-Chrome\Local-Extensions\bookmark-organizer`。没有 D 盘时，分别使用 `%LOCALAPPDATA%\BrowserLocalExtensions\Microsoft-Edge\bookmark-organizer` 和 `%LOCALAPPDATA%\BrowserLocalExtensions\Google-Chrome\bookmark-organizer`。2.0 使用公开 manifest key 固定扩展 ID，并以清单内容和本地桥接配置共同校验身份。

macOS、Linux 或 Brave 优先运行仓库的 `python installer/install.py --browser <edge|chrome|brave>`。Windows 也可以使用该跨平台安装器；原有 PowerShell 安装器继续可用。安装脚本不能代替用户在浏览器扩展页完成“加载已解压的扩展程序”的确认。

## 执行边界

- Agent 默认通过 `scripts/bookmarkctl.py` 调用扩展。命令只在执行期间监听随机的 `127.0.0.1` 端口，启动默认最小化且完成即关闭的短时桥接窗口，并使用安装时生成的随机令牌验证；不接受局域网或公网连接。
- `scan`、`status`、`archives`、`operations` 是只读操作；`backup` 只创建文件。`apply-plan` 和 `undo` 会移动书签，必须在用户确认后带 `--confirmed` 调用。
- 插件页面是人工备用控制台，不再是 Agent 日常流程的交换界面。桥接不可用时先运行 `status`、检查 `~/.bookmark-organizer/bridge.json` 并重新加载扩展。

- 工具栏小窗口用于把当前网页加入 `临时收藏`、阻止全库精确重复、备份和打开整理中心。不同 URL 片段代表不同章节，不得作为精确重复阻止。
- 用户只要求备份时，点击工具栏小窗口的“立即备份”会由后台直接创建归档并自动收起小窗口，不再打开整理中心；整理中心的“一键备份收藏夹”继续在页面内显示详细结果。两者都创建完整、可重新导入的 HTML，不扫描临时收藏、不移动或修改任何书签。
- 整理中心按日期展示最近 30 份备份，并可显示文件、复制路径或查看恢复方法。浏览器没有供扩展调用的原生 HTML 导入接口；不得把恢复方法按钮描述成自动恢复。
- 备份列表中的每一份都可以单独“删除备份”。用户点击该按钮即明确指定了目标文件，插件会直接删除该备份且不再二次确认；它不影响收藏夹，也不得被当作清理收藏夹的方式。
- 整理中心仍支持人工勾选目录和粘贴 Agent JSON，但自动流程应使用 `scan → validate-plan → 用户确认 → apply-plan`，不要求复制粘贴或页面点击。`apply-plan` 已内置整理前备份，不得再单独调用 `backup`。
- 它会先生成包含根目录语义和时间属性的完整 HTML 归档，归档成功后才移动。归档清理依据专属目录与严格文件名前缀，不依赖会随解压缩目录变化的扩展 ID；只保留最近 30 份。
- 每次插件整理在本地保存原目录与位置，最近 20 次显示在操作记录中。撤销前再次备份，只把书签移回原位置与原有顺序，不删除整理过程中创建的空目录。
- 操作记录的“清空记录”只删除插件本地保存的这些记录，不动收藏夹、也不删除任何备份文件；用户点击该明确按钮后直接执行并显示页面内结果，不再弹出确认框。
- 当前版本不执行标题重命名、URL 替换、书签删除或目录删除。实时删除需求只能先给出可复核清单，再由用户使用浏览器原生操作；离线 HTML 重组则遵守技能中“保留源文件并取得明确删除授权”的边界。

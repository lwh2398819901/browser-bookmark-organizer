# 本地执行扩展

实时操作浏览器收藏夹时，唯一配套执行器是名称为 **`收藏夹整理助手（本地）`** 的解压缩 Edge/Chromium 扩展。不要使用或调用名称相近的第三方扩展（例如“懒猫书签清理”）；它们不属于本技能，权限、计划格式和归档保障均不可假定。

## 使用前校验

Edge 优先运行仓库的 `installer/doctor.ps1 -Browser Edge`；Chrome 使用 `installer/doctor.ps1 -Browser Chrome`。该脚本会检查 `manifest.json` 是否同时满足：

- `name` 为 `收藏夹整理助手（本地）`；
- `manifest_version` 为 `3`；
- 版本不低于 `0.3.0`；
- `permissions` 同时包含 `bookmarks` 与 `downloads`。

有 D 盘时，默认位置分别是 `D:\Microsoft-Edge\Local-Extensions\bookmark-organizer` 和 `D:\Google-Chrome\Local-Extensions\bookmark-organizer`。没有 D 盘时，分别使用 `%LOCALAPPDATA%\BrowserLocalExtensions\Microsoft-Edge\bookmark-organizer` 和 `%LOCALAPPDATA%\BrowserLocalExtensions\Google-Chrome\bookmark-organizer`。不要依据扩展 ID 判断身份：解压缩扩展移动目录后 ID 可能变化，应以清单内容校验。

## 执行边界

- 扩展只接受经确认的移动计划，浏览器中点击“先归档，再执行方案”才会改动收藏夹。
- 它会先生成包含根目录语义和时间属性的完整 HTML 归档，归档成功后才移动。归档清理依据专属目录与严格文件名前缀，不依赖会随解压缩目录变化的扩展 ID；只保留最近 30 份。
- 当前版本不执行标题重命名、URL 替换、书签删除或目录删除；这些动作必须另行生成经过支持和复核的执行计划。

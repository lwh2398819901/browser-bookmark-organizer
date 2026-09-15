# Browser Bookmark Organizer

一个本地优先的浏览器收藏夹整理工具包：AI Agent 负责审计、理解内容和生成计划；Edge 扩展负责在浏览器内批量移动已确认的收藏。

不会上传收藏夹内容，也不在代码中存储任何模型 API 密钥。启用链接检查时，脚本会访问被检查的网址。

## 当前范围

当前版本只实现本地使用方案：本机 Agent 加载技能并生成建议，本地扩展负责读取浏览器收藏夹、创建归档和执行已确认的移动计划。当前版本不连接远端收藏夹服务，也不建设插件内置的云端 Agent。

## 能做什么

- 首次全量整理：分析目录、重复、失效/变更链接，给出可复核的分类与清理建议。
- 日常整理 `临时收藏`：与全库精确去重，理解内容后归档到已有或新建目录。
- 生成 HTML 收藏夹画像：主题、内容类型、来源结构、质量指标，以及基于证据的 AI 深度解读。
- 链接健康检查：区分不可用和“无法确认”，支持用历史审计结果检测标题、重定向和状态变化。
- 独立备份：无需整理或移动，直接将当前完整收藏夹导出为可重新导入的 HTML，并保留最近 30 份。
- Edge 安全批量移动：通过本地扩展的 `chrome.bookmarks` API 执行经过确认的移动计划；每次移动前自动导出完整 HTML 归档，归档完成后才会改动收藏夹。

## 快速安装（Windows + Edge）

前提：已安装 Git、Python 3.10+ 与 Microsoft Edge。

```powershell
git clone <你的仓库地址> browser-bookmark-organizer
cd browser-bookmark-organizer
powershell -ExecutionPolicy Bypass -File .\installer\bootstrap.ps1 -Browser Edge -OpenExtensionsPage
```

脚本会：

1. 验证 Python、技能和扩展的文件完整性。
2. 将技能链接到 `~\.agents\skills\bookmark-organizer`；若无法创建链接则复制。
3. 将 Edge 扩展复制到 `D:\Microsoft-Edge\Local-Extensions\bookmark-organizer`；没有 D 盘时使用 `%LOCALAPPDATA%\BrowserLocalExtensions\Microsoft-Edge\bookmark-organizer`。传入 `-Browser Chrome` 时，对应目录名为 `Google-Chrome`。
4. 输出下一步的人为确认操作，并可打开 `edge://extensions`。

### 唯一必须由人确认的步骤

在 Edge 的 `edge://extensions` 页面：

1. 开启“开发人员模式”。
2. 点击“加载解压缩的扩展”。
3. 选择脚本输出的 `edge-bookmark-organizer` 目录。

这是浏览器的安全边界，安装脚本不会绕过。之后重启 Cursor、Codex 或其他支持 Agent Skills 的 Agent；它们会发现 `~\.agents\skills\bookmark-organizer`。

## 给 Agent 的常用说法

| 说法 | 默认结果 |
|---|---|
| `备份我的收藏夹` | 仅生成完整可导入 HTML，不修改收藏夹 |
| `整理收藏夹` | 全量审计和建议，不直接改动 |
| `整理临时收藏夹` | 审计临时文件夹、去重、生成移动计划 |
| `检查重复收藏` | 输出精确重复；章节锚点不会被误删 |
| `检查失效链接` | 进行网络检查，输出待复核清单 |
| `生成收藏夹深度画像` | 输出 HTML 事实层与 AI 语义层 |
| `执行已确认的移动计划` | 通过扩展应用计划；不会默认删除 |

详细触发词和授权边界见 [工作流说明](docs/workflows.md)。

## 手动使用

```powershell
python .\.agents\skills\bookmark-organizer\scripts\audit_bookmarks.py `
  --input "<Edge Bookmarks 文件或 HTML 导出>" `
  --output-dir ".\reports\first-audit"
```

加入 `--check-links` 才会检查链接。用 `--baseline <旧 audit.json>` 检查链接状态、标题和重定向变化。脚本还会生成 `ai-profile-brief.md`；Agent 据此写出可审查的 `ai-insights.json` 后，以 `--ai-insights` 再运行一次即可得到深度画像。

只需备份时，点击扩展中的“仅备份当前收藏夹”；它不会扫描、移动或修改书签。扩展接收的移动计划示例见 [sample-move-plan.json](examples/sample-move-plan.json)。整理时先“校验方案”，再点击“先归档，再执行方案”；校验后若修改文本，必须重新校验。两种方式都会将完整收藏夹导出为带根目录和时间属性的可导入 HTML，写入浏览器下载目录下的 `Bookmark-Organizer-Archives`。归档下载成功才会开始移动；自动按下载时间保留严格命名的最近 30 份，清理不依赖可能变化的扩展 ID。

如需回退，在浏览器的“导入收藏夹/书签”功能中选择该目录中的归档 HTML。归档位置跟随浏览器当前的下载目录；若希望放在其他磁盘，请先在浏览器设置中修改下载位置。

## 维护与排障

```powershell
.\installer\doctor.ps1 -Browser Edge
# 使用 Chrome 时：.\installer\doctor.ps1 -Browser Chrome
```

自检会核验扩展名称、Manifest V3、最低版本 `0.4.0`，以及 `bookmarks`、`downloads` 两项必要权限。

开发改动可运行回归测试：

```powershell
python -m unittest discover -s .\tests -p "test_*.py"
node .\tests\test_manager.js
```

- 更新仓库后，如需覆盖扩展源码，显式运行 `bootstrap.ps1 -Browser Edge -UpdateExtension`，然后在 Edge 扩展页点击“重新加载”。
- 如果全局技能已存在，安装脚本不会覆盖它；这是为了保护你本机的定制。可以先比较差异后再手动迁移。
- 不要将真实 `Bookmarks`、HTML 导出、审计结果或深度画像提交到 Git；`.gitignore` 已覆盖常见情况。

## 目录说明

- `.agents/skills/bookmark-organizer/`：跨 Agent 共用的技能、脚本与规范。
- `extension/edge-bookmark-organizer/`：Edge 解压缩扩展源码。
- `installer/`：安装、自检与维护脚本。
- `docs/`：流程、隐私和浏览器扩展说明。

## 未来方向

如果未来面向没有本机 Agent 的普通用户，可以考虑让插件连接统一的远端 Agent 与技能服务。该方向的适用条件、候选架构、数据边界和安全前提见 [未来方向：可选的远端智能服务](docs/future-remote-service.md)。它目前只是设计记录，不代表已有功能或近期实现承诺。

## 安全与隐私

默认仅在本机读取书签。链接检查会向目标站点发出请求；AI 语义分析应仅基于本地审计简报，除非用户明确要求阅读外部网页。更多内容见 [隐私与安全](docs/privacy-and-security.md)。

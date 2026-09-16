# 本地 Agent 桥接

2.0 的目标是让 Claude Code、Codex、Cursor 等任何能运行本地命令的 Agent 使用同一套收藏夹接口，而不是适配每一种 Agent，也不依赖视觉点击插件页面。

## 数据流

```text
Agent → bookmarkctl.py → 临时 127.0.0.1 页面 → Chromium 外部消息 → 扩展 → chrome.bookmarks
```

`bookmarkctl.py` 在单次命令期间监听随机端口，使用指定 Chromium 浏览器打开一个约 420×240 的小型应用窗口。该本地页面向固定扩展 ID 发送请求，扩展校验安装器生成的随机令牌后执行并返回 JSON。收到结果后，本地服务立即关闭，窗口尝试自动关闭。Chromium 与 Edge 没有可用的启动最小化开关，窗口可能短暂出现在屏幕上或任务栏中；这不要求用户切换窗口或点击页面。

这不是常驻服务器：没有固定监听端口，不接受局域网或公网请求，也不要求为 Claude、Codex、Cursor 分别安装适配器。

## 命令协议

| 命令 | 作用 | 是否改动收藏夹 |
|---|---|---|
| `status` | 检查桥接、版本和收藏夹统计 | 否 |
| `scan` | 返回临时收藏、实时 ID、重复位置和已有目录 | 否 |
| `backup` | 导出完整 HTML | 否 |
| `archives` | 列出仍存在的备份 | 否 |
| `operations` | 列出插件操作记录 | 否 |
| `validate-plan` | 重新扫描、校验计划并生成短时令牌 | 否 |
| `apply-plan --confirmed` | 先备份，再移动已校验计划 | 是 |
| `undo --confirmed` | 先备份，再撤销指定操作 | 是 |

`validate-plan` 返回的 `planToken` 有效期为 10 分钟。执行时扩展会重新扫描，并比较计划条目的 ID、标题、URL、原父目录、原位置、原路径和目标路径；这些状态发生变化、令牌不匹配或过期都会拒绝执行。无关书签的变化不会让当前计划失效。

`--confirmed` 会让 CLI 在请求中加入明确确认标记，扩展侧也会独立拒绝缺少该标记的移动和撤销请求。它用于避免程序误调用，不是对“真人身份”的密码学证明；是否获得用户授权仍由 Agent 技能和当前对话约束。

日常整理只需要 `scan`、`validate-plan`、`apply-plan` 三次调用。`apply-plan` 自己会先备份，调用方不得再提前调用 `backup`。`status`、`archives` 和 `operations` 不是固定前置步骤；仅在故障诊断、用户查询或核对不确定执行结果时使用。

Windows 上如果宿主工具不可靠地回传 stdout，所有只读命令都可以使用全局参数 `--output <文件>`。`--output` 必须写在子命令之前，例如 `python scripts/bookmarkctl.py --pretty --output "$env:TEMP\\bookmark-scan.json" scan`，再读取该无 BOM UTF-8 文件；写在子命令之后会被 argparse 拒绝。计划文件读取兼容带 BOM 和无 BOM 的 UTF-8；详见[本地执行扩展](../.agents/skills/bookmark-organizer/references/local-extension.md)中的 Windows 编码说明。

## 本地身份校验

- manifest 中的公开 `key` 只用于固定解压缩扩展 ID，不是秘密。
- 安装器生成随机令牌，保存在 `~/.bookmark-organizer/bridge.json` 和部署后的扩展副本 `bridge-config.js`。
- 重新安装时优先从已部署扩展恢复令牌，再同步 CLI 配置；删除或损坏单侧配置不会静默生成不匹配的双令牌。
- 仓库中的 `bridge-config.js` 没有令牌，因此直接加载仓库源码时 Agent 桥接默认关闭。
- 不要提交本机生成的配置和真实收藏夹数据。

## 排障

先运行：

```text
python scripts/bookmarkctl.py --pretty status
```

若超时或显示无法连接：

1. 运行安装器并带 `--update-extension --update-skill`。
2. 在浏览器扩展页对 `收藏夹整理助手（本地）` 点击一次“重新加载”。
3. 确认浏览器与安装时选择的 `edge`、`chrome` 或 `brave` 一致。
4. 运行 `installer/doctor.ps1` 检查版本、固定扩展 ID、localhost 来源以及 CLI/扩展两侧令牌是否一致。

不要把连接问题改造成浏览器视觉自动化或临时解析 `Bookmarks` 的脚本；修复桥接后继续使用同一命令协议。

---
name: maa
description: MAA（MaaAssistantArknights，明日方舟小助手）的安装、运行与设置。用户提到 MAA、明日方舟日常、刷理智、基建、公招时使用。
---

# MAA（明日方舟）

- 仓库：MaaAssistantArknights/MaaAssistantArknights；Windows 用 `MAA-v<版本>-win-x64.zip` 发布包。
- 运行依赖：VC++ 运行库 x64（发布包自带 .NET）；需要安卓模拟器，通过 ADB 操作，不占用鼠标键盘，可以和前台脚本并行。

## 运行

- 任务 `daily`：按 MAA 当前配置里**已勾选的任务队列**运行一遍。运行时会临时修改 `config/gui.json` 和 `config/gui.new.json`（启动后直接运行、连接地址设为模拟器的 ADB 地址），看到「任务已全部完成」后关闭 MAA，并把这两个配置文件还原。
- 用法：`script_run`，`id` 为脚本库里的 MAA，`task` 为 `daily`。用户说「清一下方舟日常」「刷理智」都对应这个任务。
- 前提：用户需要先在 MAA 界面里勾选好要跑的任务（例如刷哪一关、用不用理智药）。还没设置过的话，告诉用户先打开一次 MAA 配好任务。
- 想换关卡、理智药数量等：现在先请用户在 MAA 里改；按任务参数自动改任务队列要等真机测试确认 `gui.new.json` 的 TaskQueue 格式后再加。

## 设置

- 配置文件：`config/gui.json`、`config/gui.new.json`（更新时会带到新版本）。用 `script_config_get` 查看，`script_config_set` 修改，不要直接写文件。
- 安装、更新、回滚、检查环境用 `script_*` 工具；不要修改 MAA 的程序文件。

## 待确认（真机测试后补充）

- 失败时的日志文案和退出方式；任务队列的结构，以便按参数选择关卡。

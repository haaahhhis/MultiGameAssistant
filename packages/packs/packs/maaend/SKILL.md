---
name: maaend
description: MaaEnd（明日方舟：终末地自动化）的安装与运行。用户提到终末地、MaaEnd 时使用。
---

# MaaEnd（终末地）

- 仓库：MaaEnd/MaaEnd；Windows 用 `MaaEnd-win-x86_64-v<版本>.zip`。基于 MaaFramework，界面是 MXU。
- 运行依赖：VC++ 运行库 x64。

## 运行

- MaaEnd 按「实例」运行：每个实例有自己的控制器和任务列表，保存在 `config/mxu-MaaEnd.json` 的 `instances` 里。
- 配置分两份：原项目里的配置（用户自己打开脚本时用）和 AutoDailyGamePlay 的**本地副本**（通过 agent 运行时用）。agent 只改本地副本，原项目配置不变。
- 先用 `script_config_get` 读本地副本里的 `config/mxu-MaaEnd.json`，找到用户要跑的实例名（`name`），并看它的控制器：
  - `Win32-Front`：直接操作 PC 版游戏，会抢占鼠标键盘 → 任务 `run-pc`；
  - `ADB`：通过模拟器 → 任务 `run-adb`（会自动启动模拟器）。
- `script_run` 时传参数 `instance`。命令是 `MaaEnd.exe --autostart --instance <名称> --quit-after-run`，跑完会自己退出。
- 想知道有哪些任务：`script_analyze` 会列出 interface.json 里的全部任务（中文名）。修改实例的任务列表：用 `script_settings` 打开 MaaEnd 让用户在界面里改（最稳妥），或用 `script_config_set` 改本地副本，改之前先读懂结构并告诉用户。

## 待确认（真机测试后补充）

- 退出码是否能区分成功和失败；`debug/maa.log` 里的完成和错误标志，用来补充日志规则。

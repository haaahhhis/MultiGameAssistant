---
name: maaend
description: MaaEnd（明日方舟：终末地自动化）的安装与运行。用户提到终末地、MaaEnd 时使用。
---

# MaaEnd（终末地）

- 仓库：MaaEnd/MaaEnd；Windows 用 `MaaEnd-win-x86_64-v<版本>.zip`。基于 MaaFramework，界面是 MXU。
- 运行依赖：VC++ 运行库 x64。

## 运行

- MaaEnd 按「实例」运行：每个实例有自己的控制器（PC 版 `Win32-Front` 或模拟器 `ADB`）和任务列表，保存在 `config/mxu-MaaEnd.json` 的 `instances` 里。
- 配置分两份：原项目里的配置（用户自己打开脚本时用）和本软件的**本地副本**（通过 agent 运行时用）。agent 只改本地副本，原项目配置不变。
- 先 `script_tasks`：参数 `instance` 的 `choices` 就是本地配置里现有的实例名，已经按控制器分好——`run-pc` 只列 PC 版实例（会抢占鼠标键盘），`run-adb` 只列模拟器实例（会自动启动模拟器，并让这个实例连到它）。用户没说用哪个时，只有一个就用它；有多个就问用户。
- 没有合适的实例时，用 `script_choice_create` 新建一个（复制一个同类实例，任务列表也一起复制过来），再按用户要求用 `script_config_set` 调整它的任务，或让用户「打开脚本修改设置」在 MaaEnd 里改；新实例只在本地副本里，原项目不受影响。一个实例都没有时，先让用户打开一次 MaaEnd 建一个。
- `script_run` 时传参数 `instance`。命令是 `MaaEnd.exe --autostart --instance <名称> --quit-after-run`，跑完会自己退出。
- 游戏：运行前如果终末地还没打开，本软件会先启动它（模拟器里是 `com.hypergryph.endfield`，PC 版用用户在脚本页「启动游戏」里设置的程序位置）。实例里 MaaEnd 自己的「打开游戏」任务会发现游戏已经开着，不会冲突。B 服或国际服的包名不同，可以在脚本页改。
- PC 版**要从鹰角官方启动器打开**：直接运行 `Endfield.exe` 会提示「请通过官方启动器打开游戏」。所以「启动游戏」的程序位置要填启动器（不是 `Endfield.exe`），进程名保持 `Endfield.exe`；启动器打开后可能还要点一下「开始游戏」——游戏窗口没出来、MaaEnd 报找不到窗口时，就是这一步没走完：截图看看，点启动器里的开始按钮，等游戏进到主界面后用 `intervention_done(retry)`（处理异常时）或 `script_run` 重新运行。
- 想知道有哪些任务：`script_analyze` 会列出 interface.json 里的全部任务（中文名）。

## 待确认（真机测试后补充）

- 退出码是否能区分成功和失败；`debug/maa.log` 里的完成和错误标志，用来补充日志规则。
- PC 版游戏的进程名（目前按 `Endfield.exe`）。

---
name: maaend
description: MaaEnd（明日方舟：终末地自动化）的安装与基本情况。用户提到终末地、MaaEnd 时使用。
---

# MaaEnd（终末地）

- 仓库：MaaEnd/MaaEnd；Windows 用 `MaaEnd-win-x86_64-v<版本>.zip`。
- 基于 MaaFramework，任务和选项写在 `interface.json` 里。
- 控制方式：`Win32-Front` 直接操作 PC 版游戏，会抢占鼠标键盘（不能和其他前台脚本同时运行）；`ADB` 通过模拟器操作，不占用鼠标。
- 运行依赖：VC++ 运行库 x64。

任务启动方式在 M2 由 maafw-pi 适配家族根据 `interface.json` 自动生成。

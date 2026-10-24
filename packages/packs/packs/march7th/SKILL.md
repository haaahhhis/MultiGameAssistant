---
name: march7th
description: 三月七小助手（March7thAssistant，崩坏：星穹铁道自动化）的安装与运行。用户提到星穹铁道、星铁、三月七、清体力、模拟宇宙时使用。
---

# 三月七小助手（星穹铁道）

- 仓库：moesnow/March7thAssistant；Windows 用 `March7thAssistant_full.zip` 完整包（自带 Python 运行环境）。
- 操作 PC 版游戏窗口，**占用鼠标键盘**：不能和其他前台脚本同时运行，但可以和模拟器上的脚本（如 MAA）并行。

## 运行

命令行是 `March7th Assistant.exe <任务名>`。任务和用户的说法：

| 任务 id | 名称 | 常见说法 |
|---|---|---|
| main | 完整运行 | 跑一遍三月七、星铁全套 |
| routine | 日常 | 星铁日常 |
| daily | 每日实训 | 每日实训 |
| power | 清体力 | 清体力、刷开拓力 |
| universe / divergent / currencywars | 模拟宇宙 / 差分宇宙 / 货币战争 | |
| fight | 锄大地 | |
| forgottenhall / purefiction / apocalyptic | 混沌回忆 / 虚构叙事 / 末日幻影 | |
| redemption | 兑换码 | |
| game_update | 更新游戏 | 更新星铁 |

- 配置分两份：原项目里的配置（用户自己打开脚本时用）和本软件的**本地副本**（通过 agent 运行时用）。agent 只改本地副本，原项目配置不变。
- 刷哪个副本、用多少体力等在 `config.yaml` 里：用 `script_config_get` 读、`script_config_set` 改本地副本，不要直接写文件。
- 第一次运行前通常要完成初始设置（游戏路径等）：用 `script_settings` 打开三月七的设置界面（March7th Launcher）让用户设置，关掉后存进本地配置。
- `--list-workflows` 能列出用户自建的流程（可用 `script_help` 查看）。

## 待确认（真机测试后补充）

- 失败时的退出码和输出；用于补充日志规则。

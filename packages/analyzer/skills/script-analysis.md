---
name: script-analysis
description: 分析脚本库里的一个游戏自动化脚本（包括没见过的脚本），弄清它怎么启动、有哪些任务、怎么改配置、日志在哪，写成脚本包草稿交给用户确认。用户说「分析一下这个脚本」「这个脚本怎么用」「给它生成脚本包」，或某个脚本还没有脚本包、需要运行它时使用。
---

# 分析脚本并生成脚本包

目标：让一个脚本能被 `script_run` 用自然语言启动。产出一份脚本包草稿（`adg.script.yaml` + `SKILL.md`），用 `pack_propose` 提交，用户在「脚本」页确认后生效。

## 规则

- **只读**：分析期间不修改脚本目录里的任何文件（守卫也会拦截）。要看配置用 `script_config_get` 或读文件工具。
- **不猜**：每一条启动方式、任务、配置键、日志规则都要有依据（README、`--help` 输出、interface.json、配置文件内容、日志样本、官方文档）。没有依据的写进 SKILL.md 的「待确认」，不要写进 manifest。
- 成败判定取自脚本自己的输出（退出码、日志），不要自造信号。

## 步骤

1. `script_list` 找到脚本 id；`script_analyze` 拿到目录结构、可执行文件、README、MaaFramework 任务、配置文件、日志样本和建议的适配家族。
2. 判断适配家族：
   - `maafw-pi`：有 `interface.json`。任务名、选项、控制器都在报告里；控制器 `Win32` 且 `mouse: Seize` 表示抢占鼠标（resources.input: desktop），`Adb` 表示用模拟器（adb）。
   - `cli`：有命令行参数。用 `script_help` 看 `--help` / `-h` / `-l` 输出，把每个子命令或任务名写成一个 task。
   - `gui-config`：GUI 程序，靠配置文件决定做什么、能设置「启动后直接运行」。写 `patches` 改配置，`success: done-log` + 完成日志规则，`launch.stopAfterDone: true`（GUI 完成后不自己退出时）。
   - `generic-process`：只能启动程序，看退出码和日志。
   - `visual`：以上都不行（需要截图点击，M5 支持），先写清楚现状。
3. 找日志：报告里的 `logFiles` 有样本；没有就根据文档写，标注「待运行后校准」。完成标志写 `level: done`，错误写 `level: error`。
4. 判断资源：前台操作 PC 游戏 = `desktop`；模拟器 = `adb`（会自动启动模拟器，ADB 地址用 `{adb}` 占位符）；不占用 = `none`。同一游戏账号写 `account`。
5. 写草稿，`pack_propose` 提交。校验失败会返回具体字段，修正后再提交。
6. 告诉用户草稿已提交、去「脚本」页查看并确认，说明哪些是确定的、哪些待确认。

## adg.script.yaml 字段

```yaml
id: <小写 id，与 pack_id 相同>
name: <显示名>
description: <一句话>
family: maafw-pi | cli | gui-config | generic-process | visual
source:
  github: owner/repo            # 有发布版时
  release:
    asset: '<文件名，{version} 为不带 v 的版本号；可写数组按顺序尝试>'
install:
  requires:                     # 运行依赖：vcredist、dotnet-desktop-runtime（version: '>=8'）、python、node、adb、emulator
    - kind: vcredist
config:
  files:                        # 允许修改的配置文件（相对路径，* 匹配一层内的文件名）
    - path: config/gui.json
      format: json              # json | yaml | toml | ini | text
detect:
  files: [<能唯一识别这个脚本的文件>]
launch:
  exe: <相对路径的程序>
  args: []                      # 所有任务共用的参数
  stopAfterDone: false          # 看到完成日志后关闭程序
tasks:
  - id: daily
    title: 日常
    utterances: [清日常, 每日任务]
    params:                     # 用 {name} 在 args / patches 里引用
      stage: { type: string, default: '1-7', description: 关卡 }
    args: ['{stage}']           # 追加到 launch.args
    patches:                    # 这次运行的临时修改：叠加在本地配置上，结束后原项目配置会还原
      - file: config/gui.json
        set:
          - path: [Configurations, Default, Start.RunDirectly]   # 键里有点号就整体写成一个元素
            value: 'True'
    resources: { input: adb, emulator: mumu, account: main }
    success: exit-code          # 或 done-log：必须看到完成日志才算成功
    expectedDuration: 40m
logs:
  sources:
    - stdout: true              # encoding: utf-8 | gbk
    - path: debug/gui.log
  rules:
    - { match: '任务已全部完成', level: done }
    - { match: '任务出错', level: error, tag: task-error }
```

占位符：任务参数，以及 `{adb}`（模拟器地址）、`{dir}`（脚本目录）。

## SKILL.md

开头 frontmatter（`name` 用小写和短横线，`description` 写清楚用户什么时候会提到它），正文写：这个脚本能做什么、每个任务对应用户的哪些说法、参数怎么选、运行前要用户在脚本里做的一次性设置、常见问题、待确认的内容。

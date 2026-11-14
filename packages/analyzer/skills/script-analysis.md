---
name: script-analysis
description: 分析脚本库里的一个游戏自动化脚本（包括没见过的脚本），先读项目自己的文档、再结合代码，弄清它怎么启动、有哪些任务、怎么改配置、日志在哪，写成脚本包保存（直接生效）；脚本更新后先读更新日志再检查脚本包。用户说「分析一下这个脚本」「这个脚本怎么用」「给它生成脚本包」「脚本更新了，脚本包要不要改」，或某个脚本还没有脚本包、需要运行它时使用。
---

# 分析脚本并生成脚本包

目标：让一个脚本能被 `script_run` 用自然语言启动，并让用户看得懂它能做什么、怎么配。产出一份脚本包，用 `pack_propose` 保存：校验通过就直接生效，不用用户确认，被替换的那一版留在历史里。所以保存前自己核对清楚，没把握的不要写进 manifest。脚本包分两部分，给不同的人看：

- `adg.script.yaml`：运行方式，加上给**用户**看的使用说明（`guide`、任务和参数的 `description`、临时修改的 `note`），脚本页上显示；
- `SKILL.md`：只给 **agent** 看的备注（用户说法怎么对应任务、操作要点、核验依据、限制、待确认）。

## 规则

- **先文档，后代码**：项目作者写的文档（README、使用说明、帮助、Wiki、文档站、更新日志）最权威，先把它们读完；代码和配置用来核对、补全文档没写的细节；只有确实找不到任何文档时，才直接从代码分析。
- **只读**：分析期间不修改脚本目录里的任何文件（守卫也会拦截）。要看配置用 `script_config_get` 或读文件工具。
- **不猜**：每一条启动方式、任务、配置键、日志规则都要有依据（文档、`--help` 输出、interface.json、配置文件内容、日志样本、源码）。没有依据的写进 SKILL.md 的「待确认」，不要写进 manifest。文档和代码对不上时以代码（实际行为）为准，并在「待确认」里写明。
- 成败判定取自脚本自己的输出（退出码、日志），不要自造信号。
- 先 `skill_focus`（scripts 写这个脚本的 id）：它已有的技能才看得到，也不会混进别的脚本的技能。

## 步骤

1. `script_list` 找到脚本 id，`skill_focus` 设成它；`script_analyze` 拿到目录结构、项目文档（`docs`、`readme`）、文档网址（`docLinks`）、MaaFramework 任务、配置文件、日志样本和建议的适配家族。
2. **读文档**，按这个顺序，读到够用为止：
   1. 目录里的文档：`readme`，以及 `docs` 列出的文件（使用说明、帮助、FAQ、更新日志），用读文件工具打开；
   2. 网上的文档：`docLinks` 里的仓库主页（README）、Wiki、文档站，用网页工具打开；目录和链接里都没有时，用项目名搜索它的官方文档；
   3. 记下每份文档告诉你的：怎么启动、有哪些任务和参数、每个功能在脚本界面的哪里开启、配置文件在哪和关键的键、日志在哪、怎么判断完成和出错、常见报错和处理办法、要先在脚本里做的设置。
3. **结合代码核对、补全**：用 interface.json、`script_help` 的输出、配置文件、日志样本（必要时读入口代码）确认文档说的是否还对，补上文档没写的细节（准确的配置路径、日志原文）。
4. **找不到任何文档时**才直接看代码：入口程序、参数解析、读配置的地方、打印日志的地方；这样写出的内容在 SKILL.md 里标明「依据：代码」，拿不准的放进「待确认」。
5. 判断适配家族：
   - `maafw-pi`：有 `interface.json`。任务名、选项、控制器都在报告里；控制器 `Win32` 且 `mouse: Seize` 表示抢占鼠标（resources.input: desktop），`Adb` 表示用模拟器（adb）。
   - `cli`：有命令行参数。用 `script_help` 看 `--help` / `-h` / `-l` 输出，把每个子命令或任务名写成一个 task。
   - `gui-config`：GUI 程序，靠配置文件决定做什么、能设置「启动后直接运行」。写 `patches` 改配置，`success: done-log` + 完成日志规则，`launch.stopAfterDone: true`（GUI 完成后不自己退出时）。
   - `generic-process`：只能启动程序，看退出码和日志。
   - `visual`：以上都不行（需要截图点击，M5 支持），先写清楚现状。
6. 找日志：报告里的 `logFiles` 有样本；没有就根据文档写，标注「待运行后校准」。完成标志写 `level: done`，错误写 `level: error`。
7. 判断资源：前台操作 PC 游戏 = `desktop`；模拟器 = `adb`（会自动启动模拟器，ADB 地址用 `{adb}` 占位符）；不占用 = `none`。同一游戏账号写 `account`。
8. 写使用说明（下面「使用说明」一节）和 SKILL.md（「SKILL.md」一节）。
9. 写好后用 `pack_propose` 保存：`docs` 写读过的文档（出处和从中得到了什么）；确实没有文档时用 `no_docs` 说明找过哪些地方。校验失败（包括使用说明的检查）会返回具体位置，修正后再提交。
10. 告诉用户脚本包已经保存并生效，说明改了什么、依据了哪些文档、哪些是确定的、哪些待确认；使用说明在「脚本」页可以看到。

## 脚本更新后检查脚本包

脚本（项目）更新到新版本后，软件会问用户要不要检查脚本包；用户同意后按这里做：

1. `skill_focus` 设成这个脚本；**先读更新日志**：`script_changelog`（id，from 填脚本包写成时的版本）拿到这几个版本的发布说明，目录里的更新日志（CHANGELOG、更新日志）也一起看。
2. 从更新日志里挑出可能影响脚本包的改动：任务新增、改名或删除；参数和选项；功能的开启位置；配置文件的位置和键；启动方式和程序名；日志里的完成、出错文字；需要的运行环境。使用说明（`guide`）里对应的内容一起改。
3. 只针对这些改动去核对新版本的文件（interface.json、配置、`script_help`、日志样本），不用从头分析；更新日志没写清楚的再看代码。
4. 要改：用**原来的脚本包 id** 调用 `pack_propose` 保存（直接生效），`summary` 写清楚依据更新日志改了什么，`docs` 里写上更新日志的出处。不用改：调用 `pack_reviewed` 说明理由（例如「这几个版本只修了识别问题，任务、配置、日志都没变」）。
5. 告诉用户结论。

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
  # settings: { exe: <设置程序> }  # 「打开脚本修改设置」打开的程序；省略时打开上面的主程序。
  #                              # 主程序一启动就自动开跑（不显示设置界面）时才需要写，例如三月七的 Launcher
tasks:
  - id: daily
    title: 日常
    description: <给用户看：这个任务做什么、按什么决定做哪些事>
    utterances: [清日常, 每日任务]
    params:                     # 用 {name} 在 args / patches 里引用
      stage: { type: string, default: '1-7', description: <给用户看：含义，例如「要刷的关卡，如 1-7、CE-6」> }
    args: ['{stage}']           # 追加到 launch.args
    patches:                    # 这次运行的临时修改：叠加在本地配置上，结束后原项目配置会还原
      - file: config/gui.json
        set:
          - path: [Configurations, Default, Start.RunDirectly]   # 键里有点号就整体写成一个元素
            value: 'True'
            note: <给用户看：这项临时修改做什么，例如「启动后直接开始任务，不用手动点开始」>
    resources: { input: adb, emulator: mumu, account: main }
    success: exit-code          # 或 done-log：必须看到完成日志才算成功
    expectedDuration: 40m
logs:
  sources:
    - stdout: true              # encoding 默认 auto（UTF-8，不是就按 GBK），一般不用写
    - path: debug/gui.log
  rules:
    - { match: '任务已全部完成', level: done }
    - { match: '任务出错', level: error, tag: task-error }
    - { match: '正在尝试重连', level: warning, tag: adb-reconnecting }   # 脚本自己会重试的错误用 warning，不算失败
  stallAfter: 15m               # 这么久没有新日志算卡住（只给持续写日志的脚本写）
recovery:                       # 出问题时平台自动做的事（每条最多 max 次），处理不了才通知用户
  - { on: adb-disconnected, do: reconnect-adb }   # on：规则的 tag，或 stalled / failed
  - { on: adb-disconnected, do: restart }          # do：reconnect-adb | restart | stop
game:                           # 脚本玩的游戏：脚本自己不启动游戏时，平台在运行前启动它
  name: 明日方舟
  android: { package: com.example.game }          # 模拟器任务：运行前在模拟器里启动
  pc: { process: Game.exe }                       # PC 任务：进程名（程序位置由用户在界面里设置）
  selfLaunch: never             # 脚本自己会启动游戏时写 always，或写配置条件：
                                # [{ file: config/gui.json, path: [Start, StartGame], equals: 'True' }]
  startupSeconds: 30
```

占位符：任务参数，以及 `{adb}`（模拟器地址）、`{dir}`（脚本目录）。

另外几种写法：

- 参数的可选值来自脚本配置（例如实例名、账号名），用户就能从列表里选：
  `instance: { type: string, choices: { file: config/x.json, list: [instances], value: name, detail: controller, where: { field: controller, match: 'adb' }, create: { set: { id: '{uuid}', name: '{name}' } } } }`。
  `create` 表示可以复制一个现有项新建（结构和脚本自己写的一样）。
- 临时修改的路径里可以按字段找列表项：`path: [instances, { where: { field: name, equals: '{instance}' } }, address]`。
- 脚本自己也会启动模拟器时（例如它有「启动后打开模拟器」），平台已经启动了模拟器，就用 `when: emulator-managed` 的临时修改把它关掉；用户填的是手动 ADB 地址时这条不生效，脚本照常自己启动模拟器。
- 脚本会自己启动游戏，就在 `game.selfLaunch` 里写明，平台不再重复启动；平台也会先看游戏是否已经在运行。

日志规则只写在源码、文档或真实日志里确实出现过的原文；拿不准的错误先写成 `warning`。`recovery` 只给确定安全的情况写（重启任务会从头再跑一遍）。

## 使用说明（给用户看）

「脚本」页把使用说明显示给用户：这个脚本能做什么、每个任务和参数是什么、每个功能怎么开启、配置文件怎么设置、运行前检查什么、出错怎么办。它由三处组成：

1. 每个任务的 `title` / `description`、每个参数的 `description`（含义；可选值和默认值写在 `enum` / `choices` / `default` 里，页面会列出来）；
2. 每条临时修改的 `note`：这项修改做什么（页面会列出「运行时临时修改的键」，并说明运行结束后还原）；
3. manifest 里的 `guide`：

```yaml
guide:
  overview: <两三句：它能做什么、通过什么操作游戏（模拟器 / 占用鼠标键盘）、按什么决定做哪些事>
  setup:                        # 第一次使用前要在脚本自己的界面里做的设置，按顺序
    - 在「设置 → 连接设置」里选好模拟器类型
  checks:                       # 每次运行前要确认的事
    - 脚本没有在别处打开
  features:                     # 脚本的功能，每个写清楚怎么开启
    - title: 自动公招
      description: 自动选择公招标签并招募
      enable: 在主界面任务列表勾选「自动公招」，点它右边的齿轮设置招募几星
      config:                   # 这个开关在配置文件里对应的键和开启它的值（确认过才写；列表项按字段找，不写固定下标）
        - { file: config/settings.json, path: [Tasks, { where: { field: type, equals: Recruit } }, enabled], value: true }
      tasks: [daily]            # 哪些任务会做它
  config:                       # 配置文件：存了什么、哪些键重要
    - file: config/settings.json
      about: 主设置：每份配置一组，Current 是正在用的那份
      keys:
        - path: [Current]
          meaning: 当前使用的配置名称
          values: Configurations 里的一个名称
          default: Default
          advice: 保持 Default：本应用运行时只改 Default 这份配置
  troubleshooting:              # 常见问题：看到什么（脚本日志的原文或现象）→ 什么意思 → 怎么办
    - problem: 日志出现「任务出错」
      cause: 队列里某个子任务失败，脚本会接着做后面的任务
      fix: 在运行记录里看是哪个子任务出错；连不上模拟器时先检查连接设置
      tag: task-error           # 对应的日志规则（可省略）
```

写法要求：

- **写给用户**：用中文、用户的说法；功能开启写脚本界面里的位置和选项名（以文档和界面文字为准），配置写到具体的文件、键和值。
- 每个任务、每个参数都要有 `description`；脚本会做的功能尽量都列进 `features`；运行时临时修改的每一项都写 `note`。
- 只写确定的：不确定的功能、键或报错不要写进使用说明，写进 SKILL.md 的「待确认」。
- **不要写给 agent 的内容**：工具名（`script_*`、`pack_*` …）、脚本包的字段和机制（manifest、patches、done-log、还原机制、占位符 `{adb}`）、核验依据、渲染器限制、待确认。`pack_propose` 会检查，混进去会失败并告诉你位置。

## SKILL.md（给 agent 看）

开头 frontmatter（`name` 用小写和短横线，`description` 写清楚用户什么时候会提到它）。正文是 agent 处理这个脚本时要知道、使用说明里没有的东西，不要把使用说明再抄一遍（用户问怎么设置时，`script_tasks` 加 `guide: true` 可以拿到使用说明）：

- 用户的说法怎么对应任务和参数，哪些要求现有任务做不到（例如只跑某一个子任务），这时怎么办；
- 操作要点：先用哪些工具核对什么、什么情况下不能直接运行；
- 核验依据：从哪些文档、配置、日志样本确认了启动方式、配置键和日志文字（带版本或日期）；
- 限制：脚本包做不到的、只适配了本机现状的（例如只改 Default 这份配置）；
- 待确认：还没验证的内容；
- 最后一节「依据」列出用到的文档（和版本），没有文档时写「依据：代码」。

脚本包的 SKILL.md 只属于这个脚本：只在处理这个脚本（或它玩的游戏）的会话里出现，所以只写这个脚本的事，不要写别的脚本怎么用。

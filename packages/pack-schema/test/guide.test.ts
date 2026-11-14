import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { guideIssues, guideView } from '../src/guide.ts'
import { PackError, parseManifest } from '../src/parse.ts'

const PACK = `
id: tool
name: 工具
config:
  files:
    - path: config/gui.json
      format: json
    - path: config/profiles/*.json
      format: json
launch:
  exe: Tool.exe
tasks:
  - id: daily
    title: 日常
    description: 按工具里勾选的任务跑一遍
    params:
      stage: { type: string, default: '1-7', description: 关卡 }
      mode: { type: string, enum: [fast, safe], description: 模式 }
    patches:
      - file: config/gui.json
        set:
          - path: [Settings, Run.Directly]
            value: true
            note: 启动后直接开始任务
          - path: [Settings, Address]
            value: '{adb}'
            note: 连接本应用准备好的模拟器
      - file: config/gui.json
        when: emulator-managed
        set:
          - path: [Settings, StartEmulator]
            value: false
  - id: fight
    title: 刷关
    description: 只刷指定关卡
    params:
      stage: { type: string, description: 关卡 }
    patches:
      - file: config/gui.json
        set:
          - path: [Settings, Run.Directly]
            value: true
          - path: [Profiles, { where: { field: name, equals: '{stage}' } }, Enabled]
            value: true
logs:
  rules:
    - { match: '任务出错', level: error, tag: task-error }
guide:
  overview: 通过模拟器自动做日常，不占用鼠标键盘。
  setup: [在工具的设置里选好模拟器类型]
  checks: [工具没有在别处打开]
  features:
    - title: 自动公招
      enable: 在主界面勾选「自动公招」
      config:
        - { file: config/profiles/main.json, path: [Recruit, Enabled], value: true }
      tasks: [daily]
  config:
    - file: config/gui.json
      about: 工具的主设置
      keys:
        - { path: [Settings, Run.Directly], meaning: 启动后直接运行, values: true 或 false, default: false }
  troubleshooting:
    - { problem: 日志出现「任务出错」, cause: 某个子任务失败, fix: 看运行记录里的出错位置, tag: task-error }
`

test('a guide parses, and its references are checked', () => {
  const pack = parseManifest(PACK)
  assert.equal(pack.guide?.features[0]?.config[0]?.file, 'config/profiles/main.json', 'a file the * of config.files matches')
  const broken = (from: string, to: string, message: RegExp) => assert.throws(() => parseManifest(PACK.replace(from, to)), (e: unknown) => e instanceof PackError && message.test(e.message))
  broken('file: config/profiles/main.json', 'file: config/other.json', /guide\.features\.0\.config\.0\.file: config\/other\.json is not one of config\.files/)
  broken('      tasks: [daily]', '      tasks: [nope]', /guide\.features\.0\.tasks\.0: no task nope/)
  broken('fix: 看运行记录里的出错位置, tag: task-error', 'fix: 看运行记录里的出错位置, tag: nope', /no log rule has tag nope/)
  broken('    - file: config/gui.json\n      about', '    - file: gui.ini\n      about', /guide\.config\.0\.file: gui\.ini is not one of config\.files/)
  broken('  overview: 通过模拟器自动做日常，不占用鼠标键盘。', '  overview: "  "', /guide\.overview/)
})

test('the guide view says what runs change, in words people read', () => {
  const view = guideView(parseManifest(PACK), { builtin: false })
  assert.equal(view.written, true)
  assert.equal(view.overview, '通过模拟器自动做日常，不占用鼠标键盘。')
  assert.deepEqual(view.tasks[0]?.params, [
    { name: 'stage', type: 'string', description: '关卡', default: '1-7' },
    { name: 'mode', type: 'string', description: '模式', values: 'fast、safe' },
  ])
  const gui = view.config.find(f => f.file === 'config/gui.json')!
  assert.equal(gui.about, '工具的主设置')
  assert.deepEqual(gui.keys, [{ key: 'Settings › Run.Directly', meaning: '启动后直接运行', values: 'true 或 false', default: 'false' }])
  assert.deepEqual(gui.changes, [
    { key: 'Settings › Run.Directly', value: 'true', note: '启动后直接开始任务', tasks: ['日常', '刷关'] },
    { key: 'Settings › Address', value: '「模拟器的 ADB 地址」', note: '连接本应用准备好的模拟器', tasks: ['日常'] },
    { key: 'Settings › StartEmulator', value: 'false', when: '本应用启动了模拟器时（填了手动 ADB 地址时不改）', tasks: ['日常'] },
    { key: 'Profiles › [name = 「参数 stage（关卡）」] › Enabled', value: 'true', tasks: ['刷关'] },
  ])
  assert.deepEqual(view.features[0], { title: '自动公招', enable: '在主界面勾选「自动公招」', config: [{ file: 'config/profiles/main.json', key: 'Recruit › Enabled', value: 'true' }], tasks: ['日常'] })
  assert.deepEqual(view.troubleshooting, [{ problem: '日志出现「任务出错」', cause: '某个子任务失败', fix: '看运行记录里的出错位置' }])
})

test('without a written guide the view still lists the tasks and what runs change', () => {
  const view = guideView(parseManifest(PACK.slice(0, PACK.indexOf('guide:'))), { builtin: true })
  assert.equal(view.written, false)
  assert.equal(view.overview, undefined)
  assert.deepEqual(view.tasks.map(t => t.title), ['日常', '刷关'])
  assert.equal(view.config[0]?.file, 'config/gui.json')
  assert.equal(view.config[0]?.about, undefined)
  assert.equal(view.config[0]?.changes.length, 4)
})

test('guide issues: a missing guide, undescribed tasks and parameters, the agent\'s own notes', () => {
  assert.deepEqual(guideIssues(parseManifest(PACK)), [])
  const bare = guideIssues(parseManifest(PACK.slice(0, PACK.indexOf('guide:')).replace('    description: 只刷指定关卡\n', '').replace('{ type: string, description: 关卡 }', '{ type: string }')))
  assert.match(bare[0]!, /缺少 guide/)
  assert.ok(bare.some(i => /任务 fight 缺少 description/.test(i)))
  assert.ok(bare.some(i => /任务 fight 的参数 stage 缺少 description/.test(i)))
  const notes = (from: string, to: string) => guideIssues(parseManifest(PACK.replace(from, to)))
  assert.match(notes('setup: [在工具的设置里选好模拟器类型]', 'setup: [用 script_config_get 读取配置]')[0]!, /guide\.setup\.0 里有工具名「script_config_get」/)
  assert.match(notes('note: 启动后直接开始任务', 'note: 运行器按 patches 还原')[0]!, /patches\.0\.set\.0\.note 里有脚本包的字段「patches」/)
  assert.match(notes('cause: 某个子任务失败', "cause: '地址来自 {adb}'")[0]!, /占位符「\{adb\}」/)
  assert.match(notes('overview: 通过模拟器自动做日常，不占用鼠标键盘。', 'overview: 本草稿尚未进行托管运行。')[0]!, /给 agent 的备注/)
  assert.deepEqual(notes('fix: 看运行记录里的出错位置', 'fix: 检查 game_title_name 和 script_path'), [], 'script config keys that look like tool names are fine')
  // Seen with a real model (M9A): the script's own log line names its own manifest.
  assert.deepEqual(notes('problem: 日志出现「任务出错」', 'problem: 日志里有「获取 resource/manifest.json失败」'), [])
  assert.deepEqual(notes('problem: 日志出现「任务出错」', 'problem: 界面里点「保存草稿」后报错'), [], 'a label in quotes is the script\'s own word')
  assert.match(notes('fix: 看运行记录里的出错位置', 'fix: 改 manifest 里的配置')[0]!, /脚本包的文件「manifest」/)
  assert.match(notes('fix: 看运行记录里的出错位置', 'fix: 日志「x」出现后用 script_run 重跑')[0]!, /工具名/)
  assert.match(notes('fix: 看运行记录里的出错位置', 'fix: 「script_run」重跑')[0]!, /工具名/, 'tool names count inside quotes too')
})

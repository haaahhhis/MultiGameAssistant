import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { analyzeDir } from '../src/analyze.ts'
import { DraftStore } from '../src/drafts.ts'
import { parseJsonc } from '../src/jsonc.ts'
import { readInterface } from '../src/maafw.ts'
import { parseSkill } from '../src/skills.ts'

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `adg-an-${p}-`))

test('JSONC: comments and trailing commas outside strings are removed, strings are kept', () => {
  const value = parseJsonc('﻿{\n  // a comment\n  "url": "https://x.y/z", /* block */\n  "list": [1, 2,],\n  "s": "a // not a comment, \\" still",\n}\n')
  assert.deepEqual(value, { url: 'https://x.y/z', list: [1, 2], s: 'a // not a comment, " still' })
})

function maaProject(): string {
  const dir = tmp('maafw')
  mkdirSync(join(dir, 'tasks'))
  mkdirSync(join(dir, 'locales', 'interface'), { recursive: true })
  writeFileSync(join(dir, 'interface.json'), `{
    // project
    "name": "FakeEnd", "version": "v1.2.0",
    "languages": { "zh_cn": "locales/interface/zh_cn.json" },
    "controller": [
      { "name": "Win32-Front", "type": "Win32", "win32": { "mouse": "Seize", "keyboard": "Seize" } },
      { "name": "ADB", "type": "Adb" },
    ],
    "task": [],
    "import": ["tasks/Daily.json", "tasks/missing.json"],
  }`)
  writeFileSync(join(dir, 'tasks', 'Daily.json'), JSON.stringify({
    task: [{ name: 'DailyRewards', label: '$task.DailyRewards.label', entry: 'DailyStart', controller: ['ADB'], option: ['Mode'] }],
    option: { Mode: { type: 'select', label: '$option.Mode.label', cases: [{ name: 'Fast' }, { name: 'Full' }] } },
  }))
  writeFileSync(join(dir, 'locales', 'interface', 'zh_cn.json'), JSON.stringify({ task: { DailyRewards: { label: '领取每日奖励' } }, option: { Mode: { label: '模式' } } }))
  writeFileSync(join(dir, 'FakeEnd.exe'), 'MZ')
  return dir
}

test('MaaFramework interfaces: imports followed, labels resolved, Seize controllers seen', async () => {
  const dir = maaProject()
  const iface = await readInterface(join(dir, 'interface.json'))
  assert.equal(iface.name, 'FakeEnd')
  assert.deepEqual(iface.controllers.map(c => [c.name, c.mouse]), [['Win32-Front', 'Seize'], ['ADB', undefined]])
  assert.deepEqual(iface.tasks.map(t => [t.name, t.label, t.entry, t.controllers]), [['DailyRewards', '领取每日奖励', 'DailyStart', ['ADB']]])
  assert.deepEqual(iface.tasks[0]!.options, [{ name: 'Mode', label: '模式', type: 'select', cases: ['Fast', 'Full'] }])
  assert.equal(iface.problems.length, 1, 'the missing import is reported, not fatal')
})

test('analysis reports layout, configs, logs and a family suggestion', async () => {
  const dir = maaProject()
  const report = await analyzeDir(dir)
  assert.equal(report.suggestedFamily, 'maafw-pi')
  assert.equal(report.interface?.tasks.length, 1)
  assert.ok(report.tree.includes('tasks/') && report.tree.includes('tasks/Daily.json'))

  const gui = tmp('gui')
  mkdirSync(join(gui, 'config'))
  mkdirSync(join(gui, 'debug'))
  writeFileSync(join(gui, 'Tool.exe'), 'MZ')
  writeFileSync(join(gui, 'Tool.deps.json'), '{}')
  writeFileSync(join(gui, 'config', 'gui.json'), '{"Global": {}, "Configurations": {"Default": {}}}')
  writeFileSync(join(gui, 'debug', 'gui.log'), Array.from({ length: 20 }, (_, i) => `[12:00:${i}] line ${i}`).join('\n'))
  writeFileSync(join(gui, 'README.md'), '# Tool\n用法：……')
  const guiReport = await analyzeDir(gui)
  assert.equal(guiReport.suggestedFamily, 'gui-config')
  assert.deepEqual(guiReport.configFiles.map(c => [c.file, c.topKeys]), [['config/gui.json', ['Global', 'Configurations']]], 'runtime manifests like *.deps.json are left out')
  assert.equal(guiReport.logFiles[0]?.file, 'debug/gui.log')
  assert.equal(guiReport.logFiles[0]?.tail.length, 8)
  assert.equal(guiReport.readme?.file, 'README.md')
})

test('the project’s own documents are found before any code: docs folders, manuals, changelogs, and the doc links in its README', async () => {
  const dir = tmp('docs')
  mkdirSync(join(dir, 'docs', 'zh-cn'), { recursive: true })
  mkdirSync(join(dir, 'debug'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'Tool.exe'), 'MZ')
  writeFileSync(join(dir, 'README.md'), '# Tool\n文档：https://tool.example.com/docs/start ，Wiki：https://github.com/Owner/Tool/wiki 。![badge](https://img.shields.io/badge/x) 下载：https://github.com/Owner/Tool/releases/download/v1/Tool.zip')
  writeFileSync(join(dir, 'CHANGELOG.md'), '# 1.0')
  writeFileSync(join(dir, '使用说明.txt'), '先打开设置')
  writeFileSync(join(dir, 'docs', 'zh-cn', 'tasks.md'), '# 任务')
  writeFileSync(join(dir, 'docs', 'logo.png'), 'png')
  writeFileSync(join(dir, 'debug', 'gui.log'), 'line')
  writeFileSync(join(dir, 'src', 'main.py'), 'print()')
  const report = await analyzeDir(dir)
  assert.deepEqual(report.docs.map(d => d.file).sort(), ['CHANGELOG.md', 'README.md', 'docs/zh-cn/tasks.md', '使用说明.txt'])
  assert.equal(report.docs[0]?.file, 'CHANGELOG.md', 'changelogs first, then READMEs')
  assert.deepEqual(report.docLinks, ['https://tool.example.com/docs/start', 'https://github.com/Owner/Tool/wiki'], 'no badges, no downloads')

  const bare = tmp('bare')
  writeFileSync(join(bare, 'Tool.exe'), 'MZ')
  const none = await analyzeDir(bare)
  assert.deepEqual(none.docs, [])
  assert.ok(none.notes.some(n => n.includes('找不到再看代码')))
})

const MANIFEST = 'id: tool\nname: Tool\nlaunch:\n  exe: Tool.exe\ntasks:\n  - id: run\n    title: 运行\n'
const SKILL = '---\nname: tool\ndescription: 运行 Tool。\n---\n\n# Tool\n'

test('drafts validate before saving, and accepting keeps the previous user pack', async () => {
  const data = tmp('drafts')
  const store = new DraftStore(data)
  await assert.rejects(store.propose({ packId: 'tool', scriptId: 'tool', proposedAt: 1, summary: 's' }, 'id: tool\nname: Tool\ntasks:\n  - { id: run, title: 运行 }\n', SKILL), /tasks need a launch section/)
  await assert.rejects(store.propose({ packId: 'other', scriptId: 'tool', proposedAt: 1, summary: 's' }, MANIFEST, SKILL), /必须等于 pack_id/)
  await assert.rejects(store.propose({ packId: 'tool', scriptId: 'tool', proposedAt: 1, summary: 's' }, MANIFEST, '# no frontmatter'), /frontmatter/)

  const proposed = await store.propose({ packId: 'tool', scriptId: 'tool', proposedAt: 1, summary: '第一版' }, MANIFEST, SKILL)
  assert.deepEqual(proposed.tasks, [{ id: 'run', title: '运行' }])
  assert.equal((await store.list())[0]?.summary, '第一版')

  const first = await store.accept('tool', 1000)
  assert.ok(existsSync(join(first.dir, 'adg.script.yaml')) && !existsSync(join(first.dir, 'draft.json')))
  await store.propose({ packId: 'tool', scriptId: 'tool', proposedAt: 2, summary: '第二版' }, MANIFEST.replace('运行', '运行二'), SKILL)
  await store.accept('tool', 2000)
  assert.match(readFileSync(join(data, 'packs', 'tool', 'adg.script.yaml'), 'utf8'), /运行二/)
  assert.ok(existsSync(join(data, 'pack-history', 'tool')), 'the first accepted version is kept in history')
  assert.deepEqual(await store.list(), [])

  await store.propose({ packId: 'tool', scriptId: 'tool', proposedAt: 3, summary: 'x' }, MANIFEST, SKILL)
  await store.reject('tool')
  assert.deepEqual(await store.list(), [])
})

test('a pack the agent saves is in use at once: no draft waits, the pack it replaces is kept, a bad one changes nothing', async () => {
  const data = tmp('save')
  const store = new DraftStore(data)
  const meta = (summary: string) => ({ packId: 'tool', scriptId: 'tool', proposedAt: 1, summary })
  const inUse = () => readFileSync(join(data, 'packs', 'tool', 'adg.script.yaml'), 'utf8')

  const first = await store.save(meta('第一版'), MANIFEST, SKILL, 1000)
  assert.deepEqual(first.tasks, [{ id: 'run', title: '运行' }])
  assert.equal(first.replaced, false)
  assert.equal(first.dir, join(data, 'packs', 'tool'))
  assert.match(inUse(), /title: 运行\n/)
  assert.ok(existsSync(join(first.dir, 'SKILL.md')) && !existsSync(join(first.dir, 'draft.json')))
  assert.deepEqual(await store.list(), [], 'nothing left for the user to accept')

  const second = await store.save(meta('第二版'), MANIFEST.replace('运行', '运行二'), SKILL, 2000)
  assert.equal(second.replaced, true)
  assert.match(inUse(), /运行二/)
  const kept = readdirSync(join(data, 'pack-history', 'tool'))
  assert.equal(kept.length, 1, 'the version it replaced is in the history')
  assert.match(readFileSync(join(data, 'pack-history', 'tool', kept[0]!, 'adg.script.yaml'), 'utf8'), /title: 运行\n/)

  await assert.rejects(store.save(meta('坏的'), 'id: tool\nname: Tool\ntasks:\n  - { id: run, title: 运行 }\n', SKILL), /tasks need a launch section/)
  await assert.rejects(store.save(meta('坏的'), MANIFEST, '# no frontmatter'), /frontmatter/)
  assert.match(inUse(), /运行二/, 'the pack in use is as it was')
  assert.equal(readdirSync(join(data, 'pack-history', 'tool')).length, 1)

  // A draft left from before (it waited for the user) is taken over by the save.
  await store.propose(meta('旧草稿'), MANIFEST.replace('运行', '旧的'), SKILL)
  await store.save(meta('第三版'), MANIFEST.replace('运行', '运行三'), SKILL, 3000)
  assert.match(inUse(), /运行三/)
  assert.deepEqual(await store.list(), [])
})

test('a replaced pack can be put back, and putting it back can be undone; a user pack can be dropped for the built-in one', async () => {
  const data = tmp('restore')
  const store = new DraftStore(data)
  const meta = { packId: 'tool', scriptId: 'tool', proposedAt: 1, summary: 's' }
  const inUse = () => readFileSync(join(data, 'packs', 'tool', 'adg.script.yaml'), 'utf8')
  const T = Date.UTC(2026, 10, 13, 4, 30)
  assert.deepEqual(await store.history('tool'), [], 'nothing replaced yet')

  await store.save(meta, MANIFEST.replace('运行', '一'), SKILL, T)
  await store.save(meta, MANIFEST.replace('运行', '二'), SKILL, T + 1000)
  await store.save(meta, MANIFEST.replace('运行', '三'), SKILL, T + 2000)
  const history = await store.history('tool')
  assert.deepEqual(history.map(v => [v.at, /title: (.)/.exec(v.manifest)?.[1]]), [[T + 2000, '二'], [T + 1000, '一']], 'the last replaced first, each with when it was replaced')

  // Back to 二: 三 takes its place in the history.
  await store.restore('tool', history[0]!.id, T + 3000)
  assert.match(inUse(), /title: 二/)
  assert.ok(existsSync(join(data, 'packs', 'tool', 'SKILL.md')), 'the whole pack comes back')
  const after = await store.history('tool')
  assert.deepEqual(after.map(v => [v.at, /title: (.)/.exec(v.manifest)?.[1]]), [[T + 3000, '三'], [T + 1000, '一']])
  // And forward again.
  await store.restore('tool', after[0]!.id, T + 4000)
  assert.match(inUse(), /title: 三/)
  assert.deepEqual((await store.history('tool')).map(v => /title: (.)/.exec(v.manifest)?.[1]), ['二', '一'])

  await assert.rejects(store.restore('tool', '2020-01-01T00-00-00-000Z'), /历史里没有/)
  await assert.rejects(store.restore('tool', '..'), /历史里没有/, 'only a version in its history')
  assert.match(inUse(), /title: 三/, 'a restore that fails changes nothing')

  // A version that no longer fits the schema stays where it is.
  const bad = (await store.history('tool'))[1]!
  writeFileSync(join(data, 'pack-history', 'tool', bad.id, 'adg.script.yaml'), 'id: tool\nname: Tool\ntasks:\n  - { id: run, title: 运行 }\n')
  await assert.rejects(store.restore('tool', bad.id), /tasks need a launch section/)
  assert.match(inUse(), /title: 三/)

  // Dropping the user pack keeps it in the history; with no user pack there is nothing to drop.
  await store.discard('tool', T + 5000)
  assert.ok(!existsSync(join(data, 'packs', 'tool')))
  assert.equal((await store.history('tool'))[0]?.at, T + 5000)
  await assert.rejects(store.discard('tool'), /没有自己写的脚本包/)
  await store.restore('tool', (await store.history('tool'))[0]!.id, T + 6000)
  assert.match(inUse(), /title: 三/, 'and it can come back from there')
})

test('SKILL.md frontmatter becomes a skill registration', () => {
  assert.deepEqual(parseSkill(SKILL, 'fallback'), { name: 'tool', description: '运行 Tool。', content: '# Tool' })
  assert.equal(parseSkill('---\nname: MAA Helper\ndescription: x\n---\nbody', 'maa')?.name, 'maa-helper', 'names are normalized to the skill grammar')
  assert.equal(parseSkill('---\nname: 三月七\ndescription: x\n---\nbody', 'march7th')?.name, 'march7th', 'a non-ASCII name falls back to the pack id')
  assert.equal(parseSkill('---\nname: x\n---\nbody', 'x'), undefined, 'a description is required')
  assert.equal(parseSkill('no frontmatter', 'x'), undefined)
})

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

test('SKILL.md frontmatter becomes a skill registration', () => {
  assert.deepEqual(parseSkill(SKILL, 'fallback'), { name: 'tool', description: '运行 Tool。', content: '# Tool' })
  assert.equal(parseSkill('---\nname: MAA Helper\ndescription: x\n---\nbody', 'maa')?.name, 'maa-helper', 'names are normalized to the skill grammar')
  assert.equal(parseSkill('---\nname: 三月七\ndescription: x\n---\nbody', 'march7th')?.name, 'march7th', 'a non-ASCII name falls back to the pack id')
  assert.equal(parseSkill('---\nname: x\n---\nbody', 'x'), undefined, 'a description is required')
  assert.equal(parseSkill('no frontmatter', 'x'), undefined)
})

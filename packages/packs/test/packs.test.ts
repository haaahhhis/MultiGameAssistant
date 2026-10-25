import { strict as assert } from 'node:assert'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseGameManifest, parseManifest, renderTask } from '@adg/pack-schema'

const DIR = fileURLToPath(new URL('../packs/', import.meta.url))
const load = (id: string) => parseManifest(readFileSync(join(DIR, id, 'adg.script.yaml'), 'utf8'), `${id}/adg.script.yaml`)

test('every built-in pack is valid; its skill is in the skills repository, not shipped', () => {
  for (const id of readdirSync(DIR)) {
    const pack = load(id)
    assert.equal(pack.id, id)
    assert.ok(pack.tasks.length > 0, `${id} has tasks`)
    assert.ok(!existsSync(join(DIR, id, 'SKILL.md')), `${id}/SKILL.md belongs in MultiGameAssistant/skills`)
  }
})

test('MAA daily patches both config generations with the emulator address', () => {
  const run = renderTask(load('maa'), 'daily', {}, { adb: '127.0.0.1:16384', dir: 'D:\\MAA' })
  assert.equal(run.task.success, 'done-log')
  assert.equal(run.task.resources.input, 'adb')
  const values = Object.fromEntries(run.patches.flatMap(p => p.set.map(s => [`${p.file}:${s.path.join('/')}`, s.value])))
  assert.equal(values['config/gui.json:Configurations/Default/Connect.Address'], '127.0.0.1:16384')
  assert.equal(values['config/gui.new.json:Configurations/Default/Gui/ConnectSettings/Address'], '127.0.0.1:16384')
  assert.equal(values['config/gui.new.json:Configurations/Default/Gui/StartUpSettings/RunDirectly'], true)
})

test('MaaEnd runs a named MXU instance; March7th passes its task name', () => {
  assert.deepEqual(renderTask(load('maaend'), 'run-pc', { instance: '配置1' }).args, ['--autostart', '--instance', '配置1', '--quit-after-run'])
  assert.throws(() => renderTask(load('maaend'), 'run-adb'), /需要参数 instance/)
  const m7a = load('march7th')
  assert.deepEqual(renderTask(m7a, 'power').args, ['power'])
  assert.equal(m7a.tasks.find(t => t.id === 'power')?.resources.input, 'desktop')
})

test('log rules classify the scripts\' real messages', () => {
  const classify = (id: string, line: string) => {
    const rule = load(id).logs.rules.find(r => new RegExp(r.match).test(line))
    return rule === undefined ? undefined : `${rule.level}:${rule.tag ?? rule.level}`
  }
  assert.equal(classify('maa', '[2026-10-18 04:32:59][ERR] 重连失败，连接断开！'), 'error:adb-disconnected')
  assert.equal(classify('maa', '模拟器断开，正在尝试重连'), 'warning:adb-reconnecting')
  assert.equal(classify('maa', '任务已全部完成！\n(用时 8 分钟)'), 'done:done')
  assert.equal(classify('maa', '开始任务: 理智作战'), undefined)
  assert.equal(classify('march7th', '2026-10-18 05:00:09 | ERROR | 截图失败：没有找到游戏窗口'), 'warning:script-error')
  assert.equal(classify('march7th', '2026-10-18 05:00:01 | INFO | 开始运行：清体力'), undefined, 'a plain pipe does not match')
  assert.deepEqual(load('maa').recovery.map(r => `${r.on}→${r.do}`), ['adb-disconnected→reconnect-adb', 'adb-disconnected→restart', 'stalled→restart'])
})

test('every built-in game pack is valid and names script packs that exist; its skill is in the skills repository', () => {
  const games = fileURLToPath(new URL('../games/', import.meta.url))
  const scripts = new Set(readdirSync(DIR))
  for (const id of readdirSync(games)) {
    const game = parseGameManifest(readFileSync(join(games, id, 'game.yaml'), 'utf8'), `${id}/game.yaml`)
    assert.equal(game.id, id)
    for (const script of game.scripts) assert.ok(scripts.has(script), `${id} plays ${script}`)
    assert.ok(!existsSync(join(games, id, 'GAME.md')), `${id}/GAME.md belongs in MultiGameAssistant/skills (games/${id}/SKILL.md)`)
  }
  assert.ok(readdirSync(games).length >= 3)
})

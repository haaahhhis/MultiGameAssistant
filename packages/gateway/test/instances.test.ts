import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { clashes, copyLabel, Instances, type CopyRecord } from '../src/instances.ts'

const quiet = { warn: () => {} }

test('the desktop app and the plugin open at once: each sees the other and what clashes; a closed copy is gone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-copies-'))
  let now = 1_000_000
  const alive = new Set([101, 202])
  const make = (pid: number, label: string, dataDir: string) => new Instances({ dir, pid, label, dataDir, now: () => now, alive: p => alive.has(p), log: quiet })
  const desktop = make(101, '桌面版', 'C:\\Users\\a\\AppData\\Local\\MultiGameAssistant\\adg')
  const plugin = make(202, 'dsh 插件版', 'C:\\Users\\a\\.dsh\\adg')
  desktop.fact('feishu', () => 'bot-1')
  desktop.fact('schedules', () => true)
  let pluginBot: string | undefined = 'bot-2'
  plugin.fact('feishu', () => pluginBot)
  plugin.fact('schedules', () => true)

  assert.equal(await desktop.beat(), false, 'alone: nothing to say')
  assert.equal(await plugin.beat(), true)
  assert.deepEqual(plugin.others().map(o => [o.pid, o.label]), [[101, '桌面版']])
  assert.equal(await desktop.beat(), true)
  const seen = desktop.others()[0]!
  assert.equal(seen.label, 'dsh 插件版')
  assert.equal(seen.warnings.length, 2, 'the general warning and the schedules; different bots and data do not clash')
  assert.match(seen.warnings[0]!, /同一时间只开一个/)
  assert.match(seen.warnings[1]!, /定时流水线/)

  pluginBot = 'bot-1'
  await plugin.beat()
  assert.equal(await desktop.beat(), true, 'the same bot set up in the plugin too')
  assert.match(desktop.others()[0]!.warnings.join('\n'), /同一个飞书机器人/)
  assert.equal(await desktop.beat(), false, 'nothing new')

  // The plugin's dsh closes without saying so (crash): its process is gone.
  alive.delete(202)
  assert.equal(await desktop.beat(), true)
  assert.deepEqual(desktop.others(), [])
  assert.ok(!existsSync(join(dir, '202.json')), "a dead copy's file is removed")

  // A copy that stopped writing (a sleeping computer, a hung host) is left out but kept.
  alive.add(303)
  const stale = make(303, '桌面版', 'D:\\other')
  await stale.beat()
  await desktop.beat()
  assert.equal(desktop.others().length, 1)
  now += 4 * 60_000
  await desktop.beat()
  assert.deepEqual(desktop.others(), [])
  assert.ok(existsSync(join(dir, '303.json')))

  await desktop.stop()
  assert.ok(!existsSync(join(dir, '101.json')), 'stopping takes its record away')
})

test('a file that is not a copy, or half written, is skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-copies-'))
  writeFileSync(join(dir, '55.json'), '{"pid": 55, "lab')
  writeFileSync(join(dir, 'notes.txt'), 'hello')
  const self = new Instances({ dir, pid: 1, label: '桌面版', alive: () => true, log: quiet })
  await self.beat()
  assert.deepEqual(self.others(), [])
  assert.deepEqual(readdirSync(dir).sort(), ['1.json', '55.json', 'notes.txt'])
})

test('what clashes: the same data folder (any case), the same bot, schedules on both; and what each copy is called', () => {
  const base: CopyRecord = { pid: 1, label: 'dsh 插件版', dataDir: 'C:\\Users\\a\\.dsh\\adg', startedAt: 0, updatedAt: 0, facts: {} }
  const twin: CopyRecord = { ...base, pid: 2, label: '完整版（dsh 命令行）', dataDir: 'c:\\users\\a\\.dsh\\ADG' }
  const sameData = clashes(base, twin)
  if (process.platform === 'win32') assert.match(sameData.join('\n'), /同一份数据/)
  assert.equal(clashes({ ...base, facts: { schedules: true } }, { ...twin, dataDir: 'D:\\x', facts: { schedules: false } }).length, 1)
  assert.equal(clashes({ ...base, facts: { feishu: 'a' } }, { ...twin, dataDir: 'D:\\x', facts: {} }).length, 1, 'a bot on one side only')
  assert.equal(copyLabel(true, {}), 'dsh 插件版')
  assert.equal(copyLabel(false, { ADG_LAUNCH_COMMAND: '["x"]' }), '桌面版')
  assert.equal(copyLabel(false, {}), '完整版（dsh 命令行）')
})

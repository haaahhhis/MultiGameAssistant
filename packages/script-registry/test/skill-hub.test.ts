import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { extract } from '@adg/installer'
import { makeZip } from '@adg/test-kit'
import { SkillHub } from '../src/skill-hub.ts'

const skill = (name: string, description: string, body = '# 步骤\n') => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`

/** A repository as GitHub zips it: everything under `<repo>-<branch>/`. */
function repoZip(files: Record<string, string>): Buffer {
  return makeZip(Object.fromEntries(Object.entries(files).map(([path, text]) => [`skills-main/${path}`, text])))
}

function setup(taken: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adg-hub-'))
  const state = {
    files: {
      'index.json': JSON.stringify({ skills: [
        { name: 'game-arknights', path: 'games/arknights', kind: 'game', games: ['arknights'] },
        { name: 'maa', path: 'scripts/maa', kind: 'script', scripts: ['maa'], games: ['arknights'] },
        { name: 'sneaky', path: '../outside' },
      ] }),
      'games/arknights/SKILL.md': skill('game-arknights', '明日方舟的活动和进度', '# 明日方舟\n活动页在右上角。\n'),
      'scripts/maa/SKILL.md': skill('maa', 'MAA 的安装与运行'),
    } as Record<string, string>,
    downloads: [] as string[],
    registered: new Map<string, string>(),
    owners: new Map<string, unknown>(),
    clock: 1_000_000,
  }
  const hub = new SkillHub({
    dir,
    download: async (url, dest) => {
      state.downloads.push(url)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, repoZip(state.files))
    },
    extract: async (archive, dest) => { await extract(archive, dest) },
    taken: async () => new Map(Object.entries(taken)),
    register: (name, entry) => { if (entry === undefined) state.registered.delete(name); else { state.registered.set(name, entry.content); state.owners.set(name, entry.owner) } },
    now: () => state.clock,
    log: { info() {}, warn() {} },
  })
  return { hub, dir, state }
}

test('the repository is read as one zip, at most daily; its index says each skill\'s games and scripts', async () => {
  const { hub, state } = setup({ maa: '内置技能' })
  const first = await hub.list()
  assert.deepEqual(state.downloads, ['https://codeload.github.com/MultiGameAssistant/skills/zip/refs/heads/main'])
  assert.deepEqual(first.items.map(i => i.name), ['game-arknights', 'maa'], 'a path leaving the repository is ignored')
  const ak = first.items[0]!
  assert.equal(ak.kind, 'game')
  assert.deepEqual(ak.games, ['arknights'])
  assert.equal(ak.description, '明日方舟的活动和进度', 'the description comes from the SKILL.md')
  assert.equal(first.items[1]!.blocked, '已有同名的内置技能')
  await hub.list()
  assert.equal(state.downloads.length, 1, 'read once a day')
  state.clock += 25 * 60 * 60_000
  await hub.list()
  assert.equal(state.downloads.length, 2)
  await hub.list({ refresh: true })
  assert.equal(state.downloads.length, 3)
  await assert.rejects(hub.install('maa'), /已有同名的内置技能/)
})

test('downloaded and updated: an update takes the repository version, changed here or not; removing forgets it', async () => {
  const { hub, dir, state } = setup()
  const item = await hub.install('game-arknights')
  assert.deepEqual(item.installed && { update: item.installed.update }, { update: false })
  const file = join(dir, 'skills', 'game-arknights', 'SKILL.md')
  assert.match(readFileSync(file, 'utf8'), /活动页在右上角/)
  assert.match(state.registered.get('game-arknights') ?? '', /活动页在右上角/, 'registered with the agents')
  assert.deepEqual(state.owners.get('game-arknights'), { games: ['arknights'] }, 'only for the sessions working on its game (skill isolation)')
  assert.ok(!existsSync(join(dir, 'base')), 'no copy kept for merging')

  // A new version, nothing changed here: replaced.
  state.files['games/arknights/SKILL.md'] = skill('game-arknights', '明日方舟的活动和进度', '# 明日方舟\n活动页在右上角。\n商店在左下。\n')
  let listed = (await hub.list({ refresh: true })).items.find(i => i.name === 'game-arknights')!
  assert.equal(listed.installed?.update, true)
  assert.equal((await hub.update('game-arknights')).state, 'updated')
  assert.match(readFileSync(file, 'utf8'), /商店在左下/)
  assert.equal((await hub.update('game-arknights')).state, 'current')

  // Changed here, and the repository changes again: still replaced.
  writeFileSync(file, readFileSync(file, 'utf8') + '我的账号在 B 服。\n')
  listed = (await hub.list()).items.find(i => i.name === 'game-arknights')!
  assert.equal(listed.installed?.update, false, 'a change here is not a new version')
  state.files['games/arknights/SKILL.md'] = skill('game-arknights', '明日方舟的活动和进度', '# 明日方舟\n活动页在右上角。\n商店在左下。\n任务在主页。\n')
  listed = (await hub.list({ refresh: true })).items.find(i => i.name === 'game-arknights')!
  assert.equal(listed.installed?.update, true)
  assert.equal((await hub.update('game-arknights')).state, 'updated')
  const now = readFileSync(file, 'utf8')
  assert.match(now, /任务在主页/)
  assert.doesNotMatch(now, /B 服/)
  assert.match(state.registered.get('game-arknights') ?? '', /任务在主页/, 'the agents see the new version')

  await hub.remove('game-arknights')
  assert.ok(!existsSync(join(dir, 'skills', 'game-arknights')))
  assert.equal(state.registered.has('game-arknights'), false)
  assert.equal((await hub.list()).items.find(i => i.name === 'game-arknights')?.installed, undefined)
})

test('a repository without index.json: every SKILL.md is a skill; one that cannot be read keeps what was read before', async () => {
  const { hub, state } = setup()
  state.files = { 'general/notes/SKILL.md': skill('notes', '通用的记录方法'), 'README.md': '# skills' }
  assert.deepEqual((await hub.list()).items.map(i => [i.name, i.path, i.kind]), [['notes', 'general/notes', 'general']])
  const { hub: offline } = setup()
  await offline.list()
  // Started again with GitHub unreachable a day later: the copy read before still answers, and says why.
  const again = new SkillHub({
    dir: (offline as unknown as { skillsDir: string }).skillsDir.replace(/[\\/]skills$/, ''),
    download: async () => { throw new Error('连不上 GitHub') },
    extract: async () => {},
    taken: async () => new Map(),
    register: () => {},
    now: () => 1_000_000 + 2 * 24 * 60 * 60_000,
    log: { info() {}, warn() {} },
  })
  const listed = await again.list()
  assert.deepEqual(listed.items.map(i => i.name), ['game-arknights', 'maa'])
  assert.match(listed.errors[0] ?? '', /连不上 GitHub/)
})

test('a downloaded skill picked for the wrong game or script can be put under others, kept across updates, or given back to the repository', async () => {
  const { hub, state } = setup()
  await hub.install('maa')
  assert.deepEqual(state.owners.get('maa'), { games: ['arknights'], scripts: ['maa'] })
  await hub.setOwner('maa', { scripts: ['maa-cn'], games: [] })
  assert.deepEqual(state.owners.get('maa'), { scripts: ['maa-cn'] })
  state.files['scripts/maa/SKILL.md'] = skill('maa', 'MAA 的安装与运行', '# v2\n')
  await hub.list({ refresh: true })
  assert.equal((await hub.update('maa')).state, 'updated')
  assert.deepEqual(state.owners.get('maa'), { scripts: ['maa-cn'] }, 'an update keeps where the user put it')
  await hub.setOwner('maa', { games: [], scripts: [] })
  assert.equal(state.owners.get('maa'), undefined, 'nothing chosen: general')
  await hub.setOwner('maa', null)
  assert.deepEqual(state.owners.get('maa'), { games: ['arknights'], scripts: ['maa'] }, "back to the repository's")
  await assert.rejects(hub.setOwner('game-arknights', null), /没有从技能库下载过/)
})

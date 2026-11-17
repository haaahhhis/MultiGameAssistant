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

function setup(taken: Record<string, string> = {}, app: { version?: string } = {}) {
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
    appVersion: () => app.version,
    log: { info() {}, warn() {} },
  })
  return { hub, dir, state, app }
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

test('a skill is its whole folder: a changed script is a new version, shown with the index version and changes; the replaced one can be gone back to', async () => {
  const { hub, dir, state } = setup()
  const index = (version: string, changes: string) => JSON.stringify({ skills: [{ name: 'maa', path: 'scripts/maa', kind: 'script', scripts: ['maa'], version, changes }] })
  state.files['index.json'] = index('1.0.0', '第一版')
  state.files['scripts/maa/scripts/run.py'] = 'print("v1")\n'
  const first = await hub.install('maa')
  assert.equal(first.version, '1.0.0')
  assert.equal(first.installed?.version, '1.0.0')
  const script = join(dir, 'skills', 'maa', 'scripts', 'run.py')
  assert.match(readFileSync(script, 'utf8'), /v1/, 'the files beside SKILL.md come too')

  // Only the script changes: still a new version.
  state.files['index.json'] = index('1.1.0', '运行器修好了截图')
  state.files['scripts/maa/scripts/run.py'] = 'print("v2")\n'
  let listed = (await hub.list({ refresh: true })).items.find(i => i.name === 'maa')!
  assert.equal(listed.installed?.update, true, 'a change beside SKILL.md is a new version')
  assert.equal(listed.version, '1.1.0')
  assert.equal(listed.changes, '运行器修好了截图')
  assert.equal(listed.installed?.version, '1.0.0', 'what is here')
  assert.equal((await hub.update('maa')).state, 'updated')
  assert.match(readFileSync(script, 'utf8'), /v2/)
  listed = (await hub.list()).items.find(i => i.name === 'maa')!
  assert.deepEqual(listed.installed?.previous, { version: '1.0.0', at: 1_000_000 }, 'the replaced version is kept')

  // Back: the old files, and the newer version is not offered again…
  const back = await hub.rollback('maa')
  assert.match(readFileSync(script, 'utf8'), /v1/)
  assert.equal(back.installed?.version, '1.0.0')
  assert.equal(back.installed?.update, false)
  assert.equal(back.installed?.held, true)
  assert.equal(back.installed?.previous, undefined)
  assert.match(state.registered.get('maa') ?? '', /步骤/, 'registered again')
  await assert.rejects(hub.rollback('maa'), /没有上一个版本/)
  // …until the repository has another; updating by hand still takes the held one.
  assert.equal((await hub.update('maa')).state, 'updated')
  assert.match(readFileSync(script, 'utf8'), /v2/)
  await hub.rollback('maa')
  state.files['scripts/maa/scripts/run.py'] = 'print("v3")\n'
  listed = (await hub.list({ refresh: true })).items.find(i => i.name === 'maa')!
  assert.equal(listed.installed?.update, true)
  assert.equal(listed.installed?.held, undefined, 'held only while the repository still has the version gone back from')
  await hub.remove('maa')
  assert.ok(!existsSync(join(dir, 'previous', 'maa')), 'removing forgets the kept version too')
})

test('requires: on an older app a skill is not downloaded or updated, and says why', async () => {
  const { hub, state, app } = setup({}, { version: '2.0.5' })
  state.files['index.json'] = JSON.stringify({ skills: [{ name: 'maa', path: 'scripts/maa', scripts: ['maa'], version: '2.0.0', requires: '>=2.1.0' }] })
  let item = (await hub.list()).items.find(i => i.name === 'maa')!
  assert.match(item.incompatible ?? '', /需要软件版本 >=2.1.0（现在是 2.0.5）/)
  await assert.rejects(hub.install('maa'), /需要软件版本/)
  app.version = '2.1.0'
  await hub.install('maa')
  // A newer version for a newer app: offered, not taken.
  state.files['index.json'] = JSON.stringify({ skills: [{ name: 'maa', path: 'scripts/maa', scripts: ['maa'], version: '3.0.0', requires: '>=3.0.0' }] })
  state.files['scripts/maa/SKILL.md'] = skill('maa', 'MAA 的安装与运行', '# v3\n')
  item = (await hub.list({ refresh: true })).items.find(i => i.name === 'maa')!
  assert.equal(item.installed?.update, true)
  assert.match(item.incompatible ?? '', /3.0.0/)
  await assert.rejects(hub.update('maa'), /需要软件版本/)
  // Run from source (no version): anything goes.
  app.version = undefined
  assert.equal((await hub.update('maa')).state, 'updated')
})

test('downloads recorded before folders were fingerprinted are fingerprinted as they are, not shown as new', async () => {
  const { hub, dir, state } = setup()
  await hub.install('game-arknights')
  // As an older app recorded it: the SKILL.md alone.
  const file = join(dir, 'state.json')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  saved.installed['game-arknights'] = { repo: saved.installed['game-arknights'].repo, path: 'games/arknights', hash: 'skill-md-only', at: 5 }
  writeFileSync(file, JSON.stringify(saved))
  const again = new SkillHub({
    dir, download: async (url, dest) => { state.downloads.push(url); await mkdir(dirname(dest), { recursive: true }); await writeFile(dest, repoZip(state.files)) },
    extract: async (archive, dest) => { await extract(archive, dest) }, taken: async () => new Map(), register: () => {}, now: () => state.clock, log: { info() {}, warn() {} },
  })
  const before = state.downloads.length
  const item = (await again.list()).items.find(i => i.name === 'game-arknights')!
  assert.equal(item.installed?.update, false)
  assert.equal(state.downloads.length, before + 1, 'the repository is read again for the new fingerprints')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).installed['game-arknights'].folder, true)
})

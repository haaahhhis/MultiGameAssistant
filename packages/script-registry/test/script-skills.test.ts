import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { importedSkills, importSkill, importUnchanged, userSkills, type SkillSaveDeps } from '@adg/gateway'
import type { ScriptLibrary } from '../src/library.ts'
import { ScriptIntegrations, type SkillKeeper } from '../src/script-integrations.ts'
import { ScriptMcp } from '../src/mcp.ts'
import { discoverSkills } from '../src/script-skills.ts'

const skill = (name: string, description: string, body = '# 步骤\n') => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

/** A script in the library (only what the integrations read), and this app's skills folder behind a keeper. */
function setup(taken: string[] = []) {
  const scriptDir = mkdtempSync(join(tmpdir(), 'adg-script-'))
  const skillsDir = mkdtempSync(join(tmpdir(), 'adg-skills-'))
  const script = { id: 'demo', name: '演示脚本', dir: scriptDir, current: '1.0.0' }
  const library = { get: () => script, packOf: () => undefined } as unknown as ScriptLibrary
  const saved: string[] = []
  const deps: SkillSaveDeps = { dir: skillsDir, taken: async () => taken, saved: async name => { saved.push(name) } }
  const keeper: SkillKeeper = {
    importSkill: input => importSkill(deps, input),
    importedSkills: async () => (await importedSkills(skillsDir)).map(item => ({ ...item, changed: false })),
  }
  const integrations = new ScriptIntegrations(library, new ScriptMcp({ dataDir: skillsDir }), () => keeper, { info() {}, warn() {} })
  return { scriptDir, skillsDir, script, integrations, saved, keeper, deps }
}

test('a script\'s skills are found where agents keep them', async () => {
  const { scriptDir } = setup()
  write(scriptDir, {
    'skills/daily/SKILL.md': skill('daily-run', '每天的清单怎么跑'),
    'skills/daily/scripts/check.ps1': 'Get-Process',
    '.claude/skills/Fix Errors/SKILL.md': skill('Fix Errors', '常见报错怎么处理'),
    '.agents/skills/group/nested/SKILL.md': skill('nested', '嵌套的技能'),
    'skills/broken/SKILL.md': '# no frontmatter',
    'SKILL.md': skill('whole-script', '整个脚本的说明'),
    'README.md': '# not a skill',
  })
  const found = await discoverSkills(scriptDir)
  assert.deepEqual(found.map(s => [s.name, s.path, s.single]), [
    ['broken', 'skills/broken', false],
    ['daily-run', 'skills/daily', false],
    ['fix-errors', '.claude/skills/Fix Errors', false],
    ['nested', '.agents/skills/group/nested', false],
    ['whole-script', 'SKILL.md', true],
  ])
  assert.match(found[0]!.problem ?? '', /frontmatter/)
  assert.equal(found[1]!.description, '每天的清单怎么跑')
})

test('imported skills are this app\'s, belong to the script, and follow its updates unless changed here', async () => {
  const { scriptDir, skillsDir, script, integrations, saved } = setup(['fix-errors'])
  write(scriptDir, {
    'skills/daily/SKILL.md': skill('daily-run', '每天的清单怎么跑', '# 第一版\n'),
    'skills/daily/ref.md': '参考',
    'skills/daily/node_modules/x.js': 'skip me',
    '.claude/skills/fix/SKILL.md': skill('fix-errors', '常见报错怎么处理'),
  })
  const first = await integrations.importSkills('demo')
  assert.deepEqual(first.skipped, [])
  assert.deepEqual(first.imported.map(i => [i.skill, i.name, i.replaced]), [['daily-run', 'daily-run', false], ['fix-errors', 'demo-fix-errors', false]], 'a name taken elsewhere gets the script\'s prefix')
  assert.deepEqual(saved, ['daily-run', 'demo-fix-errors'], 'registered for the agents at once')

  // The copy is a skill of the skills folder, seen only for this script.
  const mine = await userSkills(skillsDir)
  const daily = mine.find(s => s.name === 'daily-run')!
  assert.deepEqual(daily.owner, { scripts: ['demo'] })
  assert.equal(daily.description, '每天的清单怎么跑')
  assert.match(daily.content, /第一版/)
  assert.equal(readFileSync(join(skillsDir, 'daily-run', 'ref.md'), 'utf8'), '参考', 'the whole folder is copied')
  assert.throws(() => readFileSync(join(skillsDir, 'daily-run', 'node_modules', 'x.js')))

  const listed = await integrations.skills('demo')
  assert.deepEqual(listed.map(s => [s.name, s.imported?.name, s.imported?.current]), [['daily-run', 'daily-run', true], ['fix-errors', 'demo-fix-errors', true]])

  // The script updates and its skill changes: taken again.
  script.current = '1.1.0'
  write(scriptDir, { 'skills/daily/SKILL.md': skill('daily-run', '每天的清单怎么跑', '# 第二版\n') })
  assert.equal((await integrations.skills('demo'))[0]!.imported?.current, false, 'shown as having a newer version')
  assert.deepEqual(await integrations.syncSkills('demo'), ['daily-run'])
  assert.match((await userSkills(skillsDir)).find(s => s.name === 'daily-run')!.content, /第二版/)
  assert.deepEqual(await integrations.syncSkills('demo'), [], 'nothing new: nothing taken')
  const records = await importedSkills(skillsDir)
  assert.equal(records.find(r => r.name === 'daily-run')!.origin['version'], '1.1.0')
})

test('a copy changed here is not replaced by the script\'s update', async () => {
  const { scriptDir, skillsDir, deps } = setup()
  write(scriptDir, { 'skills/daily/SKILL.md': skill('daily-run', '每天的清单怎么跑', '# 第一版\n') })
  const keeper: SkillKeeper = {
    importSkill: input => importSkill(deps, input),
    importedSkills: async () => Promise.all((await importedSkills(skillsDir)).map(async item => ({ ...item, changed: !(await importUnchanged(skillsDir, item)) }))),
  }
  const library = { get: () => ({ id: 'demo', name: '演示脚本', dir: scriptDir }), packOf: () => undefined } as unknown as ScriptLibrary
  const integrations = new ScriptIntegrations(library, new ScriptMcp({ dataDir: skillsDir }), () => keeper, { info() {}, warn() {} })
  await integrations.importSkills('demo')
  writeFileSync(join(skillsDir, 'daily-run', 'SKILL.md'), skill('daily-run', '我改过的', '# 我的版本\n'))
  write(scriptDir, { 'skills/daily/SKILL.md': skill('daily-run', '每天的清单怎么跑', '# 第二版\n') })
  assert.deepEqual(await integrations.syncSkills('demo'), [])
  assert.match(readFileSync(join(skillsDir, 'daily-run', 'SKILL.md'), 'utf8'), /我的版本/)
  const listed = await integrations.skills('demo')
  assert.deepEqual(listed[0]!.imported, { name: 'daily-run', current: false, changed: true })
  // Asked for, it is taken again anyway.
  assert.deepEqual((await integrations.importSkills('demo', ['daily-run'])).imported.map(i => [i.name, i.replaced]), [['daily-run', true]])
})

test('a skill named like one of the user\'s own is not overwritten', async () => {
  const { scriptDir, skillsDir, integrations } = setup()
  write(skillsDir, { 'daily-run/SKILL.md': skill('daily-run', '用户自己的') })
  write(scriptDir, { 'skills/daily/SKILL.md': skill('daily-run', '每天的清单怎么跑') })
  const { imported } = await integrations.importSkills('demo')
  assert.deepEqual(imported.map(i => i.name), ['demo-daily-run'])
  assert.match(readFileSync(join(skillsDir, 'daily-run', 'SKILL.md'), 'utf8'), /用户自己的/)
})

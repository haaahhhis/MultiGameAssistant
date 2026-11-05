import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { removeSkill, saveSkill, userSkills } from '../src/skill-save.ts'

const SKILL = { name: 'maa-check', description: 'MAA 跑完后检查理智和基建都处理了。', content: '1. 打开日志\n2. 找「任务完成」\n3. 没有就重跑一次' }

test('a skill made on the 技能 page is written for its script, changed only with replace, and deleted with its folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-skills-'))
  const registered: string[] = []
  const deps = { dir, taken: async () => ['web-reading'], saved: async (name: string) => { registered.push(name) } }
  assert.deepEqual(await saveSkill(deps, { ...SKILL, scripts: ['maa'] }), { saved: join(dir, 'maa-check', 'SKILL.md'), replaced: false })
  assert.deepEqual(registered, ['maa-check'])
  const [saved] = await userSkills(dir)
  assert.deepEqual(saved?.owner, { scripts: ['maa'] })
  assert.equal(saved?.description, SKILL.description)

  await assert.rejects(saveSkill(deps, { ...SKILL, description: '另一个说明，十个字以上。' }), /已经有技能/)
  assert.equal((await saveSkill(deps, { ...SKILL, description: '另一个说明，十个字以上。', replace: true })).replaced, true)
  assert.equal((await userSkills(dir))[0]?.owner, undefined, 'no script now: a general skill')
  await assert.rejects(saveSkill(deps, { ...SKILL, name: 'web-reading' }), /软件自带/)
  await assert.rejects(saveSkill(deps, { ...SKILL, name: '中文名' }), /参数无效/)

  assert.equal(await removeSkill(dir, '../outside'), false, 'only a skill name')
  assert.equal(await removeSkill(dir, 'nothing-here'), false)
  assert.equal(await removeSkill(dir, 'maa-check'), true)
  assert.equal(existsSync(join(dir, 'maa-check')), false)
})

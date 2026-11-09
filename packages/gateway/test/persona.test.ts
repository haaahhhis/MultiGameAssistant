import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PersonaStore, personaOf, personaPrompt } from '../src/persona.ts'
import { teamPrompt } from '../src/roles.ts'

test('the persona becomes one prompt section, nothing at all by default, and always keeps the rules', () => {
  assert.equal(personaPrompt({ style: 'default' }), '')
  const text = personaPrompt({ style: 'butler', name: '小助', callUser: '博士', custom: '汇报时先说有没有失败' })
  assert.match(text, /^# 回复风格\n你的名字是「小助」/)
  assert.match(text, /称呼用户为「博士」/)
  assert.match(text, /管家/)
  assert.match(text, /用户对你说话方式的要求：汇报时先说有没有失败/)
  assert.match(text, /不改变做事的规则/)
  assert.match(text, /（不用告诉用户）/, 'the fixed marks are written as they are')
})

test('other agents get plain words unless the user wants the voice kept', () => {
  assert.match(personaPrompt({ style: 'lively' }), /和其他 agent 说话.*用平实的话/)
  assert.match(personaPrompt({ style: 'lively', peerStyle: 'plain' }), /用平实的话/)
  const same = personaPrompt({ style: 'lively', peerStyle: 'same' })
  assert.match(same, /和其他 agent 说话时也用这个方式/)
  assert.doesNotMatch(same, /用平实的话/)
  assert.equal(personaPrompt({ style: 'default', peerStyle: 'same' }), '', 'no voice, nothing to keep')
})

test("an agent's own settings go over the shared ones, field by field; a name is only ever its own", () => {
  const settings = { persona: { style: 'butler' as const, callUser: '博士' }, agents: { main: { name: '小满' }, scripts: { style: 'lively' as const } } }
  assert.deepEqual(personaOf(settings, 'games'), { style: 'butler', callUser: '博士' })
  assert.deepEqual(personaOf(settings, 'main'), { style: 'butler', callUser: '博士', name: '小满' })
  assert.deepEqual(personaOf(settings, 'scripts'), { style: 'lively', callUser: '博士' })
  assert.doesNotMatch(personaPrompt(personaOf(settings, 'scripts')), /小满/)
  assert.match(personaPrompt(personaOf(settings, 'scripts')), /活泼/)
  assert.doesNotMatch(personaPrompt(personaOf(settings, 'scripts')), /管家/)
})

test('the store keeps what was set: blanks dropped, spaces trimmed, an emptied agent gone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-persona-'))
  const store = new PersonaStore(dir)
  await store.set({ persona: { style: 'lively', callUser: ' 指挥官 ', custom: '  ' }, agents: { main: { name: '  ' }, games: { name: ' 小游 ', custom: '' }, intervene: { style: 'concise' } } })
  const again = new PersonaStore(dir)
  await again.load()
  assert.deepEqual(again.current, { persona: { style: 'lively', callUser: '指挥官' }, agents: { games: { name: '小游' }, intervene: { style: 'concise' } } })
  assert.equal(again.of('games').name, '小游')
})

test('a file from before agents had their own reads as the shared one, and its name is 助手\'s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-persona-'))
  writeFileSync(join(dir, 'persona.json'), JSON.stringify({ style: 'butler', name: '小满', callUser: '博士' }))
  const store = new PersonaStore(dir)
  await store.load()
  assert.deepEqual(store.current, { persona: { style: 'butler', callUser: '博士' }, agents: { main: { name: '小满' } } })
  assert.match(personaPrompt(store.of('main')), /你的名字是「小满」/)
  assert.doesNotMatch(personaPrompt(store.of('scripts')), /小满/)
})

test('a file that makes no sense is the default, not a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-persona-'))
  writeFileSync(join(dir, 'persona.json'), '{"style":"nonsense"}')
  const store = new PersonaStore(dir)
  await store.load()
  assert.deepEqual(store.current, { persona: { style: 'default' }, agents: {} })
})

test('an agent named by the user is still addressed by its id', () => {
  const main = { id: 'main', name: '助手', description: '', alias: '小满' }
  const scripts = { id: 'scripts', name: '脚本', description: '装脚本', alias: '小脚' }
  const text = teamPrompt({ id: 'games', name: '游戏', description: '' }, main, [scripts])
  assert.match(text, /上级是「助手」（main，用户也叫它「小满」）/)
  assert.match(text, /- 「脚本」（scripts，用户也叫它「小脚」）：装脚本/)
})

import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PersonaStore, personaPrompt } from '../src/persona.ts'

test('the persona becomes one prompt section, nothing at all by default, and always keeps the rules', async () => {
  assert.equal(personaPrompt({ style: 'default' }), '')
  const text = personaPrompt({ style: 'butler', name: '小助', callUser: '博士', custom: '汇报时先说有没有失败' })
  assert.match(text, /^# 回复风格\n你的名字是「小助」/)
  assert.match(text, /称呼用户为「博士」/)
  assert.match(text, /管家/)
  assert.match(text, /用户对你说话方式的要求：汇报时先说有没有失败/)
  assert.match(text, /不改变做事的规则/)
  const dir = mkdtempSync(join(tmpdir(), 'adg-persona-'))
  const store = new PersonaStore(dir)
  await store.set({ style: 'lively', name: '  ', callUser: ' 指挥官 ' })
  const again = new PersonaStore(dir)
  await again.load()
  assert.deepEqual(again.current, { style: 'lively', callUser: '指挥官' }, 'blank fields are dropped, spaces trimmed')
})

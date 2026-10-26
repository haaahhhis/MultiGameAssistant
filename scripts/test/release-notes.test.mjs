import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { cleanNotes, draftNotes, listChanges, previousTag } from '../lib/release-notes.mjs'

const TAGS = ['v0.6.0-beta.5', 'v1.0.0-rc.1', 'v1.0.0-rc.3', 'v1.0.0-rc.2', 'v0.5.0', 'not-a-version']

test('a pre-release follows the version before it; a stable version the previous stable one', () => {
  assert.equal(previousTag(TAGS, '1.0.0-rc.4'), 'v1.0.0-rc.3')
  assert.equal(previousTag(TAGS, '1.0.0'), 'v0.5.0')
  assert.equal(previousTag(TAGS, '1.0.0-rc.2'), 'v1.0.0-rc.1')
  assert.equal(previousTag([], '1.0.0'), undefined)
})

test('feat and fix commits are listed under their sections, oldest first; other kinds are not', () => {
  const notes = listChanges([
    'feat: check GitHub Releases for updates',
    'ci: publish only the installers',
    'fix(installer): carry every package dsh needs',
    'feat!: a breaking one',
    'Merge branch main',
    'test: commit the sample logs',
  ])
  assert.equal(notes, '## 新功能\n\n- check GitHub Releases for updates\n- a breaking one\n\n## 修复\n\n- carry every package dsh needs\n')
  assert.equal(listChanges(['ci: x', 'chore: y']), '')
})

test('the draft\'s instructions are removed; an emptied draft means cancel', () => {
  const draft = draftNotes({ version: '1.0.0-rc.4', previous: 'v1.0.0-rc.3', subjects: ['fix: a bug'] })
  assert.match(draft, /v1\.0\.0-rc\.3 之后/)
  assert.equal(cleanNotes(draft), '## 修复\n\n- a bug')
  assert.equal(cleanNotes(draft.replace(/^## [\s\S]*$/m, '').replace('- a bug', '')), '')
  assert.match(draftNotes({ version: '1.0.1', previous: undefined, subjects: ['ci: x'] }), /没有 feat 或 fix 提交/)
  assert.equal(cleanNotes('<!--\r\nnote\r\n-->\r\n\r\n修好了。\r\n'), '修好了。')
})

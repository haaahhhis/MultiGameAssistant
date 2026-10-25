import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { areaOf } from '@adg/protocol'
import { Permissions } from '../src/permissions.ts'

test('each area keeps its own policy on top of the mode, saved and read back; unknown ones are dropped', async () => {
  assert.equal(areaOf('pipeline_draft')?.id, 'pipelines-edit')
  assert.equal(areaOf('screen_capture'), undefined, 'a screenshot is in no area')
  const file = join(mkdtempSync(join(tmpdir(), 'adg-perm-')), 'permissions.json')
  const permissions = new Permissions(file)
  await permissions.load()
  assert.equal(permissions.policyFor('script_install'), 'default')
  await permissions.setArea('scripts-install', 'deny')
  await permissions.setArea('screen', 'ask')
  await permissions.set('full', 1)
  assert.equal(permissions.policyFor('script_update'), 'deny')
  assert.equal(permissions.policyFor('screen_tap'), 'ask')
  assert.equal(permissions.policyFor('game_record'), 'default')
  await assert.rejects(permissions.setArea('nope', 'allow'), /没有这个权限范围/)

  await permissions.setArea('screen', 'default')
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { mode: string; areas: Record<string, string> }
  assert.deepEqual(saved, { mode: 'full', since: 1, areas: { 'scripts-install': 'deny' } })

  writeFileSync(file, JSON.stringify({ mode: 'ask', areas: { web: 'allow', gone: 'deny', run: 'sometimes' } }))
  const again = new Permissions(file)
  await again.load()
  assert.deepEqual(again.state().areas, { web: 'allow' })
  assert.equal(again.mode, 'ask')
})

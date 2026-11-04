import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseManifest } from '@adg/pack-schema'
import { scriptCdk } from '../src/library.ts'

const pack = (files: string) => ({ dir: '', builtin: true, manifest: parseManifest(`id: tool\nname: Tool\nconfig:\n  files:\n${files}`) })

test('the Mirror酱 CDK a script keeps in its own settings is found; an expiry time or an empty one is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-cdk-'))
  mkdirSync(join(dir, 'config'))
  writeFileSync(join(dir, 'config', 'gui.json'), '{"Global": {"VersionUpdate.MirrorChyanCdkExpiredTime": 1824382315, "VersionUpdate.MirrorChyanCdk": "abcDEF123456"}}')
  assert.equal(await scriptCdk(pack('    - { path: config/gui.json, format: json }'), dir), 'abcDEF123456')

  writeFileSync(join(dir, 'config.yaml'), 'mirrorchyan_cdk: ""\nother: 12345678\n')
  assert.equal(await scriptCdk(pack('    - { path: config.yaml, format: yaml }'), dir), undefined)
  writeFileSync(join(dir, 'config.yaml'), 'theme: dark\nmirrorchyan_cdk: zzzz1111\n')
  assert.equal(await scriptCdk(pack('    - { path: config.yaml, format: yaml }\n    - { path: missing.ini, format: ini }'), dir), 'zzzz1111')
})

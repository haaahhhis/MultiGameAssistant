import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DSH_RANGE, KEPT_VERSION, NAME, PLUGIN_DIR, peerRange, pluginManifest, pluginPatch, pluginsOf } from '../lib/plugin-manifest.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = path => readFileSync(join(root, ...path.split('/')), 'utf8').replace(/\r\n/g, '\n')
const bundlePatch = read('packages/bundle/cordis.patch.yml')
const kept = JSON.parse(read(`${PLUGIN_DIR}/package.json`))

test('the kept patch is the one the package publishes, made from the bundle\'s: run pnpm package:plugin --sync when this fails', () => {
  assert.equal(read(`${PLUGIN_DIR}/cordis.patch.yml`), pluginPatch(bundlePatch))
})

test('the kept package.json is the published one, but for the version (peers are checked when the package is made)', () => {
  assert.deepEqual(kept, pluginManifest({ version: KEPT_VERSION, plugins: pluginsOf(bundlePatch), peers: Object.keys(kept.peerDependencies) }))
  assert.equal(kept.name, NAME)
  // What the plugin catalogs read to call it installable: a bundle, with its patch beside it.
  assert.equal(kept.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(existsSync(join(root, ...PLUGIN_DIR.split('/'), 'cordis.patch.yml')))
})

test("dsh's own packages are asked for in dsh's range, pre-releases included; the others as any version", () => {
  assert.equal(peerRange('@deepseek-ai/dsh-credentials'), DSH_RANGE)
  assert.equal(peerRange('@deepseek-ai/cordis'), '*')
  for (const [name, range] of Object.entries(kept.peerDependencies)) assert.equal(range, peerRange(name), name)
})

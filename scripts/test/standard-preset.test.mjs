import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { currentBlock, standardOverride, upstreamStandard } from '../lib/standard-preset.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

test("the bundle's standard preset is dsh's own, with compaction from the app's settings", () => {
  const block = currentBlock(readFileSync(join(root, 'packages', 'bundle', 'cordis.patch.yml'), 'utf8'))
  assert.ok(block !== undefined, 'packages/bundle/cordis.patch.yml has no preset-standard override: run node scripts/sync-standard-preset.mjs')
  assert.equal(block, standardOverride(upstreamStandard(root)), 'dsh changed its standard preset: run node scripts/sync-standard-preset.mjs and check the diff')
})

test('the settings expressions read compaction.json and fall back to dsh\'s defaults', () => {
  const block = standardOverride(upstreamStandard(root))
  const expression = key => new RegExp(`${key}: !!js "(.+)"$`, 'm').exec(block)?.[1]
  const evaluate = (source, files) => {
    const process = { env: {}, getBuiltinModule: () => ({ readFileSync: path => { if (files[path] === undefined) throw new Error('ENOENT'); return files[path] } }) }
    return new Function('process', 'dshHomePath', `return ${source}`)(process, sub => `/home/${sub}`)
  }
  const file = '/home/adg/data/compaction.json'
  assert.equal(evaluate(expression('auto'), {}), true)
  assert.equal(evaluate(expression('thresholdRatio'), {}), 0.8)
  assert.equal(evaluate(expression('auto'), { [file]: '{"auto":false,"threshold":60}' }), false)
  assert.equal(evaluate(expression('thresholdRatio'), { [file]: '{"auto":false,"threshold":60}' }), 0.6)
  assert.equal(evaluate(expression('thresholdRatio'), { [file]: '{"threshold":20}' }), 0.5)
  assert.equal(evaluate(expression('auto'), { [file]: 'not json' }), true)
})

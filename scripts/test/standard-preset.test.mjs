import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { currentBlock, PRESETS, presetOverride, standardOverride, upstreamPreset, upstreamStandard } from '../lib/standard-preset.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const patch = readFileSync(join(root, 'packages', 'bundle', 'cordis.patch.yml'), 'utf8')

test("the bundle's presets are dsh's own, with compaction from the app's settings", () => {
  for (const id of PRESETS) {
    const block = currentBlock(patch, id)
    assert.ok(block !== undefined, `packages/bundle/cordis.patch.yml has no preset-${id} override: run node scripts/sync-standard-preset.mjs`)
    assert.equal(block, presetOverride(upstreamPreset(root, id), id), `dsh changed its ${id} preset: run node scripts/sync-standard-preset.mjs and check the diff`)
  }
})

test("standard's sub-agents start under ptc, whose tools are called from run_code; ptc's own sub-agents are left as dsh has them", () => {
  const standard = standardOverride(upstreamStandard(root))
  const ptc = presetOverride(upstreamPreset(root, 'ptc'), 'ptc')
  assert.equal(standard.match(/agentPreset:/g)?.length, 1, 'once, on the spawn row')
  assert.match(standard, /name: '@deepseek-ai\/dsh-tool-subagent'\n\s+config:\n\s+# .+\n\s+agentPreset: !!js ".+"\n\s+provider: spawn\n/)
  assert.doesNotMatch(ptc, /agentPreset:/)
  assert.match(ptc, /name: '@deepseek-ai\/dsh-tool-executor-ptc'/)
  assert.match(ptc, /name: '@adg\/gateway\/low-context'/, 'the same compaction rows')
})

const expression = (block, key) => new RegExp(`${key}: !!js "(.+)"$`, 'm').exec(block)?.[1]
const evaluate = (source, files) => {
  const process = { env: {}, getBuiltinModule: () => ({ readFileSync: path => { if (files[path] === undefined) throw new Error('ENOENT'); return files[path] } }) }
  return new Function('process', 'dshHomePath', `return ${source}`)(process, sub => `/home/${sub}`)
}
const file = '/home/adg/data/compaction.json'

test('the settings expressions read compaction.json and fall back to dsh\'s defaults', () => {
  const block = standardOverride(upstreamStandard(root))
  assert.equal(evaluate(expression(block, 'auto'), {}), true)
  assert.equal(evaluate(expression(block, 'thresholdRatio'), {}), 0.8)
  assert.equal(evaluate(expression(block, 'auto'), { [file]: '{"auto":false,"threshold":60}' }), false)
  assert.equal(evaluate(expression(block, 'thresholdRatio'), { [file]: '{"auto":false,"threshold":60}' }), 0.6)
  assert.equal(evaluate(expression(block, 'thresholdRatio'), { [file]: '{"threshold":20}' }), 0.2)
  assert.equal(evaluate(expression(block, 'thresholdRatio'), { [file]: '{"threshold":1}' }), 0.05, 'no lower than 5%')
  assert.equal(evaluate(expression(block, 'thresholdRatio'), { [file]: '{"threshold":150}' }), 1, 'no higher than 100%')
  // The verbatim tail stays below the threshold.
  assert.equal(evaluate(expression(block, 'retainRatio'), {}), 0.16)
  assert.equal(evaluate(expression(block, 'retainRatio'), { [file]: '{"threshold":20}' }), 0.1)
  assert.equal(evaluate(expression(block, 'retainRatio'), { [file]: '{"threshold":5}' }), 0.025)
  assert.equal(evaluate(expression(block, 'file'), {}), file, 'low-context mode reads the same file')
  assert.equal(evaluate(expression(block, 'auto'), { [file]: 'not json' }), true)
})

test('the summarizer goes to dsh as a pair, or as an empty pair (the conversation\'s own model); its cap follows its output limit', () => {
  const block = standardOverride(upstreamStandard(root))
  const pair = files => [evaluate(expression(block, 'summarizationProvider'), files), evaluate(expression(block, 'summarizationModel'), files)]
  const cap = files => evaluate(expression(block, 'maxTokens'), files)
  assert.deepEqual(pair({}), ['', ''], 'none set: the conversation\'s own')
  assert.equal(cap({}), 65536, 'dsh\'s own default')
  assert.deepEqual(pair({ [file]: '{"summarizer":null}' }), ['', ''])
  assert.deepEqual(pair({ [file]: '{"summarizer":{"provider":"deepseek-official","model":"deepseek-flash"}}' }), ['deepseek-official', 'deepseek-flash'])
  assert.equal(cap({ [file]: '{"summarizer":{"provider":"relay","model":"small","maxTokens":8192}}' }), 8192, 'what the model can write')
  assert.equal(cap({ [file]: '{"summarizer":{"provider":"relay","model":"big","maxTokens":200000}}' }), 65536, 'never above dsh\'s default')
  // Never half a pair, which dsh refuses at start.
  assert.deepEqual(pair({ [file]: '{"summarizer":{"provider":"relay","model":""}}' }), ['', ''])
  assert.deepEqual(pair({ [file]: '{"summarizer":{"provider":"relay"}}' }), ['', ''])
  assert.equal(cap({ [file]: '{"summarizer":{"provider":"relay","model":"","maxTokens":8192}}' }), 65536, 'no cap from a summarizer that is not one')
  assert.deepEqual(pair({ [file]: 'not json' }), ['', ''])
})

test('sub-agents run ptc unless 设置 turns it off; then they inherit their parent\'s preset', () => {
  const source = expression(standardOverride(upstreamStandard(root)), 'agentPreset')
  assert.equal(evaluate(source, {}), 'ptc', 'on by default')
  assert.equal(evaluate(source, { [file]: '{"ptcSubagents":true}' }), 'ptc')
  assert.equal(evaluate(source, { [file]: '{"ptcSubagents":false}' }), undefined)
  assert.equal(evaluate(source, { [file]: 'not json' }), 'ptc')
})

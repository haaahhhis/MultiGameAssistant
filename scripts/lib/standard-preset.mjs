/**
 * The app's override of dsh's `standard` agent preset (packages/bundle/cordis.patch.yml):
 * dsh-web-app's own presets/standard.patch.yml, changed in one place. Its
 * compaction-basic row gets `auto` and `thresholdRatio` from the app's
 * compaction.json (设置 → 对话压缩, packages/gateway/src/compaction-settings.ts),
 * read when the agent service starts. A preset is overridden whole (dsh does not
 * merge plugin lists), so the rest must stay exactly dsh's: the override is made
 * from the installed file, and scripts/test/standard-preset.test.mjs fails when
 * the two drift apart (a dsh update): run `node scripts/sync-standard-preset.mjs`.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const BEGIN = '# >>> preset-standard'
export const END = '# <<< preset-standard'

/** The settings file as an expression: the parsed object, or {} when it is missing or broken. */
const SETTINGS = "(() => { try { return JSON.parse(process.getBuiltinModule('node:fs').readFileSync((process.env.ADG_DATA_DIR || dshHomePath('adg/data')) + '/compaction.json', 'utf8')) } catch { return {} } })()"

/** dsh-web-app's standard.patch.yml as installed with dsh. */
export function upstreamStandard(root) {
  const dsh = realpathSync(join(root, 'node_modules', '@deepseek-ai', 'dsh'))
  return readFileSync(join(dirname(dsh), 'dsh-web-app', 'presets', 'standard.patch.yml'), 'utf8')
}

/** The override block (markers included) made from `upstream`. */
export function standardOverride(upstream) {
  const lines = upstream.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(l => l === '    - id: preset-standard')
  if (start === -1 || lines[start - 1] !== '- insert:') throw new Error('standard.patch.yml no longer starts with an insert of preset-standard: update scripts/lib/standard-preset.mjs')
  const row = lines.slice(start).map(l => l.replace(/^ {4}/, ''))
  while (row.at(-1) === '') row.pop()
  const name = row.findIndex(l => l.trim() === "name: '@deepseek-ai/dsh-compaction-basic'")
  if (name === -1) throw new Error('standard.patch.yml has no dsh-compaction-basic row: update scripts/lib/standard-preset.mjs')
  const indent = row[name].match(/^ */)[0]
  const next = row[name + 1]
  if (next !== undefined && next.startsWith(indent) && !next.startsWith(`${indent}- `) && next.length > indent.length && next[indent.length] !== '-') {
    throw new Error('dsh-compaction-basic now has its own config in standard.patch.yml: merge it in scripts/lib/standard-preset.mjs')
  }
  const config = [
    `${indent}config:`,
    `${indent}  # 设置 → 对话压缩 (compaction.json in the app's data); read when the agent service starts.`,
    `${indent}  auto: !!js "${SETTINGS}.auto !== false"`,
    `${indent}  thresholdRatio: !!js "Math.min(95, Math.max(50, Number(${SETTINGS}.threshold) || 80)) / 100"`,
  ]
  return [
    `${BEGIN} (made by scripts/sync-standard-preset.mjs from dsh-web-app's presets/standard.patch.yml: do not edit by hand)`,
    "# dsh's standard agent preset, whole (a preset is overridden whole), with automatic compaction",
    '# following 设置 → 对话压缩.',
    ...row.slice(0, name + 1),
    ...config,
    ...row.slice(name + 1),
    END,
  ].join('\n')
}

/** The block as it is in `patch` (the bundle's cordis.patch.yml), or undefined. */
export function currentBlock(patch) {
  const text = patch.replace(/\r\n/g, '\n')
  const begin = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  return begin === -1 || end === -1 ? undefined : text.slice(begin, end + END.length)
}

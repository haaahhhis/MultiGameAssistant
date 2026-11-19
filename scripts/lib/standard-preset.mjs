/**
 * The app's overrides of dsh's `standard` and `ptc` agent presets
 * (packages/bundle/cordis.patch.yml): dsh-web-app's own presets/*.patch.yml,
 * each changed in the same places. Its compaction-basic row gets `auto`,
 * `thresholdRatio`, `retainRatio` and the summarizer (`summarizationProvider`,
 * `summarizationModel`, `maxTokens`) from the app's compaction.json
 * (设置 → 对话压缩, packages/gateway/src/compaction-settings.ts), read when the
 * agent service starts, and the compaction group gets the app's low-context
 * mode (packages/gateway/src/low-context.ts), which reads the same file before
 * every step.
 *
 * Sub-agents run the `ptc` preset (`ptcSubagents`, on unless turned off):
 * standard's `subagent` row starts every child under it. There a child calls
 * its tools from a program (run_code), and only what the program returns or
 * prints comes back into its conversation, so waiting for a run, reading a
 * long log or a list of runs costs a few lines instead of the whole output at
 * every step. The agents' own conversations stay on `standard`: hand-offs,
 * approvals and the cards they show work on single tool calls.
 *
 * A preset is overridden whole (dsh does not merge plugin lists), so the rest
 * must stay exactly dsh's: the override is made from the installed file, and
 * scripts/test/standard-preset.test.mjs fails when the two drift apart (a dsh
 * update): run `node scripts/sync-standard-preset.mjs`.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The presets the app overrides, in the order their blocks stand in the patch. */
export const PRESETS = ['standard', 'ptc']

export const begin = id => `# >>> preset-${id}`
export const end = id => `# <<< preset-${id}`
export const BEGIN = begin('standard')
export const END = end('standard')

/** The settings file as an expression: the parsed object, or {} when it is missing or broken. */
const SETTINGS = "(() => { try { return JSON.parse(process.getBuiltinModule('node:fs').readFileSync((process.env.ADG_DATA_DIR || dshHomePath('adg/data')) + '/compaction.json', 'utf8')) } catch { return {} } })()"

/** The threshold as a ratio: 5–100% (default 80%). */
const RATIO = `(Math.min(100, Math.max(5, Number(${SETTINGS}.threshold) || 80)) / 100)`
/** The file itself, for the low-context row. */
const FILE = "(process.env.ADG_DATA_DIR || dshHomePath('adg/data')) + '/compaction.json'"
/** The preset sub-agents start under: `ptc` unless turned off (undefined: the parent's own). */
const CHILD_PRESET = `${SETTINGS}.ptcSubagents === false ? undefined : 'ptc'`
/** The model that writes the summaries, when one is set whole (dsh wants the provider and the model as a pair); else undefined. */
const SUMMARIZER = `(s => s !== null && typeof s === 'object' && typeof s.provider === 'string' && s.provider !== '' && typeof s.model === 'string' && s.model !== '' ? s : undefined)(${SETTINGS}.summarizer)`
/** What a summary must fit in: the summarizer's own output limit when below dsh's default 65536 (also its headroom default). */
const SUMMARY_CAP = `(m => Number.isInteger(m) && m > 0 ? Math.min(m, 65536) : 65536)(${SUMMARIZER}?.maxTokens)`

/** dsh-web-app's presets/<id>.patch.yml as installed with dsh. */
export function upstreamPreset(root, id) {
  const dsh = realpathSync(join(root, 'node_modules', '@deepseek-ai', 'dsh'))
  return readFileSync(join(dirname(dsh), 'dsh-web-app', 'presets', `${id}.patch.yml`), 'utf8')
}
export const upstreamStandard = root => upstreamPreset(root, 'standard')

/** The row `name` stands on, with its indent; throws when dsh moved it. */
function rowOf(row, name, id) {
  const at = row.findIndex(l => l.trim() === `name: '${name}'`)
  if (at === -1) throw new Error(`${id}.patch.yml has no ${name} row: update scripts/lib/standard-preset.mjs`)
  return { at, indent: row[at].match(/^ */)[0] }
}

/** The override block (markers included) of preset `id`, made from `upstream`. */
export function presetOverride(upstream, id) {
  const lines = upstream.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(l => l === `    - id: preset-${id}`)
  if (start === -1 || lines[start - 1] !== '- insert:') throw new Error(`${id}.patch.yml no longer starts with an insert of preset-${id}: update scripts/lib/standard-preset.mjs`)
  const row = lines.slice(start).map(l => l.replace(/^ {4}/, ''))
  while (row.at(-1) === '') row.pop()

  const compaction = rowOf(row, '@deepseek-ai/dsh-compaction-basic', id)
  const { indent } = compaction
  const next = row[compaction.at + 1]
  if (next !== undefined && next.startsWith(indent) && !next.startsWith(`${indent}- `) && next.length > indent.length && next[indent.length] !== '-') {
    throw new Error(`dsh-compaction-basic now has its own config in ${id}.patch.yml: merge it in scripts/lib/standard-preset.mjs`)
  }
  const compactionConfig = [
    `${indent}config:`,
    `${indent}  # 设置 → 对话压缩 (compaction.json in the app's data); read when the agent service starts.`,
    `${indent}  auto: !!js "${SETTINGS}.auto !== false"`,
    `${indent}  thresholdRatio: !!js "${RATIO}"`,
    // dsh keeps 16% of the window word for word, which must be below the threshold: half of a low one.
    `${indent}  retainRatio: !!js "Math.min(0.16, ${RATIO} / 2)"`,
    // The model that writes the summaries ('' as a pair: the conversation's own, dsh's default), and what they fit in.
    `${indent}  summarizationProvider: !!js "${SUMMARIZER}?.provider ?? ''"`,
    `${indent}  summarizationModel: !!js "${SUMMARIZER}?.model ?? ''"`,
    `${indent}  maxTokens: !!js "${SUMMARY_CAP}"`,
    // Low-context mode: compacts all but the latest messages, before each step (it uses this group's compaction).
    `${indent.slice(2)}- id: adg-low-context`,
    `${indent}name: '@adg/gateway/low-context'`,
    `${indent}config:`,
    `${indent}  file: !!js "${FILE}"`,
  ]
  const inserts = [{ after: compaction.at, lines: compactionConfig }]

  // The app's agents read their own skills only (its core ones, the 技能库's, the ones saved here), not the
  // folders other agents on the machine share: ~/.agents/skills, ~/.dsh/skills, a working folder's
  // .agents/skills or .dsh/skills. dsh's bundled skills stay.
  const skills = rowOf(row, '@deepseek-ai/dsh-skill-filesystem', id)
  const own = [
    `${skills.indent}  # The app's agents read their own skills only, not the folders other agents on the machine share`,
    `${skills.indent}  # (~/.agents/skills, ~/.dsh/skills, a working folder's .agents/skills or .dsh/skills); dsh's bundled ones stay.`,
    `${skills.indent}  includeDefaultRoots: false`,
    `${skills.indent}  bundledSkillDir: !!js "process.env.DSH_BUNDLED_SKILL_DIR || undefined"`,
  ]
  if (row[skills.at + 1] === `${skills.indent}config:`) {
    const end = row.findIndex((l, i) => i > skills.at + 1 && !l.startsWith(`${skills.indent}  `))
    const config = row.slice(skills.at + 2, end === -1 ? undefined : end)
    if (config.some(l => /^\s*(includeDefaultRoots|bundledSkillDir):/.test(l))) throw new Error(`dsh-skill-filesystem now sets its own roots in ${id}.patch.yml: merge it in scripts/lib/standard-preset.mjs`)
    inserts.push({ after: skills.at + 1, lines: own })
  } else {
    inserts.push({ after: skills.at, lines: [`${skills.indent}config:`, ...own] })
  }

  if (id === 'standard') {
    // The children of standard's agents run under ptc (设置 → 对话压缩 → 子 agent 用代码调用工具).
    const subagent = rowOf(row, '@deepseek-ai/dsh-tool-subagent', id)
    const config = row[subagent.at + 1]
    if (config !== `${subagent.indent}config:` || row[subagent.at + 2]?.trim() !== 'provider: spawn') {
      throw new Error(`the subagent row of ${id}.patch.yml is no longer a spawn with its own config: update scripts/lib/standard-preset.mjs`)
    }
    inserts.push({ after: subagent.at + 1, lines: [`${subagent.indent}  # Sub-agents call their tools from a program (run_code); read when the agent service starts.`, `${subagent.indent}  agentPreset: !!js "${CHILD_PRESET}"`] })
  }

  const body = [...row]
  for (const { after, lines: added } of inserts.sort((a, b) => b.after - a.after)) body.splice(after + 1, 0, ...added)
  const what = id === 'standard'
    ? ["# dsh's standard agent preset, whole (a preset is overridden whole), with automatic compaction", '# following 设置 → 对话压缩, and sub-agents under the ptc preset.']
    : ["# dsh's ptc agent preset, whole: what sub-agents run (tools called from run_code programs), with", '# automatic compaction following 设置 → 对话压缩.']
  return [
    `${begin(id)} (made by scripts/sync-standard-preset.mjs from dsh-web-app's presets/${id}.patch.yml: do not edit by hand)`,
    ...what,
    ...body,
    end(id),
  ].join('\n')
}
export const standardOverride = upstream => presetOverride(upstream, 'standard')

/** The block of preset `id` (markers included) as it is in `patch`, or undefined. */
export function currentBlock(patch, id = 'standard') {
  const text = patch.replace(/\r\n/g, '\n')
  const from = text.indexOf(begin(id))
  const to = text.indexOf(end(id))
  return from === -1 || to === -1 ? undefined : text.slice(from, to + end(id).length)
}

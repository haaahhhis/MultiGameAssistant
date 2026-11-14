/**
 * A pack's user guide, made readable: `guideView` puts the pack's `guide`
 * together with what its tasks already say (titles, parameters) and what its
 * runs change in the config for themselves, in words people read (keys as
 * `A › B › C`, run facts named instead of `{adb}`). `guideIssues` is what the
 * agent is told to fix before a pack it writes is saved: a guide that is
 * missing, or that carries the agent's own notes.
 */
import type { PackGuide } from '@adg/protocol'
import { declaresFile, type PathSegment, type ScriptManifest, type Task } from './manifest.ts'

/** Run facts a template may name, for people. */
const FACTS: Readonly<Record<string, string>> = { adb: '模拟器的 ADB 地址', dir: '脚本目录' }

const WHEN: Readonly<Record<string, string>> = { 'emulator-managed': '本应用启动了模拟器时（填了手动 ADB 地址时不改）' }

/** A key path for people: `Configurations › Default › Start.RunDirectly`; list items as `[2]` or `[name = …]`. */
export function keyText(path: readonly PathSegment[], params: Task['params'] = {}): string {
  return path.map(seg => typeof seg === 'string' ? seg : typeof seg === 'number' ? `[${seg}]` : `[${seg.where.field} = ${templateText(seg.where.equals, params)}]`).join(' › ')
}

/** A value for people, with placeholders named: `{adb}` → 「模拟器的 ADB 地址」, `{stage}` → 「参数 stage（关卡）」. */
export function valueText(value: unknown, params: Task['params'] = {}): string {
  if (typeof value === 'string') return templateText(value, params)
  if (value === undefined) return ''
  return JSON.stringify(value)
}

function templateText(template: string, params: Task['params']): string {
  const name = (key: string) => FACTS[key] ?? (params[key] === undefined ? `{${key}}` : `参数 ${key}${params[key]!.description === undefined ? '' : `（${params[key]!.description}）`}`)
  const whole = /^\{([A-Za-z][A-Za-z0-9_.]*)\}$/.exec(template)
  if (whole !== null) return `「${name(whole[1]!)}」`
  return template.replace(/\{([A-Za-z][A-Za-z0-9_.]*)\}/g, (_, key: string) => `「${name(key)}」`)
}

function paramValues(spec: Task['params'][string]): string | undefined {
  if (spec.enum !== undefined) return spec.enum.join('、')
  if (spec.choices !== undefined) return `从脚本配置（${spec.choices.file}）里已有的项中选${spec.choices.create === undefined ? '' : '，也可以新建一个'}`
  if (spec.type === 'boolean') return 'true（是）/ false（否）'
  return undefined
}

/** The guide the 脚本 page shows for this pack. */
export function guideView(manifest: ScriptManifest, options: { builtin: boolean }): PackGuide {
  const guide = manifest.guide
  const titleOf = (id: string) => manifest.tasks.find(t => t.id === id)?.title ?? id

  // Config files: the guide's own entries first, then the files only runs change.
  const files: PackGuide['config'] = (guide?.config ?? []).map(entry => ({
    file: entry.file,
    about: entry.about,
    keys: entry.keys.map(k => ({
      key: keyText(k.path), meaning: k.meaning,
      ...(k.values === undefined ? {} : { values: k.values }),
      ...(k.default === undefined ? {} : { default: String(k.default) }),
      ...(k.advice === undefined ? {} : { advice: k.advice }),
    })),
    changes: [],
  }))
  for (const task of manifest.tasks) {
    for (const patch of task.patches) {
      let entry = files.find(f => f.file === patch.file) ?? files.find(f => declaresFile([{ path: f.file }], patch.file))
      if (entry === undefined) {
        entry = { file: patch.file, keys: [], changes: [] }
        files.push(entry)
      }
      for (const op of patch.set) {
        const key = keyText(op.path, task.params)
        const value = valueText(op.value, task.params)
        const when = patch.when === undefined ? undefined : WHEN[patch.when] ?? patch.when
        const same = entry.changes.find(c => c.key === key && c.value === value && c.when === when)
        if (same !== undefined) {
          if (!same.tasks.includes(task.title)) same.tasks.push(task.title)
          if (same.note === undefined && op.note !== undefined) same.note = op.note
          continue
        }
        entry.changes.push({ key, value, ...(op.note === undefined ? {} : { note: op.note }), ...(when === undefined ? {} : { when }), tasks: [task.title] })
      }
    }
  }

  const overview = guide?.overview ?? manifest.description
  return {
    packId: manifest.id,
    name: manifest.name,
    builtin: options.builtin,
    written: guide !== undefined,
    ...(overview === undefined ? {} : { overview }),
    tasks: manifest.tasks.map(task => ({
      id: task.id,
      title: task.title,
      ...(task.description === undefined ? {} : { description: task.description }),
      utterances: [...task.utterances],
      input: task.resources.input,
      ...(task.expectedDuration === undefined ? {} : { expectedDuration: task.expectedDuration }),
      params: Object.entries(task.params).map(([name, spec]) => {
        const values = paramValues(spec)
        return {
          name, type: spec.type,
          ...(spec.description === undefined ? {} : { description: spec.description }),
          ...(spec.default === undefined ? {} : { default: String(spec.default) }),
          ...(values === undefined ? {} : { values }),
        }
      }),
    })),
    setup: [...(guide?.setup ?? [])],
    checks: [...(guide?.checks ?? [])],
    features: (guide?.features ?? []).map(f => ({
      title: f.title,
      ...(f.description === undefined ? {} : { description: f.description }),
      enable: f.enable,
      config: f.config.map(k => ({ file: k.file, key: keyText(k.path), value: valueText(k.value) })),
      tasks: f.tasks.map(titleOf),
    })),
    config: files,
    troubleshooting: (guide?.troubleshooting ?? []).map(p => ({ problem: p.problem, ...(p.cause === undefined ? {} : { cause: p.cause }), fix: p.fix })),
  }
}

/**
 * The agent tools a pack's notes tend to name. Listed, not matched by prefix:
 * scripts have config keys like `game_title_name` or `script_path`.
 */
const TOOLS = [
  'script_analyze', 'script_changelog', 'script_choice_create', 'script_config_get', 'script_config_import', 'script_config_set', 'script_config_status',
  'script_env_check', 'script_env_fix', 'script_help', 'script_import', 'script_install', 'script_list', 'script_profiles', 'script_releases', 'script_remove',
  'script_rollback', 'script_run', 'script_run_log', 'script_runs', 'script_search', 'script_settings', 'script_setup_run', 'script_stop', 'script_tasks', 'script_update',
  'pack_propose', 'pack_reviewed', 'skill_focus', 'skill_save', 'skill_hub_install', 'skill_hub_list',
  'emulator_configure', 'emulator_install', 'emulator_start', 'emulator_status', 'emulator_stop',
  'game_launch', 'game_locate', 'game_path_set', 'intervention_done', 'monitor_incidents', 'monitor_stall_check', 'monitor_stall_set',
]

/**
 * What reads as the agent's own notes rather than a user guide: tool names,
 * the pack's internals, placeholders, open questions. Those go in SKILL.md.
 */
const AGENT_NOTES: readonly [RegExp, string][] = [
  [new RegExp(`\\b(?:${TOOLS.join('|')})\\b`), '工具名'],
  [/\bmanifest\b|adg\.script\.yaml|SKILL\.md/i, '脚本包的文件'],
  [/\bpatch(?:es)?\b|\bdone-log\b|\bexit-code\b|\bstopAfterDone\b|\bselfLaunch\b|\brestore\b|\bsuccess:/i, '脚本包的字段'],
  [/\{[A-Za-z][A-Za-z0-9_.]*\}/, '占位符'],
  [/渲染器|占位符|待确认|待核验|待校准|尚未验证|未经验证|核验依据|本草稿|草稿/, '给 agent 的备注'],
]

/**
 * Problems with a pack's user guide that the agent must fix before saving:
 * no guide, tasks or parameters without a description, and agent notes in
 * text people read.
 */
export function guideIssues(manifest: ScriptManifest): string[] {
  const issues: string[] = []
  if (manifest.guide === undefined) issues.push('缺少 guide（给用户看的使用说明）：至少写 overview，再按脚本的实际情况写 setup、checks、features、config、troubleshooting')
  const texts: [string, string | undefined][] = []
  for (const task of manifest.tasks) {
    if (task.description === undefined) issues.push(`任务 ${task.id} 缺少 description：用一两句话告诉用户这个任务做什么`)
    texts.push([`tasks.${task.id}.title`, task.title], [`tasks.${task.id}.description`, task.description])
    for (const [name, spec] of Object.entries(task.params)) {
      if (spec.description === undefined) issues.push(`任务 ${task.id} 的参数 ${name} 缺少 description：写它的含义`)
      texts.push([`tasks.${task.id}.params.${name}.description`, spec.description])
    }
    task.patches.forEach((patch, p) => patch.set.forEach((op, s) => texts.push([`tasks.${task.id}.patches.${p}.set.${s}.note`, op.note])))
  }
  const guide = manifest.guide
  if (guide !== undefined) {
    texts.push(['guide.overview', guide.overview])
    guide.setup.forEach((t, i) => texts.push([`guide.setup.${i}`, t]))
    guide.checks.forEach((t, i) => texts.push([`guide.checks.${i}`, t]))
    guide.features.forEach((f, i) => texts.push([`guide.features.${i}.title`, f.title], [`guide.features.${i}.description`, f.description], [`guide.features.${i}.enable`, f.enable]))
    guide.config.forEach((c, i) => {
      texts.push([`guide.config.${i}.about`, c.about])
      c.keys.forEach((k, j) => texts.push([`guide.config.${i}.keys.${j}.meaning`, k.meaning], [`guide.config.${i}.keys.${j}.values`, k.values], [`guide.config.${i}.keys.${j}.advice`, k.advice]))
    })
    guide.troubleshooting.forEach((t, i) => texts.push([`guide.troubleshooting.${i}.problem`, t.problem], [`guide.troubleshooting.${i}.cause`, t.cause], [`guide.troubleshooting.${i}.fix`, t.fix]))
  }
  for (const [where, text] of texts) {
    if (text === undefined) continue
    for (const [pattern, what] of AGENT_NOTES) {
      const found = pattern.exec(text)
      if (found === null) continue
      issues.push(`${where} 里有${what}「${found[0]}」：使用说明只写用户要知道的（能做什么、怎么设置、出错怎么办）；工具用法、脚本包内部、核验依据和待确认写进 SKILL.md`)
      break
    }
  }
  return issues
}

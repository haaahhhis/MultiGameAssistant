/**
 * The dsh plugin's manifest and patch (scripts/package-plugin.mjs), made from
 * packages/bundle's patch. Both are kept in the repository too, in
 * packages/dsh-plugin/: that folder is what the plugin catalogs read (its
 * package.json declares `dsh.bundle`), so it must say what the published
 * package says. The packaging checks it does and `--sync` rewrites it; the
 * patch is checked by a test as well (scripts/test/plugin-manifest.test.mjs).
 */

export const NAME = 'dsh-multigameassistant'
/** The dsh this was built and tested against, up to the next minor (dsh changes its plugin APIs between minors). */
export const DSH_RANGE = '>=0.2.1-rc.5 <0.3.0-0'
/** Where the manifest and patch are kept in the repository. */
export const PLUGIN_DIR = 'packages/dsh-plugin'

/** The plugins packages/bundle mounts, in its patch's order. */
export function pluginsOf(bundlePatch) {
  const plugins = [...bundlePatch.matchAll(/name: '@adg\/([a-z-]+)'/g)].map(m => m[1])
  if (plugins.length === 0) throw new Error('no @adg plugins found in packages/bundle/cordis.patch.yml')
  return plugins
}

/**
 * The plugin's patch. The plugin shares the dsh it goes into (dsh desktop's
 * own profile, or another of the person's): its patch adds the app's plugins
 * and its own agent preset, and restates none of dsh's rows. The bundle's
 * permission presets, working folder and standard preset are the desktop
 * app's, which has a dsh of its own.
 */
export function pluginPatch(bundlePatch) {
  const cut = (from, to) => {
    const start = bundlePatch.indexOf(from)
    const end = bundlePatch.indexOf(to, start)
    if (start < 0 || end < 0) throw new Error(`packages/bundle/cordis.patch.yml changed shape (${JSON.stringify(from)} … ${JSON.stringify(to)})`)
    return bundlePatch.slice(start + 1, end)
  }
  const gatewayEntry = "      name: '@adg/gateway'\n      config:\n"
  const presetHead = '    id: standard\n    order: 1\n'
  const rows = cut('\n- insert:\n', '\n# M4 of the plan')
  const preset = cut('\n- id: preset-standard\n', '\n# <<< preset-standard')
  if (!rows.includes(gatewayEntry) || !preset.includes(presetHead)) throw new Error('packages/bundle/cordis.patch.yml: the gateway or the standard preset changed shape')
  const appPreset = `${preset
    .replace('- id: preset-standard\n', '- id: preset-mga\n')
    .replace(presetHead, '    id: mga\n    name: 多游戏助手\n    description: MultiGameAssistant：安装、运行和编排游戏脚本，处理运行中的问题，查活动\n    order: 50\n')}
      - id: adg-agent
        name: '@adg/gateway/agent'`
  return [
    `# ${NAME}: the app's plugins (packages/bundle/cordis.patch.yml, each @adg/<plugin> as ${NAME}/<plugin>)`,
    "# sharing the dsh with the person's other chats, and the app's agent preset (dsh's standard one with the app's",
    '# tools and prompts, and compaction as 设置 → 对话压缩 says). No row of dsh is restated.',
    '# Made by scripts/package-plugin.mjs (--sync) from packages/bundle/cordis.patch.yml: change that one.',
    rows.replace(gatewayEntry, `${gatewayEntry}        # Only its own sessions are its concern; the UI is under dsh's web server, at /adg/.\n        shared: true\n        listen: false\n`).trimEnd(),
    '',
    "    # The package itself: dsh's page loads its sidebar entry (「多游戏助手」) from it.",
    '    - id: adg-sidebar',
    `      name: '${NAME}'`,
    '',
    "    # The app's agent preset: its sessions run this one (the gateway creates them so).",
    appPreset.split('\n').map(line => line === '' ? line : `    ${line}`).join('\n'),
    '',
  ].join('\n').replace(/name: '@adg\/gateway\/([a-z-]+)'/g, `name: '${NAME}/$1'`).replace(/name: '@adg\/([a-z-]+)'/g, `name: '${NAME}/$1'`)
}

/**
 * The range a dsh package the code imports is asked for. dsh's own packages
 * (`@deepseek-ai/dsh-*`) share its version, pre-releases included: `*` would
 * leave out every pre-release (a prerelease only satisfies a range with a
 * comparator on its own x.y.z), so they take dsh's range. The others
 * (cordis) have stable versions of their own.
 */
export function peerRange(name) {
  return name.startsWith('@deepseek-ai/dsh-') ? DSH_RANGE : '*'
}

/** The package.json of the plugin package; `peers`: the dsh packages its code imports. */
export function pluginManifest({ version, plugins, peers }) {
  return {
    name: NAME,
    version,
    description: '多游戏助手 MultiGameAssistant 的 dsh 插件版：让 agent 管好各个游戏的日常脚本（安装、编排定时流水线、看护运行、查活动），界面在自己的网页里。',
    keywords: ['dsh', 'dsh-plugin', 'deepseek-harness', 'game', 'automation', 'maa', '明日方舟', '星穹铁道'],
    license: 'AGPL-3.0-only',
    homepage: 'https://github.com/haaahhhis/MultiGameAssistant',
    repository: { type: 'git', url: 'git+https://github.com/haaahhhis/MultiGameAssistant.git', directory: PLUGIN_DIR },
    bugs: { url: 'https://github.com/haaahhhis/MultiGameAssistant/issues' },
    type: 'module',
    exports: {
      '.': './lib/index.js',
      ...Object.fromEntries(plugins.map(name => [`./${name}`, `./lib/${name}.js`])),
      './agent': './lib/agent.js',
      './low-context': './lib/low-context.js',
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    files: ['lib', 'skills', 'web', 'cordis.patch.yml', 'README.md', 'LICENSE'],
    engines: { dsh: DSH_RANGE, node: '>=22' },
    os: ['win32'],
    peerDependencies: Object.fromEntries([...peers].sort().map(name => [name, peerRange(name)])),
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
  }
}

/** The version the kept manifest carries: the real one is set when the package is made. */
export const KEPT_VERSION = '0.0.0-source'

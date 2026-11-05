/**
 * Build MultiGameAssistant as one dsh plugin package, for people who already
 * have dsh: `dist/plugin/dsh-multigameassistant.tgz`, a few MB instead of the
 * desktop installer's Electron and dsh. The file name has no version, so a
 * release's `releases/latest/download/dsh-multigameassistant.tgz` is always the
 * newest (the version is in its package.json). The release workflow attaches
 * it to the GitHub release and publishes it to npm under the same name.
 *
 *   pnpm package:plugin [--skip-build] [--version 1.1.0] [--out <folder>]
 *
 * Installed into the person's own dsh (dsh desktop: Plugins → Add plugin;
 * otherwise `dsh plugin add`), beside their other chats: the gateway runs
 * shared (packages/gateway/src/shared.ts), its sessions run the app's own
 * agent preset, and its UI is a 「多游戏助手」 entry in dsh's sidebar, served
 * under dsh's web server at /adg/.
 *
 * What goes in:
 * 1. The plugins packages/bundle mounts, bundled by esbuild into
 *    `lib/<plugin>.js` (shared code in common chunks, so a module shared by two
 *    plugins is still one module). dsh's own packages stay imports: the dsh
 *    that loads the plugin provides them (peerDependencies). Everything else
 *    (zod, yaml, ws, …) is bundled in, so installing downloads nothing more.
 * 2. Files the code finds next to itself: the built-in packs at `lib/packs`
 *    and `lib/games` (@adg/packs looks beside its module, which is now a file
 *    in lib/), the core skills at `skills/` (`../skills/` from lib/), and the
 *    built UI at `web/`, which the gateway serves when nothing else is named.
 * 3. A patch of its own made from packages/bundle's cordis.patch.yml: the
 *    app's plugins (each `@adg/<x>` renamed to `<package>/<x>`, a subpath this
 *    package exports), the gateway set to share, and the app's agent preset;
 *    none of dsh's own rows. The package root is an entry too, for the
 *    sidebar entry's browser half (apps/web/dsh-client.js as `lib/client.js`).
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const NAME = 'dsh-multigameassistant'
/** The dsh this was built and tested against, up to the next minor (dsh changes its plugin APIs between minors). */
const DSH_RANGE = '>=0.2.1-rc.5 <0.3.0-0'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const option = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
const out = resolve(option('--out') ?? join(root, 'dist', 'plugin'))
const staging = join(out, NAME)
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (cmd, cmdArgs, cwd = root) => execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
const step = text => console.log(`\n▸ ${text}`)

const version = option('--version') ?? versionFromGit()
console.log(`${NAME} ${version}`)

if (!flag('--skip-build')) {
  step('pnpm build')
  run(pnpm, ['run', 'build'])
}
if (!existsSync(join(root, 'apps', 'web', 'dist', 'index.html'))) throw new Error('apps/web/dist is missing: run pnpm build first')

rmSync(staging, { recursive: true, force: true })
mkdirSync(join(staging, 'lib'), { recursive: true })

// The plugins the bundle mounts, in its patch's order.
const patch = readFileSync(join(root, 'packages', 'bundle', 'cordis.patch.yml'), 'utf8')
const plugins = [...patch.matchAll(/name: '@adg\/([a-z-]+)'/g)].map(m => m[1])
if (plugins.length === 0) throw new Error('no @adg plugins found in packages/bundle/cordis.patch.yml')

step(`esbuild: ${plugins.length} plugins → lib/`)
const result = await build({
  entryPoints: [
    ...plugins.map(name => ({ in: join(root, 'packages', name, 'lib', 'index.js'), out: name })),
    // The app's part of its agent preset (packages/gateway/src/agent.ts).
    { in: join(root, 'packages', 'gateway', 'lib', 'agent.js'), out: 'agent' },
  ],
  outdir: join(staging, 'lib'),
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@deepseek-ai/*'],
  // Bundled CommonJS packages (ws, yauzl, the Feishu SDK) call require() and read __dirname: give ESM both.
  banner: {
    js: [
      "import { createRequire as __adgCreateRequire } from 'node:module';",
      "import { dirname as __adgDirname } from 'node:path';",
      "import { fileURLToPath as __adgFileURLToPath } from 'node:url';",
      'const require = __adgCreateRequire(import.meta.url);',
      'const __filename = __adgFileURLToPath(import.meta.url);',
      'const __dirname = __adgDirname(__filename);',
    ].join(' '),
  },
  metafile: true,
  legalComments: 'linked',
  logLevel: 'warning',
})

// dsh's packages the code imports at run time (type-only imports are gone): the dsh loading it provides them.
const peers = new Set()
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports) {
    if (imported.external && imported.path.startsWith('@deepseek-ai/')) peers.add(imported.path.split('/').slice(0, 2).join('/'))
  }
}

step('packs, skills and the UI')
cpSync(join(root, 'packages', 'packs', 'packs'), join(staging, 'lib', 'packs'), { recursive: true })
cpSync(join(root, 'packages', 'packs', 'games'), join(staging, 'lib', 'games'), { recursive: true })
mkdirSync(join(staging, 'skills'))
for (const pkg of ['analyzer', 'game-intel', 'orchestrator']) {
  for (const file of readdirSync(join(root, 'packages', pkg, 'skills'))) {
    if (existsSync(join(staging, 'skills', file))) throw new Error(`two packages ship skills/${file}`)
    cpSync(join(root, 'packages', pkg, 'skills', file), join(staging, 'skills', file))
  }
}
cpSync(join(root, 'apps', 'web', 'dist'), join(staging, 'web'), { recursive: true })
// dsh's sidebar entry for that UI (apps/web/dsh-client.js), loaded by dsh's own page. dsh looks for a
// package's browser half (dsh.client) on the Loader entry named after the package itself, so the package
// root is an entry too, with nothing to do on the host.
cpSync(join(root, 'apps', 'web', 'dsh-client.js'), join(staging, 'lib', 'client.js'))
writeFileSync(join(staging, 'lib', 'index.js'), [
  "// The package's own Loader entry: it carries the sidebar entry (dsh.client, lib/client.js); the app's plugins are the subpaths.",
  "export const name = 'multigameassistant'",
  'export function apply() {}',
  '',
].join('\n'))
cpSync(join(root, 'LICENSE'), join(staging, 'LICENSE'))

// The plugin shares the dsh it goes into (dsh desktop's own profile, or another of the person's): its patch
// adds the app's plugins and its own agent preset, and restates none of dsh's rows. The bundle's permission
// presets, working folder and standard preset are the desktop app's, which has a dsh of its own.
const cut = (from, to) => {
  const start = patch.indexOf(from)
  const end = patch.indexOf(to, start)
  if (start < 0 || end < 0) throw new Error(`packages/bundle/cordis.patch.yml changed shape (${JSON.stringify(from)} … ${JSON.stringify(to)})`)
  return patch.slice(start + 1, end)
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
writeFileSync(join(staging, 'cordis.patch.yml'), [
  `# ${NAME} ${version}: the app's plugins (packages/bundle/cordis.patch.yml, each @adg/<plugin> as ${NAME}/<plugin>)`,
  "# sharing the dsh with the person's other chats, and the app's agent preset (dsh's standard one with the app's",
  '# tools and prompts, and compaction as 设置 → 对话压缩 says). No row of dsh is restated.',
  rows.replace(gatewayEntry, `${gatewayEntry}        # Only its own sessions are its concern; the UI is under dsh's web server, at /adg/.\n        shared: true\n        listen: false\n`).trimEnd(),
  '',
  "    # The package itself: dsh's page loads its sidebar entry (「多游戏助手」) from it.",
  '    - id: adg-sidebar',
  `      name: '${NAME}'`,
  '',
  "    # The app's agent preset: its sessions run this one (the gateway creates them so).",
  appPreset.split('\n').map(line => line === '' ? line : `    ${line}`).join('\n'),
  '',
].join('\n').replace(/name: '@adg\/gateway\/agent'/g, `name: '${NAME}/agent'`).replace(/name: '@adg\/([a-z-]+)'/g, `name: '${NAME}/$1'`))

const exports = {
  '.': './lib/index.js',
  ...Object.fromEntries(plugins.map(name => [`./${name}`, `./lib/${name}.js`])),
  './agent': './lib/agent.js',
  './client': './lib/client.js',
}
writeFileSync(join(staging, 'package.json'), `${JSON.stringify({
  name: NAME,
  version,
  description: '多游戏助手 MultiGameAssistant 的 dsh 插件版：让 agent 管好各个游戏的日常脚本（安装、编排定时流水线、看护运行、查活动），界面在自己的网页里。',
  keywords: ['dsh', 'dsh-plugin', 'deepseek-harness', 'game', 'automation', 'maa', '明日方舟', '星穹铁道'],
  license: 'AGPL-3.0-only',
  homepage: 'https://github.com/haaahhhis/MultiGameAssistant',
  repository: { type: 'git', url: 'git+https://github.com/haaahhhis/MultiGameAssistant.git' },
  bugs: { url: 'https://github.com/haaahhhis/MultiGameAssistant/issues' },
  type: 'module',
  exports: { ...exports, './package.json': './package.json' },
  files: ['lib', 'skills', 'web', 'cordis.patch.yml', 'README.md', 'LICENSE'],
  engines: { dsh: DSH_RANGE, node: '>=22' },
  os: ['win32'],
  peerDependencies: Object.fromEntries([...peers].sort().map(name => [name, '*'])),
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
}, null, 2)}\n`)

writeFileSync(join(staging, 'README.md'), `# ${NAME}

[MultiGameAssistant](https://github.com/haaahhhis/MultiGameAssistant)（多游戏助手）的 dsh 插件版：已经装了 dsh 的话，不用再下完整安装包。只支持 Windows。

## 安装

- **dsh 桌面版**：「Plugins」→「Add plugin」，填 \`${NAME}\` →「Install」→「Enable now」。
- **命令行的 dsh**：\`dsh plugin add ${NAME}\`，再 \`dsh web\`。

npm 慢或连不上时，用 GitHub 上最新版的插件包链接代替名字：

\`\`\`text
https://github.com/haaahhhis/MultiGameAssistant/releases/latest/download/${NAME}.tgz
\`\`\`

侧边栏会多出「多游戏助手」，点开就是它的界面。它和你平时的 dsh 对话互不影响：它的对话用自己的 agent 预设「多游戏助手」，工具、提示词、技能和权限设置只在这些对话里。

和桌面版相比，没有自己的托盘、开机自启和定时唤醒电脑：定时任务在 dsh 开着时执行。需要这些就用[桌面版安装包](https://github.com/haaahhhis/MultiGameAssistant/releases)。
`)

step('npm pack')
run(npm, ['pack', '--pack-destination', out], staging)
// Without the version, so the release's latest/download link stays the same (the version is inside).
const tgz = join(out, `${NAME}.tgz`)
rmSync(tgz, { force: true })
renameSync(join(out, `${NAME}-${version}.tgz`), tgz)
console.log(`\ndone: ${relative(root, tgz)}\nplugins: ${plugins.join(', ')}\ndsh imports: ${[...peers].sort().join(', ')}`)

/** The latest tag as the version: v0.6.0-beta.5 → 0.6.0-beta.5; 3 commits after it → 0.6.0-beta.5.3 (as package-desktop.mjs). */
function versionFromGit() {
  let described
  try {
    described = execFileSync('git', ['describe', '--tags', '--long', '--match', 'v*'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { /* no git */ }
  const match = described === undefined ? null : /^v(\d+\.\d+\.\d+)(-[0-9A-Za-z.]+)?-(\d+)-g[0-9a-f]+$/.exec(described)
  if (match === null) return '0.0.0-dev'
  const [, base, pre = '', ahead] = match
  if (ahead === '0') return `${base}${pre}`
  return pre === '' ? `${base}-dev.${ahead}` : `${base}${pre}.${ahead}`
}

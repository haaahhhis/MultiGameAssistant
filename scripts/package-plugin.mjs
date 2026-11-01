/**
 * Build MultiGameAssistant as one dsh plugin package, for people who already
 * have dsh: `dist/plugin/dsh-multigameassistant-<version>.tgz`, a few MB
 * instead of the desktop installer's Electron and dsh.
 *
 *   pnpm package:plugin [--skip-build] [--version 1.1.0] [--out <folder>]
 *
 * Installed into a profile of its own, made from dsh's web template (the
 * gateway needs its session, settings and workspace APIs), so its patch
 * (permission presets, the agent preset, the working folder) never changes
 * the person's other dsh chats; then started like any profile, the gateway
 * opening its page instead of dsh's:
 *
 *   dsh --profile mga --from-default-profile web --help   (once: it resets the profile)
 *   dsh plugin --profile mga add dsh-multigameassistant
 *   dsh mga --no-open
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
 * 3. packages/bundle's cordis.patch.yml with each `@adg/<x>` entry renamed to
 *    `<package>/<x>`, a subpath this package exports.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  entryPoints: plugins.map(name => ({ in: join(root, 'packages', name, 'lib', 'index.js'), out: name })),
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
cpSync(join(root, 'LICENSE'), join(staging, 'LICENSE'))

// Nothing else shows the UI here (no desktop window): the gateway opens it in the browser.
const gatewayEntry = "      name: '@adg/gateway'\n      config:\n"
if (!patch.includes(gatewayEntry)) throw new Error('packages/bundle/cordis.patch.yml: the adg-gateway entry changed shape')
writeFileSync(join(staging, 'cordis.patch.yml'), [
  `# ${NAME} ${version}: packages/bundle/cordis.patch.yml with each @adg/<plugin> as ${NAME}/<plugin>, and the gateway opening the UI.`,
  patch.replace(gatewayEntry, `${gatewayEntry}        openBrowser: true\n`).replace(/name: '@adg\/([a-z-]+)'/g, `name: '${NAME}/$1'`),
].join('\n'))

const exports = Object.fromEntries(plugins.map(name => [`./${name}`, `./lib/${name}.js`]))
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
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2)}\n`)

writeFileSync(join(staging, 'README.md'), `# ${NAME}

[MultiGameAssistant](https://github.com/haaahhhis/MultiGameAssistant)（多游戏助手）的 dsh 插件版：已经装了 dsh 的话，不用再下完整安装包。只支持 Windows。

## 安装

装进单独的 profile（它会改权限预设和 agent 的设置，放在单独的 profile 里就不影响你平时的 dsh 对话）。第一行只在第一次运行（它会重置这个 profile）：

\`\`\`sh
dsh --profile mga --from-default-profile web --help
dsh plugin --profile mga add ${NAME}
dsh mga --no-open
\`\`\`

启动后会在浏览器里打开界面，终端里也会打印地址（\`adg gateway: http://127.0.0.1:3290/?token=…\`），地址在两次启动之间不变，可以收藏。以后启动只要 \`dsh mga --no-open\`；更新：\`dsh plugin --profile mga update ${NAME}@latest\`。

和桌面版相比，没有托盘、开机自启和定时唤醒电脑：定时任务只在 \`dsh mga\` 运行时执行。需要这些就用[桌面版安装包](https://github.com/haaahhhis/MultiGameAssistant/releases)。
`)

step('npm pack')
run(npm, ['pack', '--pack-destination', out], staging)
const tgz = join(out, `${NAME}-${version}.tgz`)
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

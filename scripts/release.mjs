/**
 * Release a version: `pnpm release 1.0.0` (or `1.0.0-rc.4` for a pre-release).
 *
 * Checks that main is clean and the same as on GitHub, builds and tests,
 * drafts the release notes from the feat and fix commits since the previous
 * release and opens them in the editor, then tags the commit with the edited
 * notes and pushes the tag. The push starts .github/workflows/release.yml,
 * which builds the installers and publishes them with these notes.
 *
 *   --skip-checks   no build, typecheck or tests (the workflow runs them anyway)
 *   --notes <file>  the notes from this file instead of a draft
 *   --no-edit       take the draft as it is
 *   --dry-run       show the notes, tag nothing
 *   --yes           do not ask before pushing the tag
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { compareVersions } from '../apps/desktop/updates.mjs'
import { cleanNotes, draftNotes, previousTag } from './lib/release-notes.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const option = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
const git = gitArgs => execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' }).trim()
/** A fixed command line (pnpm is pnpm.cmd on Windows, which only a shell runs). */
const run = command => execSync(command, { cwd: root, stdio: 'inherit' })
const step = text => console.log(`\n▸ ${text}`)
const stop = message => { console.error(`\n✖ ${message}`); process.exit(1) }

const notesFile = option('--notes')
const given = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--notes')
const tags = git(['tag', '--list', 'v*']).split('\n').filter(t => t !== '')
if (given === undefined) {
  const latest = [...tags].sort((a, b) => compareVersions(b, a))[0]
  stop(`要发哪个版本？例如 pnpm release 1.0.0（预发布：1.0.0-rc.4）${latest === undefined ? '' : `；最近的是 ${latest}`}`)
}
const version = given.replace(/^v/, '')
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(version)) stop(`${given} 不是版本号：要像 1.0.0 或 1.0.0-rc.4`)
const tag = `v${version}`

step('检查仓库')
if (git(['branch', '--show-current']) !== 'main') stop('只从 main 发版：先 git switch main')
if (git(['status', '--porcelain', '--untracked-files=no']) !== '') stop('有没提交的修改：先提交或撤销')
git(['fetch', '--quiet', '--tags', 'origin'])
const allTags = git(['tag', '--list', 'v*']).split('\n').filter(t => t !== '')
if (allTags.includes(tag)) stop(`标签 ${tag} 已经有了：换一个版本号`)
const newest = [...allTags].sort((a, b) => compareVersions(b, a))[0]
if (newest !== undefined && compareVersions(version, newest) <= 0) stop(`${version} 不比已有的 ${newest} 新：装了 ${newest} 的人不会收到这个更新`)
const head = git(['rev-parse', 'HEAD'])
const remote = git(['rev-parse', 'origin/main'])
if (head !== remote) {
  const ahead = git(['rev-list', '--count', 'origin/main..HEAD'])
  stop(ahead !== '0' ? `本地 main 比 GitHub 多 ${ahead} 个提交：先 git push` : '本地 main 落后于 GitHub：先 git pull')
}
console.log(`  main 在 ${head.slice(0, 7)}，和 GitHub 一致；上一个版本 ${newest ?? '（没有）'}`)

if (!flag('--skip-checks')) {
  step('构建和测试（--skip-checks 跳过）')
  run('pnpm run build')
  run('pnpm run typecheck')
  run('pnpm test')
}

step('发版说明')
const draftDir = join(root, 'dist', 'release-notes')
mkdirSync(draftDir, { recursive: true })
const file = join(draftDir, `${tag}.md`)
if (notesFile !== undefined) {
  writeFileSync(file, readFileSync(resolve(notesFile), 'utf8'))
} else {
  const previous = previousTag(allTags, version)
  const subjects = git(['log', '--reverse', '--no-merges', '--format=%s', ...(previous === undefined ? [] : [`${previous}..HEAD`])]).split('\n').filter(s => s !== '')
  writeFileSync(file, draftNotes({ version, previous, subjects }))
  if (!flag('--no-edit')) {
    const editor = editorCommand()
    console.log(`  在编辑器里打开 ${file}（${editor}），改好后保存并关闭…`)
    const edited = spawnSync(`${editor} "${file}"`, { cwd: root, stdio: 'inherit', shell: true })
    if (edited.status !== 0) stop(`编辑器没有正常退出（${edited.status ?? edited.error?.message}）`)
  }
}
const notes = cleanNotes(readFileSync(file, 'utf8'))
if (notes === '') stop('发版说明是空的：取消发版')
writeFileSync(file, `${notes}\n`)
console.log(`\n${notes.split('\n').map(l => `  │ ${l}`).join('\n')}`)

if (flag('--dry-run')) {
  console.log(`\n--dry-run：没有打标签。说明留在 ${file}，可以用 --notes 再用。`)
  process.exit(0)
}
if (!flag('--yes')) {
  if (!process.stdin.isTTY) stop('要确认才能推送标签：在终端里运行，或加 --yes')
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await prompt.question(`\n给 ${head.slice(0, 7)} 打标签 ${tag} 并推送到 GitHub（开始构建并发布${version.includes('-') ? '预发布版' : '正式版'}）？[y/N] `)
  prompt.close()
  if (!/^y(es)?$/i.test(answer.trim())) stop('取消了，没有打标签')
}

step(`打标签 ${tag} 并推送`)
git(['tag', '--annotate', '--cleanup=verbatim', '--file', file, tag])
try {
  execFileSync('git', ['push', 'origin', tag], { cwd: root, stdio: 'inherit' })
} catch {
  git(['tag', '--delete', tag])
  stop(`推送失败，已删掉本地标签 ${tag}；说明还在 ${file}，修好后用 --notes 再发`)
}
const repository = /github\.com[:/](.+?)(\.git)?$/.exec(git(['remote', 'get-url', 'origin']))?.[1]
console.log(`\n✔ 已推送 ${tag}。GitHub Actions 正在构建，十几分钟后发布：`)
if (repository !== undefined) {
  console.log(`  构建进度  https://github.com/${repository}/actions`)
  console.log(`  发布页面  https://github.com/${repository}/releases/tag/${tag}`)
}

/** The editor git uses (GIT_EDITOR, core.editor, VISUAL, EDITOR); Notepad on Windows when none is set. */
function editorCommand() {
  let configured
  try { configured = git(['config', '--get', 'core.editor']) } catch { /* not set */ }
  const editor = [process.env.GIT_EDITOR, configured, process.env.VISUAL, process.env.EDITOR].find(e => e !== undefined && e.trim() !== '')
  return editor ?? (process.platform === 'win32' ? 'notepad' : 'vi')
}

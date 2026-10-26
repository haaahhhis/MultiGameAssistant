/**
 * The release notes `pnpm release` drafts (scripts/release.mjs): the feat and
 * fix commits since the previous release, for the person releasing to edit.
 * The edited text becomes the tag's message, which the release workflow puts
 * on the GitHub Release.
 */
import { compareVersions } from '../../apps/desktop/updates.mjs'

/** What each kind of commit is listed under; other kinds (ci, test, chore, docs…) are not listed. */
export const SECTIONS = [
  { type: 'feat', title: '新功能' },
  { type: 'fix', title: '修复' },
]

/** The draft's instructions, removed from what is saved. */
const COMMENT = /<!--[\s\S]*?-->/g

/**
 * The release `version` follows: the newest earlier version among `tags`
 * (v-prefixed). A stable version follows the previous stable one, so its notes
 * cover its pre-releases too; a pre-release follows any earlier version.
 * @returns the tag, or undefined for the first release.
 */
export function previousTag(tags, version) {
  const stable = !version.includes('-')
  return tags
    .filter(t => /^v\d+\.\d+\.\d+/.test(t))
    .filter(t => compareVersions(t, version) < 0 && (!stable || !t.includes('-')))
    .sort((a, b) => compareVersions(b, a))[0]
}

/**
 * `type(scope)!: text` subjects → the sections' Markdown. A subject without a
 * listed type is left out.
 * @param {string[]} subjects - oldest first.
 */
export function listChanges(subjects) {
  const parsed = subjects
    .map(s => /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(s.trim()))
    .filter(m => m !== null)
  return SECTIONS
    .map(({ type, title }) => ({ title, items: parsed.filter(m => m[1].toLowerCase() === type).map(m => m[2]) }))
    .filter(s => s.items.length > 0)
    .map(s => `## ${s.title}\n\n${s.items.map(i => `- ${i}`).join('\n')}\n`)
    .join('\n')
}

/** The file opened in the editor: instructions in a comment, then the list. */
export function draftNotes({ version, previous, subjects }) {
  const changes = listChanges(subjects)
  return [
    '<!--',
    `v${version} 的发版说明${previous === undefined ? '' : `，列出了 ${previous} 之后的提交`}（feat → 新功能，fix → 修复；ci、test、chore 等不列）。`,
    '改成给用户看的话，保存并关闭编辑器就继续。这段注释会去掉，其余原样写进标签说明、发到 Release 页面。',
    '全部删空就取消发版。',
    ...(changes === '' ? ['', '（没有 feat 或 fix 提交：请写这个版本改了什么。）'] : []),
    '-->',
    '',
    changes,
  ].join('\n')
}

/** The saved draft without its instructions; empty means cancel. */
export function cleanNotes(text) {
  return text.replace(/\r\n/g, '\n').replace(COMMENT, '').trim()
}

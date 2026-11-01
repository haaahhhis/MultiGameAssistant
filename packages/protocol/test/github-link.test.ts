import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseGitHubLink } from '../src/github-link.ts'

test('parseGitHubLink reads the forms people paste', () => {
  const cases: [string, ReturnType<typeof parseGitHubLink>][] = [
    ['MaaXYZ/MaaEnd', { repo: 'MaaXYZ/MaaEnd' }],
    ['  https://github.com/MaaXYZ/MaaEnd.git  ', { repo: 'MaaXYZ/MaaEnd' }],
    ['https://www.github.com/MaaXYZ/MaaEnd/?tab=readme#install', { repo: 'MaaXYZ/MaaEnd' }],
    ['github.com/MaaXYZ/MaaEnd/issues/12', { repo: 'MaaXYZ/MaaEnd' }],
    ['git@github.com:MaaXYZ/MaaEnd.git', { repo: 'MaaXYZ/MaaEnd' }],
    ['https://github.com/MaaXYZ/MaaEnd/releases', { repo: 'MaaXYZ/MaaEnd' }],
    ['https://github.com/MaaXYZ/MaaEnd/releases/tag/v1.2.0', { repo: 'MaaXYZ/MaaEnd', tag: 'v1.2.0' }],
    ['https://github.com/MaaXYZ/MaaEnd/releases/download/v1.2.0/MaaEnd-win-x86_64-v1.2.0.zip', { repo: 'MaaXYZ/MaaEnd', tag: 'v1.2.0', asset: 'MaaEnd-win-x86_64-v1.2.0.zip' }],
    ['https://ghproxy.net/https://github.com/MaaXYZ/MaaEnd/releases/download/v1.2.0/a%20b.zip', { repo: 'MaaXYZ/MaaEnd', tag: 'v1.2.0', asset: 'a b.zip' }],
    ['https://github.com/MaaXYZ/MaaEnd/tree/dev', { repo: 'MaaXYZ/MaaEnd', branch: 'dev' }],
    // A folder in a branch: the branch (a branch name with a slash cannot be told apart from it).
    ['https://github.com/MaaXYZ/MaaEnd/tree/main/docs/zh_cn', { repo: 'MaaXYZ/MaaEnd', branch: 'main' }],
    ['https://github.com/MaaXYZ/MaaEnd/archive/refs/tags/v1.2.0.zip', { repo: 'MaaXYZ/MaaEnd', tag: 'v1.2.0' }],
    ['https://github.com/MaaXYZ/MaaEnd/archive/refs/heads/dev.zip', { repo: 'MaaXYZ/MaaEnd', branch: 'dev' }],
    ['https://raw.githubusercontent.com/MaaXYZ/MaaEnd/main/README.md', { repo: 'MaaXYZ/MaaEnd', branch: 'main' }],
    ['https://api.github.com/repos/MaaXYZ/MaaEnd/releases/latest', { repo: 'MaaXYZ/MaaEnd' }],
    ['https://gitee.com/someone/thing', undefined],
    ['https://github.com/MaaXYZ', undefined],
    ['not a link', undefined],
  ]
  for (const [text, expected] of cases) assert.deepEqual(parseGitHubLink(text), expected, text)
})

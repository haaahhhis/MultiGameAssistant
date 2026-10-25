import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { expandSlash, slashOptions, splitSlash } from '../src/commands.ts'

const SKILLS = [
  { name: 'game-arknights', description: '明日方舟的活动和进度' },
  { name: 'maa', description: 'MAA 的安装与运行' },
  { name: 'web-reading', description: '从网上查游戏资讯' },
]

test('the slash menu lists commands, then skills; filtered by what is typed', () => {
  assert.deepEqual(slashOptions('/', SKILLS).map(o => `${o.kind}:${o.name}`), ['command:技能', 'command:资讯', 'command:编排', 'command:诊断', 'skill:game-arknights', 'skill:maa', 'skill:web-reading'])
  assert.deepEqual(slashOptions('/诊', SKILLS).map(o => o.name), ['诊断'])
  assert.deepEqual(slashOptions('/why', SKILLS).map(o => o.name), ['诊断'], 'an alias finds its command')
  assert.deepEqual(slashOptions('/m', SKILLS).filter(o => o.kind === 'skill').map(o => o.name), ['maa', 'game-arknights'], 'names starting with it first')
  assert.deepEqual(slashOptions('/资讯 方舟', SKILLS), [], 'closed once something follows')
  assert.deepEqual(slashOptions('看 /maa', SKILLS), [])
})

test('a command or skill goes out as the typed line and its instruction; the chat folds the instruction away', () => {
  const news = expandSlash('/资讯 明日方舟', SKILLS)
  assert.match(news, /^\/资讯 明日方舟\n\n上网查「明日方舟」最近的资讯/)
  assert.match(expandSlash('/news', SKILLS), /上网查我游戏页上的游戏/)
  assert.equal(expandSlash('/maa 更新一下', SKILLS), '/maa 更新一下\n\n使用技能「maa」：先用 skill 工具加载它，再按它的说明做：更新一下')
  assert.equal(expandSlash('/nope 你好', SKILLS), '/nope 你好', 'an unknown word is left as it is')
  assert.equal(expandSlash('  帮我看看 ', SKILLS), '帮我看看')
  assert.deepEqual(splitSlash('/maa 更新一下\n\n使用技能「maa」：…'), { typed: '/maa 更新一下', expansion: '使用技能「maa」：…' })
  assert.equal(splitSlash('普通的话\n\n第二段'), undefined)
})

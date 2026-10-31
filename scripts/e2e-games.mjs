#!/usr/bin/env node
/**
 * End-to-end check of M6 against a running host, with no game, no wiki and
 * no API key: a fake Semantic MediaWiki plays the data site, a fake model
 * plays the agent, a fake Feishu Open Platform receives the report.
 *
 * 1. A Game Pack of the user's (in the data folder) is picked up; its data
 *    site is read without a model.
 * 2. 「让 agent 进游戏读取」: the agent, in a session of its own, refreshes the
 *    site and records what it read on the screen; the calendar merges both
 *    and calls out where the game and the site disagree.
 * 3. The daily report lists events by how soon they end, with what is left;
 *    sent, the agent summarizes only the recent ones (given to it as a
 *    digest), and that summary goes to Feishu as a card.
 * 4. 「让 agent 去找」 a game nobody set up: the agent adds it with game_add
 *    (a wiki source), and its events are read at once.
 * 5. 「添加网址」: a page added to a game becomes a source the agent reads at
 *    once (its own session); it can be removed again.
 *
 *   ADG_GATEWAY_TOKEN=dev-token ADG_FEISHU_BASE_URL=http://127.0.0.1:3299 pnpm dev:host
 *   ADG_GATEWAY_TOKEN=dev-token pnpm e2e:games
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { devHome } from '../apps/desktop/profile.mjs'
import { startFakeFeishu, startFakeLlm } from '../packages/test-kit/lib/index.js'
import { connectGateway, FAKE_MODEL, FAKE_PROVIDER, removeFakeProvider, saveFakeProvider } from './lib/gateway.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.ADG_DATA_DIR ?? join(devHome(join(here, '..')), 'adg', 'data')
const GAME = 'e2e-game'
const ADDED = 'e2e-added'
const APP_ID = 'cli_a1b2c3d4e5f60718'
const USER = 'ou_7d8a6e2e00000000000000000000e2e6'
const SECRET_REF = 'ADG_FEISHU_APP_SECRET'
const FEISHU_PORT = Number(process.env.ADG_FAKE_FEISHU_PORT ?? 3299)
const DAY = 86_400_000
const HOUR = 3_600_000
const now = Date.now()

// ── the data site: a fake Semantic MediaWiki answering action=ask ──
const asks = []
const at = ms => ({ timestamp: String(Math.floor(ms / 1000)), raw: '' })
const wiki = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname !== '/api.php' || url.searchParams.get('action') !== 'ask') { res.writeHead(404).end(); return }
  asks.push(url.searchParams.get('query'))
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    query: {
      results: {
        甲活动: { printouts: { 名称: ['SideStory「E2E 活动甲」'], 开始: [at(now - 10 * DAY)], 结束: [at(now + 2 * DAY + 5 * HOUR)], 商店结束: [at(now + 9 * DAY)] } },
        乙活动: { printouts: { 名称: ['乙活动'], 开始: [at(now - 2 * DAY)], 结束: [at(now + 3 * DAY + 5 * HOUR)], 商店结束: [] } },
        常驻: { printouts: { 名称: ['常驻'], 开始: [at(now - 400 * DAY)], 结束: [{ timestamp: String(Date.UTC(9999, 0, 1) / 1000) }], 商店结束: [] } },
      },
    },
  }))
})
await new Promise(resolve => wiki.listen(0, '127.0.0.1', resolve))
const wikiUrl = `http://127.0.0.1:${wiki.address().port}`

const packDir = join(dataDir, 'games', GAME)
mkdirSync(packDir, { recursive: true })
writeFileSync(join(packDir, 'game.yaml'), `id: ${GAME}
name: E2E 游戏
aliases: [端到端游戏]
screen:
  target: emulator
sources:
  - id: fakewiki
    name: 假 WIKI
    homepage: ${wikiUrl}/
    smw:
      api: ${wikiUrl}/api.php
      conditions: '[[分类:活动]]'
      title: 名称
      start: 开始
      end: 结束
      shopEnd: 商店结束
`)
writeFileSync(join(packDir, 'GAME.md'), `---\nname: game-${GAME}\ndescription: M6 端到端检查用的假游戏。\n---\n\n# E2E 游戏\n`)

const call = (name, args) => ({ toolCalls: [{ name, arguments: args }] })
const SUMMARY = '【E2E 游戏】E2E 活动甲只剩 2 天，商店还差 2 项没换，记得去换；乙活动前两天刚开始，已经做完。'
const llm = await startFakeLlm({
  models: [FAKE_MODEL],
  replies: [
    call('game_sites_refresh', { game: GAME }),
    call('game_record', { game: GAME, source: 'screen', activities: [
      { name: 'E2E 活动甲', remaining: '剩余 2天3小时', todo: ['活动商店还剩 2 项没换'] },
      { name: '乙活动', remaining: '剩余 9天', done: ['关卡全部通关'] },
    ] }),
    { text: 'E2E 活动甲还剩 2 天，商店还有 2 项没换；乙活动关卡都通关了。' },
    { text: SUMMARY },
    call('game_add', { id: ADDED, name: 'E2E 新游戏', aliases: ['新游戏'], timezone: 'Asia/Shanghai', sources: [{ id: 'wiki', name: '假 WIKI', homepage: `${wikiUrl}/`, smw: { api: `${wikiUrl}/api.php`, conditions: '[[分类:活动]]', title: '名称', start: '开始', end: '结束', shopEnd: '商店结束' } }], guide: '活动看假 WIKI。' }),
    { text: '加好了 E2E 新游戏，假 WIKI 能自动读。' },
  ],
  fallback: { text: '好的。' },
  scripted: body => Array.isArray(body.tools) && body.tools.length > 0,
})
const feishu = await startFakeFeishu({ appId: APP_ID, appSecret: 'secret-ok', port: FEISHU_PORT })
const gateway = await connectGateway({ name: 'adg-e2e-games' })
const { call: rpc } = gateway
const steps = []
const step = (name, detail = '') => { steps.push(name); console.log(`✔ ${name}${detail === '' ? '' : `: ${detail}`}`) }
const fail = message => { throw new Error(message) }
const until = async (what, check, ms = 60_000) => {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) fail(`timed out waiting for ${what}`)
    await delay(300)
  }
}
const mine = async () => (await rpc('games/list', {})).activities.filter(a => a.game === GAME)

let settingsBefore
try {
  for (const cap of ['games', 'notify', 'feishu']) if (!gateway.capabilities.includes(cap)) fail(`capability ${cap} missing; rebuild and restart pnpm dev:host`)

  // 1. the user's Game Pack and its data site
  const listed = await rpc('games/list', {})
  settingsBefore = listed.settings
  const game = listed.games.find(g => g.id === GAME)
  if (game === undefined || game.builtin || !game.sources[0]?.auto) fail('the user Game Pack was not picked up')
  const { results } = await rpc('games/refresh', { game: GAME })
  if (!results[0]?.ok || results[0].count !== 2) fail(`refresh: ${JSON.stringify(results)}`)
  if (!asks[0]?.includes('[[分类:活动]][[结束::>') || !asks[0].includes(' OR ')) fail(`unexpected query: ${asks[0]}`)
  const site = await mine()
  if (site.length !== 2 || site.some(a => a.site?.source !== 'fakewiki')) fail(`calendar after refresh: ${JSON.stringify(site)}`)
  step('a Game Pack in the data folder was picked up; its wiki was read without a model', `${site.map(a => a.name).join('、')}（常驻的没有算进来）`)

  // 2. the agent reads the game
  await saveFakeProvider(rpc, `${llm.url}/v1`)
  const { sessionId: uiSession } = await rpc('sessions/create', {})
  await until('the fake model route', () => rpc('session/selectModel', { sessionId: uiSession, provider: FAKE_PROVIDER, model: FAKE_MODEL }).then(() => true, () => false))
  const { sessionId } = await rpc('games/read', { game: GAME })
  const reading = await until('the agent to finish reading', async () => {
    const g = (await rpc('games/list', {})).games.find(x => x.id === GAME)
    return g?.reading?.state !== 'running' && g?.reading?.sessionId === sessionId ? g.reading : undefined
  }, 120_000)
  if (reading.state !== 'done') fail(`reading ${reading.state}: ${reading.summary}`)
  const asked = llm.requests.find(r => JSON.stringify(r.messages ?? []).includes('读取「E2E 游戏」现在的活动和进度'))
  if (asked === undefined) fail('the agent never got the reading prompt')
  const tools = (asked.tools ?? []).map(t => t.function?.name ?? t.name)
  for (const name of ['game_sites_refresh', 'game_record', 'game_activities', 'screen_capture']) if (!tools.includes(name)) fail(`the agent has no ${name} tool`)
  const read = await mine()
  const first = read.find(a => a.name === 'SideStory「E2E 活动甲」')
  const second = read.find(a => a.name === '乙活动')
  if (first?.screen === undefined || first.todo[0] !== '活动商店还剩 2 项没换' || first.mismatch !== undefined) fail(`甲: ${JSON.stringify(first)}`)
  if (second?.mismatch === undefined || !second.mismatch.includes('以 假 WIKI 为准')) fail(`乙: ${JSON.stringify(second)}`)
  if (Math.abs(second.endsAt - (now + 3 * DAY + 5 * HOUR)) > 60_000) fail('the site end was not kept')
  step('the agent read the game in its own session; the calendar merged it with the site', `${reading.summary}；乙：${second.mismatch}`)

  // 3. the report, to Feishu
  await rpc('games/settings/set', { report: { games: [GAME], ai: true } })
  const preview = await rpc('games/report/preview', {})
  const lines = preview.text.split('\n')
  if (lines[0] !== '【E2E 游戏】' || !/^· ⚠ SideStory「E2E 活动甲」：还剩 2 天.+ · 还没做：活动商店还剩 2 项没换$/.test(lines[1] ?? '') || !/^· 乙活动：还剩 3 天.+都做完了/.test(lines[2] ?? '')) fail(`report:\n${preview.text}`)
  await rpc('credentials/set', { ref: SECRET_REF, value: 'secret-ok' })
  await rpc('feishu/settings/set', { appId: APP_ID, enabled: true })
  await until('the Feishu bot to connect (was the host started with ADG_FEISHU_BASE_URL?)', async () => (await rpc('notify/status', {})).channels.find(c => c.id === 'feishu')?.state === 'ready' && feishu.connected())
  await feishu.sendMessage({ openId: USER, text: '你好' })
  await feishu.waitForMessage(m => m.kind === 'reply' && m.text.includes(`open_id：${USER}`))
  await rpc('feishu/users/allow', { openId: USER, name: 'E2E 用户' })
  const sent = await rpc('games/report/send', {})
  if (!sent.channels.includes('飞书')) fail(`report sent to ${JSON.stringify(sent.channels)}`)
  const card = await feishu.waitForMessage(m => m.kind === 'create' && m.msgType === 'interactive' && m.text.includes('今日活动日报') && m.text.includes('记得去换'))
  const digest = JSON.stringify(llm.requests.find(r => JSON.stringify(r.messages ?? []).includes('日报正文'))?.messages ?? [])
  if (!digest.includes('快结束：还剩 2 天') || !digest.includes('还没做：活动商店还剩 2 项没换') || !digest.includes('新开始')) fail(`the agent was not given the recent events: ${digest.slice(0, 600)}`)
  if (sent.text !== SUMMARY) fail(`sent text: ${sent.text}`)
  const after = await rpc('games/list', {})
  if (after.report.lastResult !== '已发到飞书' || after.report.lastSentAt === undefined || after.report.lastText !== SUMMARY) fail(`report state: ${JSON.stringify(after.report)}`)
  step('the agent summarized the recent events; the summary went to Feishu as a card', `${card.to} · ${preview.title}`)

  // 4. a game nobody set up
  const { sessionId: discoverSession } = await rpc('games/discover', { name: 'E2E 新游戏' })
  await until('the added game and its events', async () => {
    const list = await rpc('games/list', {})
    return list.games.some(g => g.id === ADDED) && list.activities.some(a => a.game === ADDED && a.name === 'SideStory「E2E 活动甲」')
  }, 120_000)
  const added = (await rpc('games/list', {})).games.find(g => g.id === ADDED)
  if (!existsSync(join(dataDir, 'games', ADDED, 'game.yaml')) || !existsSync(join(dataDir, 'games', ADDED, 'GAME.md'))) fail('the added pack is not in the data folder')
  step('「让 agent 去找」: game_add made a pack and its wiki was read at once', `${added.name} · ${discoverSession}`)

  // 5. a page added on the game page
  const page = `${wikiUrl}/news/2026`
  const linked = await rpc('games/source/add', { game: GAME, url: page })
  const withLink = (await rpc('games/list', {})).games.find(g => g.id === GAME)
  const chip = withLink.sources.find(s => s.id === linked.source)
  if (chip?.homepage !== page || chip.added !== true || chip.auto) fail(`the added page: ${JSON.stringify(withLink.sources)}`)
  if (withLink.webReading?.sessionId !== linked.sessionId) fail(`the agent is not reading it: ${JSON.stringify(withLink.webReading)}`)
  await until('the agent to be asked about the page', () => llm.requests.some(r => JSON.stringify(r.messages ?? []).includes(page)), 60_000)
  await rpc('games/source/remove', { game: GAME, source: linked.source })
  if ((await rpc('games/list', {})).games.find(g => g.id === GAME).sources.some(s => s.id === linked.source)) fail('the page is still a source after removing it')
  step('「添加网址」: the page became a source the agent read at once; removed again', `${chip.name} · ${linked.sessionId}`)

  console.log(`\nM6 end-to-end OK (${steps.length} steps); the fake wiki answered ${asks.length} queries, the fake model ${llm.requests.length} requests`)
} catch (error) {
  console.error(`\n✘ failed after: ${steps.join(' → ') || 'nothing'}\n  ${error.message}`)
  process.exitCode = 1
} finally {
  for (const a of await mine().catch(() => [])) await rpc('games/activity/remove', { activityId: a.id }).catch(() => {})
  if (settingsBefore !== undefined) await rpc('games/settings/set', { report: { games: settingsBefore.report.games, ai: settingsBefore.report.ai } }).catch(() => {})
  await rpc('feishu/users/remove', { openId: USER }).catch(() => {})
  await rpc('feishu/settings/set', { enabled: false, appId: null }).catch(() => {})
  await rpc('credentials/unset', { ref: SECRET_REF }).catch(() => {})
  await removeFakeProvider(rpc)
  rmSync(packDir, { recursive: true, force: true })
  for (const a of (await rpc('games/list', {}).catch(() => ({ activities: [] }))).activities.filter(x => x.game === ADDED)) await rpc('games/activity/remove', { activityId: a.id }).catch(() => {})
  rmSync(join(dataDir, 'games', ADDED), { recursive: true, force: true })
  gateway.close()
  await llm.close()
  await feishu.close()
  wiki.close()
}

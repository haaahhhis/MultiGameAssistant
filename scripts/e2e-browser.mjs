/**
 * The built-in browser end to end, in a real Electron: what the agent's
 * tools do through the bridge (open, read, click, type, press, scroll,
 * screenshot, tabs), what it refuses, the frames the panel shows and the
 * user's clicks in it.
 *
 *   pnpm e2e:browser
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// ELECTRON_PATH: another electron.exe, e.g. a copy outside a checkout that dsh's sandbox labeled low-integrity
// (an Electron started from there runs at low integrity: no Chromium sandbox, no loopback connections to it).
const electron = process.env.ELECTRON_PATH || createRequire(join(root, 'apps', 'desktop', 'package.json'))('electron')
// --no-sandbox: started from a restricted process (an agent's shell), Chromium's own sandbox cannot set up
// and Electron dies at once (0x80000003). The harness only loads its own local test page.
const child = spawn(electron, ['--no-sandbox', join(root, 'scripts', 'lib', 'browser-harness.mjs')], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } })

const lines = []
const waiters = []
let buffer = ''
child.stdout.on('data', chunk => {
  buffer += chunk
  let i
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    lines.push(line)
    for (const w of [...waiters]) if (line.startsWith(w.prefix)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(line) }
  }
})
const line = (prefix, ms = 30_000) => {
  const seen = lines.find(l => l.startsWith(prefix))
  if (seen !== undefined) return Promise.resolve(seen)
  return new Promise((resolve, reject) => {
    const waiter = { prefix, resolve }
    waiters.push(waiter)
    setTimeout(() => reject(new Error(`no "${prefix}" line in ${ms} ms`)), ms)
  })
}

let failed = false
/** The harness's own controls (scripts/lib/browser-harness.mjs). */
let control = async _path => {}
try {
  const [, url, token, page, controlUrl] = (await line('BRIDGE')).split(' ')
  control = path => fetch(`${controlUrl}${path}`).then(r => r.text())
  const call = async (method, params = {}) => {
    const response = await fetch(`${url}/call`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) })
    const body = await response.json()
    if (!body.ok) throw new Error(body.error)
    return body.result
  }
  const step = (name, fn) => fn().then(() => console.log(`ok   ${name}`), error => { failed = true; console.log(`FAIL ${name}: ${error.stack ?? error}`) })
  const refOf = (snapshot, pattern) => {
    const found = snapshot.split('\n').find(l => pattern.test(l))?.match(/\[ref=(e\d+)\]/)?.[1]
    assert.ok(found, `no ref for ${pattern} in:\n${snapshot}`)
    return found
  }
  const S = 'session-a'
  let opened

  await step('a wrong token is refused', async () => {
    const response = await fetch(`${url}/call`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' })
    assert.equal(response.status, 401)
  })
  await step('open a page: its text and refs come back', async () => {
    opened = await call('navigate', { session: S, url: page })
    assert.equal(opened.title, '测试页')
    assert.match(opened.snapshot, /heading "活动日历"/)
    assert.match(opened.snapshot, /link "下一页" \[ref=e\d+\]/)
    assert.match(opened.snapshot, /searchbox "搜索" \[ref=e\d+\] value="旧的"/)
  })
  await step('click a button by ref', async () => {
    const after = await call('click', { session: S, ref: refOf(opened.snapshot, /button "点我"/) })
    assert.match(after.snapshot, /button "点过了"/)
    opened = after
  })
  await step('type into a field (replacing what was there) and submit', async () => {
    const after = await call('type', { session: S, ref: refOf(opened.snapshot, /searchbox "搜索"/), text: '原神', submit: true })
    assert.match(after.snapshot, /搜到：原神/)
    opened = after
  })
  await step('a checkbox and a key press', async () => {
    const after = await call('click', { session: S, ref: refOf(opened.snapshot, /checkbox "记住我"/) })
    assert.match(after.snapshot, /checkbox "记住我" \[ref=e\d+\] \[checked\]/)
    await call('press', { session: S, key: 'Control+A' })
    await assert.rejects(call('press', { session: S, key: 'Hyper+Q' }), /修饰键/)
  })
  await step('scroll to the bottom', async () => {
    await call('scroll', { session: S, direction: 'down', amount: 4000 })
    const text = await call('text', { session: S })
    assert.match(text.text, /页面底部/)
  })
  await step('a stale or unknown ref is explained', async () => {
    await assert.rejects(call('click', { session: S, ref: 'e999' }), /browser_snapshot/)
  })
  await step('screenshot while the panel is hidden', async () => {
    const shot = await call('screenshot', { session: S })
    assert.ok(shot.width > 100 && shot.height > 100, `size ${shot.width}x${shot.height}`)
    assert.ok(Buffer.from(shot.png, 'base64').subarray(1, 4).toString() === 'PNG')
  })
  await step('a link navigates; back returns', async () => {
    const page1 = await call('snapshot', { session: S })
    const second = await call('click', { session: S, ref: refOf(page1.snapshot, /link "下一页"/) })
    assert.equal(second.title, '第二页')
    const back = await call('navigate', { session: S, action: 'back' })
    assert.equal(back.title, '测试页')
  })
  await step('a page opening a window opens a tab instead', async () => {
    const page1 = await call('snapshot', { session: S })
    await call('click', { session: S, ref: refOf(page1.snapshot, /button "新窗口"/) })
    await new Promise(resolve => setTimeout(resolve, 1500))
    const { tabs } = await call('tabs', { session: S, action: 'list' })
    assert.equal(tabs.length, 2, JSON.stringify(tabs))
  })
  await step('another session gets its own tab', async () => {
    const other = await call('navigate', { session: 'session-b', url: `${page}second` })
    assert.equal(other.title, '第二页')
    const mine = await call('snapshot', { session: S })
    assert.notEqual(mine.tab, other.tab)
  })
  await step('local files, the app\'s own pages and other schemes are refused', async () => {
    await assert.rejects(call('navigate', { session: S, url: 'file:///C:/Windows/win.ini' }), /http \/ https/)
    await assert.rejects(call('navigate', { session: S, url: 'http://127.0.0.1:1/' }), /自己的界面/)
    await assert.rejects(call('navigate', { session: S, url: 'javascript:alert(1)' }), /http \/ https/)
  })
  await step('the panel gets frames of the shown tab at its size, and none when it is hidden', async () => {
    const shown = JSON.parse(await control('/show?w=640&h=480'))
    assert.ok(shown.count >= 1, JSON.stringify(shown))
    assert.deepEqual([shown.width, shown.height, shown.jpeg], [640, 480, true])
  })
  await step('a click of the user in the panel reaches the page', async () => {
    const { tabs } = await call('tabs', { session: S, action: 'list' })
    await call('tabs', { session: S, action: 'select', tab: tabs.find(t => t.title === '测试页').id })
    // A button fixed at the top left of the page.
    await control('/userclick?x=60&y=20')
    await new Promise(resolve => setTimeout(resolve, 500))
    const page1 = await call('snapshot', { session: S })
    assert.match(page1.snapshot, /button "用户点过了"/)
  })
} catch (error) {
  failed = true
  console.log(`FAIL ${error.stack ?? error}`)
} finally {
  await control('/quit').catch(() => {})
  setTimeout(() => child.kill(), 3000).unref()
}
process.exitCode = failed ? 1 : 0

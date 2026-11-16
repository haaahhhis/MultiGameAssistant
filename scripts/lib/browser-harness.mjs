/**
 * Electron main script for scripts/e2e-browser.mjs: the built-in browser
 * (apps/desktop/browser.mjs) in a hidden window, its bridge, and a local test
 * page. Prints one line `BRIDGE <url> <token> <page url> <control url>` and
 * stays up until the test calls `<control url>/quit`.
 */
import { app } from 'electron'
import { createServer } from 'node:http'
import { AgentBrowser } from '../../apps/desktop/browser.mjs'
import { startBrowserBridge } from '../../apps/desktop/browser-bridge.mjs'

const PAGE = `<!doctype html><html><head><title>测试页</title></head><body>
<h1>活动日历</h1>
<p>这里是说明文字。</p>
<a href="/second">下一页</a>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = '搜到：' + document.getElementById('q').value">
  <label for="q">搜索</label><input id="q" type="search" value="旧的">
  <button type="submit">搜索</button>
</form>
<button onclick="this.textContent = '点过了'">点我</button>
<label><input type="checkbox" id="c"> 记住我</label>
<div id="out"></div>
<div style="height: 3000px"></div>
<p id="bottom">页面底部</p>
<button onclick="window.open('/second')">新窗口</button>
<button style="position: fixed; top: 0; left: 0; width: 120px; height: 40px" onclick="this.textContent = '用户点过了'">用户按钮</button>
</body></html>`
const SECOND = '<!doctype html><title>第二页</title><h2>第二页的标题</h2>'

// Electron shows an uncaught error in a dialog that nobody closes here: say it instead.
process.on('uncaughtException', error => console.log(`UNCAUGHT ${error.stack ?? error}`))
process.on('unhandledRejection', error => console.log(`UNHANDLED ${error?.stack ?? error}`))

app.whenReady().then(async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(request.url === '/second' ? SECOND : PAGE)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const pageUrl = `http://127.0.0.1:${server.address().port}/`
  const browser = new AgentBrowser({ blocked: () => ['http://127.0.0.1:1'], log: m => console.error(m) })
  const bridge = await startBrowserBridge(browser)
  // The test's own controls (stdin does not reach Electron's main process on Windows):
  // /userclick?x=&y= clicks as the user would in the panel, /quit ends.
  let frames = []
  browser.on('frame', frame => frames.push(frame))
  const control = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://x')
    // /show?w=&h= puts the panel on screen for a second: what came in frames.
    if (url.pathname === '/show') {
      frames = []
      browser.show({ width: Number(url.searchParams.get('w')), height: Number(url.searchParams.get('h')) })
      await new Promise(resolve => setTimeout(resolve, 1000))
      browser.show(undefined)
      const last = frames.at(-1)
      return response.end(JSON.stringify({ count: frames.length, width: last?.width, height: last?.height, jpeg: last === undefined ? false : last.data[0] === 0xff && last.data[1] === 0xd8 }))
    }
    if (url.pathname === '/userclick') {
      // As the panel sends it.
      const at = { x: Number(url.searchParams.get('x')), y: Number(url.searchParams.get('y')) }
      browser.input({ type: 'mouseMove', ...at })
      for (const type of ['mouseDown', 'mouseUp']) browser.input({ type, ...at, button: 'left', clickCount: 1 })
    }
    response.end('ok')
    if (url.pathname === '/quit') { browser.closeAll(); bridge.close(); server.close(); control.close(); app.quit() }
  })
  await new Promise(resolve => control.listen(0, '127.0.0.1', resolve))
  console.log(`BRIDGE ${bridge.url} ${bridge.token} ${pageUrl} http://127.0.0.1:${control.address().port}`)
  // Never outlive a test that died.
  setTimeout(() => app.quit(), 170_000).unref()
})

#!/usr/bin/env node
/**
 * Open the development build by hand: start the dev host (dsh with the app's
 * profile, scripts/run-dsh.mjs) and the web dev server (Vite) in the
 * background when they are not running yet, then open the page in the
 * default browser. They stay running after this exits, until `--stop` (or a
 * restart of the computer); running it again only opens the page.
 *
 * Both get a fixed gateway token (`dev-token`, the same .claude/launch.json
 * uses), which the dev server passes to the page, so it opens without a
 * `?token=`. It is only a development value: the host listens on 127.0.0.1.
 * Their output goes to `<dev home>/logs/dev-host.log` and `dev-web.log`.
 *
 *   node scripts/dev-open.mjs           start what is not running, open the page
 *   node scripts/dev-open.mjs --stop    stop what this started
 *   node scripts/dev-open.mjs --no-open start only
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { devHome } from '../apps/desktop/profile.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = devHome(root)
const logs = join(home, 'logs')
const pids = join(home, 'dev-servers.json')
const TOKEN = 'dev-token'
const HOST_PORT = 3290
const WEB_PORT = 5173
const PAGE = `http://localhost:${WEB_PORT}/`
const args = process.argv.slice(2)

/** Something answers on the port at this address. */
const answers = (host, port) => new Promise(done => {
  const socket = connect({ host, port })
  socket.once('connect', () => { socket.destroy(); done(true) })
  socket.once('error', () => done(false))
  socket.setTimeout(1000, () => { socket.destroy(); done(false) })
})
/** Something answers on the port: the host listens on 127.0.0.1, Vite on `localhost` (often ::1 on Windows). */
const listening = async port => (await answers('127.0.0.1', port)) || answers('::1', port)

async function waitFor(port, what, seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await listening(port)) return
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`${what} did not start within ${seconds}s: see ${join(logs, what === 'the host' ? 'dev-host.log' : 'dev-web.log')}`)
}

function readPids() {
  try { return JSON.parse(readFileSync(pids, 'utf8')) } catch { return {} }
}

function start(name, script, scriptArgs) {
  mkdirSync(logs, { recursive: true })
  const out = openSync(join(logs, `dev-${name}.log`), 'a')
  const child = spawn(process.execPath, [script, ...scriptArgs], {
    cwd: root,
    env: { ...process.env, ADG_GATEWAY_TOKEN: TOKEN },
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  })
  child.unref()
  writeFileSync(pids, JSON.stringify({ ...readPids(), [name]: child.pid }, null, 1))
  console.log(`started the ${name} (pid ${child.pid}), output in ${join(logs, `dev-${name}.log`)}`)
}

if (args.includes('--stop')) {
  const running = readPids()
  for (const [name, pid] of Object.entries(running)) {
    // The host has dsh under it: the whole tree goes.
    let stopped = false
    if (process.platform === 'win32') stopped = spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).status === 0
    else try { process.kill(-pid); stopped = true } catch { /* not running */ }
    console.log(stopped ? `stopped the ${name} (pid ${pid})` : `the ${name} (pid ${pid}) was not running`)
  }
  if (existsSync(pids)) rmSync(pids)
  if (Object.keys(running).length === 0) console.log('nothing this started is running')
  process.exit(0)
}

if (await listening(HOST_PORT)) console.log(`the host is already running on ${HOST_PORT}`)
else start('host', join(root, 'scripts', 'run-dsh.mjs'), [])
if (await listening(WEB_PORT)) console.log(`the web dev server is already running on ${WEB_PORT}`)
else start('web', join(root, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js'), ['apps/web'])

await waitFor(HOST_PORT, 'the host', 90)
await waitFor(WEB_PORT, 'the web dev server', 60)
if (!args.includes('--no-open')) {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', PAGE], { stdio: 'ignore', detached: true, windowsHide: true }).unref()
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [PAGE], { stdio: 'ignore', detached: true }).unref()
  console.log(`opened ${PAGE}`)
}

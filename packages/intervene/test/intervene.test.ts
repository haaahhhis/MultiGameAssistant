import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Incident, RunInfo } from '@adg/protocol'
import type { Holder } from '@adg/runner'
import { schemaProblems } from '../../test-kit/src/schema-lint.ts'
import { Interventions } from '../src/interventions.ts'
import { decodePng, encodePng, fitPng, pngSize, shrink } from '../src/png.ts'
import { Screens, toDevice, type Frame } from '../src/screens.ts'
import { screenTools } from '../src/tools.ts'
import type { WinHelper } from '../src/winhelper.ts'

/** A w×h PNG: red left half, blue right half. */
function picture(w: number, h: number): Buffer {
  const data = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(x < w / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * w + x) * 4)
  return encodePng({ width: w, height: h, data })
}

test('PNG: encode, decode and shrink keep the picture', () => {
  const png = picture(400, 200)
  assert.deepEqual(pngSize(png), { width: 400, height: 200 })
  const raster = decodePng(png)
  assert.deepEqual([...raster.data.subarray(0, 4)], [255, 0, 0, 255])
  assert.deepEqual([...raster.data.subarray((399) * 4, 400 * 4)], [0, 0, 255, 255])
  const small = shrink(raster, 100)
  assert.deepEqual([small.width, small.height], [100, 50])
  assert.deepEqual([...small.data.subarray(0, 4)], [255, 0, 0, 255])
  const fitted = fitPng(png, 100)
  assert.equal(fitted.scale, 0.25)
  assert.deepEqual(pngSize(fitted.png), { width: 100, height: 50 })
  assert.equal(fitPng(png, 1280).png, png, 'small enough: unchanged')
})

test('coordinates in a shrunk window screenshot map back to the screen', () => {
  const frame: Frame = { target: 'window', label: '窗口「游戏」', lockKey: 'desktop', originX: 1920, originY: 100, scale: 0.5, width: 960, height: 540, hwnd: 42 }
  assert.deepEqual(toDevice(frame, 480, 270), { x: 2880, y: 640 })
  assert.throws(() => toDevice(frame, 961, 10), /不在截图里/)
})

function fakeWin() {
  const calls: Record<string, unknown>[] = []
  const win = {
    call: async (op: string, args: Record<string, unknown> = {}) => { calls.push({ op, ...args }); return true },
    windows: async () => [{ hwnd: 42, title: '终末地', pid: 7, process: 'Endfield', x: 100, y: 50, width: 1280, height: 720, minimized: false }],
    capture: async (hwnd = 0) => ({ png: picture(hwnd === 0 ? 2560 : 1280, hwnd === 0 ? 1440 : 720), x: hwnd === 0 ? 0 : 100, y: hwnd === 0 ? 0 : 50, width: 1, height: 1 }),
  }
  return { win: win as unknown as WinHelper, calls }
}

test('screens: the emulator through ADB, a window through the helper, in screenshot coordinates', async () => {
  const shell: string[] = []
  const { win, calls } = fakeWin()
  const screens = new Screens({
    adb: () => ({ screencap: async () => picture(1920, 1080), shell: async (_a, args) => { shell.push(args.join(' ')); return '' }, expectedAddress: async () => '127.0.0.1:16384' }),
    win, maxEdge: () => 1280,
  })
  const emu = await screens.capture('emulator', { signal: AbortSignal.timeout(5000) })
  assert.deepEqual([emu.frame.width, emu.frame.height, emu.frame.lockKey], [1280, 720, 'adb:127.0.0.1:16384'])
  await screens.tap(emu.frame, 640, 360)
  await screens.swipe(emu.frame, 100, 600, 100, 100, 300)
  await screens.key(emu.frame, 'back')
  await screens.type(emu.frame, "it's ok")
  assert.deepEqual(shell, ['input tap 960 540', 'input swipe 150 900 150 150 300', 'input keyevent 4', `input text 'it'\\''s%sok'`])
  await assert.rejects(screens.type(emu.frame, '中文'), /只能直接输入英文/)
  await assert.rejects(screens.key(emu.frame, 'f5'), /模拟器上能按的键/)

  const window = await screens.capture('window', { window: '终末', signal: AbortSignal.timeout(5000) })
  assert.equal(window.frame.label, '窗口「终末地」')
  await screens.tap(window.frame, 640, 360, { double: true })
  assert.deepEqual(calls.slice(-2), [{ op: 'focus', hwnd: 42 }, { op: 'click', x: 740, y: 410, button: 'left', double: true }])
  const desktop = await screens.capture('desktop', { signal: AbortSignal.timeout(5000) })
  assert.equal(desktop.frame.scale, 0.5)
  await screens.key(desktop.frame, 'ctrl+a')
  assert.deepEqual(calls.at(-1), { op: 'keys', keys: 'ctrl+a' })
  await assert.rejects(screens.findWindow('记事本'), /没有标题包含「记事本」的窗口。现有窗口：终末地/)
})

function interventions(over: { ask?: (sessionId: string, text: string, images: readonly Buffer[]) => Promise<string>; vision?: string; run?: Partial<RunInfo> } = {}) {
  const suspended: string[] = []
  const restarted: string[] = []
  let made = 0
  const run = { id: 'run-1', state: 'running', resources: ['adb:127.0.0.1:16384'], ...over.run } as RunInfo
  let iv!: Interventions
  iv = new Interventions({
    runner: {
      get: () => run, processId: () => 4242,
      restart: async id => { restarted.push(id); return run }, stop: async () => {}, note: () => {},
    },
    suspend: async (pid, resume) => { suspended.push(`${resume ? 'resume' : 'suspend'} ${pid}`); return 2 },
    conversations: () => ({
      create: async () => `s-${++made}`,
      exists: async () => true,
      ask: async (sessionId, text, _signal, images = []) => (over.ask ?? (async () => '好的'))(sessionId, text, images),
    }),
    visionProblem: async () => over.vision,
    describeTargets: r => r.resources.join('、'),
    onChange: () => {},
    dataDir: mkdtempSync(join(tmpdir(), 'adg-iv-')),
    timeoutMs: 500,
    log: { info() {}, warn() {} },
  })
  return { iv: () => iv, suspended, restarted }
}

const incident: Incident = {
  id: 'inc-1', runId: 'run-1', scriptId: 'maa', scriptName: 'MAA', taskId: 'daily', taskTitle: '日常', kind: 'error', severity: 'error',
  tag: 'task-error', title: 'MAA · 日常：出错', detail: '任务出错: 游戏更新', lines: ['[ERR] 任务出错: 游戏更新'], status: 'open', createdAt: 0, updatedAt: 0, steps: [], screenshot: true,
}

test('an intervention pauses the script, hands the agent the incident and screenshot, and resumes it when resolved', async () => {
  let prompt = ''
  let images: readonly Buffer[] = []
  const env = interventions({
    ask: async (sessionId, text, imgs) => {
      prompt = text
      images = imgs
      assert.deepEqual([...env.iv().forSession(sessionId)!.allowedKeys], ['adb:127.0.0.1:16384'], 'it may act on the paused run\'s emulator')
      env.iv().done(sessionId, 'resolved', '游戏更新弹窗，已点「确认」并等更新完成')
      return '处理完了'
    },
  })
  const out = await env.iv().handle(incident, 'act', Buffer.from('png'))
  assert.equal(out.state, 'resolved')
  assert.equal(out.summary, '游戏更新弹窗，已点「确认」并等更新完成')
  assert.deepEqual(env.suspended, ['suspend 4242', 'resume 4242'])
  assert.match(prompt, /脚本已经暂停/)
  assert.match(prompt, /任务出错: 游戏更新/)
  assert.match(prompt, /intervention_done/)
  assert.equal(images[0]?.toString(), 'png')
  assert.equal(env.iv().list()[0]?.state, 'resolved')
  assert.equal(env.iv().countToday(), 1)
})

test('retry runs the task again; give-up leaves it paused for the user; diagnose mode never pauses', async () => {
  const retry = interventions({ ask: async s => { retry.iv().done(s, 'retry', '脚本版本过旧，已更新'); return '' } })
  assert.equal((await retry.iv().handle(incident, 'act', undefined)).state, 'retried')
  assert.deepEqual(retry.restarted, ['run-1'])

  const giveUp = interventions({ ask: async s => { giveUp.iv().done(s, 'give-up', '需要输入验证码，交给你'); return '' } })
  const out = await giveUp.iv().handle(incident, 'act', undefined)
  assert.deepEqual([out.state, out.paused], ['gave-up', true])
  assert.deepEqual(giveUp.suspended, ['suspend 4242'], 'still paused')
  assert.equal(await giveUp.iv().resumeRun('run-1'), true)
  assert.deepEqual(giveUp.suspended, ['suspend 4242', 'resume 4242'])

  const diagnose = interventions({ ask: async () => '看起来是网络断了' })
  const d = await diagnose.iv().handle(incident, 'diagnose', undefined)
  assert.deepEqual([d.state, d.summary, d.paused], ['gave-up', '看起来是网络断了', false], 'no intervention_done: the answer is the summary')
  assert.deepEqual(diagnose.suspended, [])
})

test('no image-capable model, a timeout, and a takeover', async () => {
  const blind = interventions({ vision: '默认模型不能看图片' })
  assert.deepEqual([(await blind.iv().handle(incident, 'act', undefined)).state], ['failed'])
  assert.deepEqual(blind.suspended, [], 'nothing paused when it cannot start')

  const slow = interventions({ ask: () => new Promise((_, reject) => setTimeout(() => reject(new Error('aborted')), 800)) })
  assert.equal((await slow.iv().handle(incident, 'act', undefined)).state, 'timeout')

  const taken = interventions({ ask: (s) => new Promise((_, reject) => { setTimeout(() => { taken.iv().takeover(taken.iv().list()[0]!.id) ; reject(new Error('aborted')) }, 50) }) })
  const t = await taken.iv().handle(incident, 'act', undefined)
  assert.equal(t.state, 'taken-over')
  await taken.iv().release(taken.iv().list()[0]!.id, 'resume')
  assert.deepEqual(taken.suspended, ['suspend 4242', 'resume 4242'])

  // 停止 / 重试 / 忽略 / 继续 on the incident while the agent works stops the agent too.
  const cancelled = interventions({ ask: () => new Promise((_, reject) => { setTimeout(() => { cancelled.iv().cancel('inc-1', '停止'); reject(new Error('aborted')) }, 50) }) })
  const c = await cancelled.iv().handle(incident, 'act', undefined)
  assert.deepEqual([c.state, cancelled.iv().list()[0]!.summary], ['taken-over', '你已经点了「停止」，agent 已停止'])
  cancelled.iv().cancel('inc-1', '停止')
  assert.equal(cancelled.iv().list()[0]!.state, 'taken-over', 'an ended one is left alone')
})

test('screen tools: strict schemas; acting needs the lock, an intervention may act on its run, others ask once', async () => {
  const held = new Map<string, Holder>()
  const asked: string[] = []
  const shell: string[] = []
  const env = interventions({})
  let failSend = false
  const tools = screenTools({
    screens: new Screens({ adb: () => ({ screencap: async () => picture(1280, 720), shell: async (_a, args) => { shell.push(args.join(' ')); return '' }, expectedAddress: async () => '127.0.0.1:16384' }), win: fakeWin().win, maxEdge: () => 1280 }),
    interventions: env.iv(),
    locks: {
      held: () => held,
      acquire: (keys, holder) => { for (const k of keys) held.set(k, holder); return () => { for (const k of keys) held.delete(k) } },
    },
    saveImage: async () => ({ attachmentId: 'att-1', mediaType: 'image/png', bytes: 1, width: 1280, height: 720 }),
    checkVision: async () => {},
    approve: async (_exec, reason) => { asked.push(reason); return true },
    sendToSession: async () => { if (failSend) throw new Error('上传图片失败：应用缺少权限'); return true },
  })
  for (const t of tools) assert.deepEqual(schemaProblems(t.parameters), [], t.name)
  const byName = (n: string) => tools.find(t => t.name === n)!
  const exec = (session: string) => ({ agent: { session: { id: session } }, signal: AbortSignal.timeout(5000), name: 'screen_tap' }) as unknown as ToolRunContext

  const shot = await byName('screen_capture').execute({ target: 'emulator', send_to_user: true }, exec('chat')) as { width: number; sent_to_user: string }
  assert.deepEqual([shot.width, shot.sent_to_user], [1280, '已发给用户'])
  failSend = true
  const unsent = await byName('screen_capture').execute({ target: 'emulator', send_to_user: true }, exec('chat')) as { sent_to_user: string }
  assert.equal(unsent.sent_to_user, '没能发给用户：上传图片失败：应用缺少权限', 'the agent is told why, not that it was sent')
  failSend = false
  const rendered = byName('screen_capture').output.render({}, shot as never)
  assert.equal((rendered[1] as { type: string }).type, 'image')

  await byName('screen_tap').execute({ target: 'emulator', x: 10, y: 20 }, exec('chat'))
  await byName('screen_tap').execute({ target: 'emulator', x: 30, y: 40 }, exec('chat'))
  assert.equal(asked.length, 1, 'asked once per session')
  assert.deepEqual(shell, ['input tap 10 20', 'input tap 30 40'])
  assert.equal(held.size, 0, 'the short action lock is released')

  held.set('adb:127.0.0.1:16384', { runId: 'run-9', label: 'MAA · 日常' })
  await assert.rejects(byName('screen_tap').execute({ target: 'emulator', x: 1, y: 1 }, exec('chat')), /正被「MAA · 日常」使用/)
  await assert.rejects(byName('screen_tap').execute({ target: 'desktop', x: 1, y: 1 }, exec('chat')), /先用 screen_capture/)
})

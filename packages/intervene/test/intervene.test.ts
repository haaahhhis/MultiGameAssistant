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
import { ownedBy, runWindows, toRaise, unseen, type RunWindow } from '../src/hidden.ts'
import type { WinHelper, WinWindow } from '../src/winhelper.ts'

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

function fakeWin(options: { windows?: () => WinWindow[]; focused?: boolean; tree?: number[]; onRaise?: (hwnds: readonly number[]) => void } = {}) {
  const calls: Record<string, unknown>[] = []
  const win = {
    call: async (op: string, args: Record<string, unknown> = {}) => { calls.push({ op, ...args }); return true },
    focus: async (hwnd: number) => { calls.push({ op: 'focus', hwnd }); return options.focused ?? true },
    tree: async (pid: number) => options.tree ?? [pid],
    raise: async (hwnds: readonly number[]) => { calls.push({ op: 'raise', hwnds: [...hwnds] }); options.onRaise?.(hwnds) },
    windows: async () => options.windows?.() ?? [{ hwnd: 42, title: '终末地', pid: 7, process: 'Endfield', x: 100, y: 50, width: 1280, height: 720, minimized: false }],
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

function interventions(over: { ask?: (sessionId: string, text: string, images: readonly Buffer[]) => Promise<string>; vision?: string; run?: Partial<RunInfo>; windows?: RunWindow[] } = {}) {
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
    ...(over.windows === undefined ? {} : { revealWindows: async () => { suspended.push('reveal'); return over.windows! } }),
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

test("the agent's questions while it handles an incident get an answer at once; other sessions' do not", async () => {
  let answers: ReturnType<Interventions['unattended']>
  const env = interventions({
    ask: async s => {
      answers = env.iv().unattended(s, [{ id: 'q1' }, { id: 'q2' }])
      env.iv().done(s, 'give-up', '需要输入验证码，交给你')
      return ''
    },
  })
  await env.iv().handle(incident, 'act', undefined)
  assert.deepEqual(answers!.map(a => [a.id, a.selected]), [['q1', []], ['q2', []]])
  assert.match(answers![0]!.custom!, /没有人在旁边.*intervention_done/)
  assert.equal(env.iv().unattended('s-1', [{ id: 'q1' }]), undefined, 'the intervention is over')
  assert.equal(env.iv().unattended('chat', [{ id: 'q1' }]), undefined, 'not an intervention')
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
  // The agent stopped at the limit: its turn just ends, without an error and without words.
  const cut = interventions({ ask: () => new Promise(resolve => setTimeout(() => resolve('（agent 没有回复文字）'), 800)) })
  const cutShort = await cut.iv().handle(incident, 'act', undefined)
  assert.deepEqual([cutShort.state, cutShort.summary, cutShort.paused],['timeout', 'agent 在 0 分钟内没有处理完', true])

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

test('a conclusion after the intervention ended (it timed out) still reruns or resumes the task', async () => {
  const late = interventions({ ask: () => new Promise((_, reject) => setTimeout(() => reject(new Error('aborted')), 800)) })
  const out = await late.iv().handle(incident, 'act', undefined)
  assert.equal(out.state, 'timeout')
  const sessionId = late.iv().list()[0]!.sessionId!
  // The agent finished the job afterwards, in the same session.
  assert.match(await late.iv().done(sessionId, 'retry', '从鹰角启动器进了游戏'), /已经重新运行/)
  assert.deepEqual(late.restarted, ['run-1'])
  assert.deepEqual([late.iv().list()[0]!.state, late.iv().list()[0]!.paused], ['retried', false])
  await assert.rejects(late.iv().done('some-other-session', 'retry', 'x'), /不是在处理异常.*script_run/)
})

/** A window for the z-order tests. */
function w(hwnd: number, title: string, pid: number, process: string, x: number, y: number, width: number, height: number, extra: Partial<WinWindow> = {}): WinWindow {
  return { hwnd, title, pid, process, x, y, width, height, minimized: false, ...extra }
}

test("a run's windows a screenshot misses: an error box under another app's window, a minimized one, Windows' crash box", () => {
  const desktop = [
    w(1, 'NVIDIA GeForce Overlay', 50, 'NVIDIA Share', 0, 0, 2560, 1440, { topmost: true, transparent: true }),
    w(2, 'MultiGameAssistant', 60, 'MultiGameAssistant', 300, 200, 1600, 1000),
    w(3, '错误', 71, 'March7th Assistant', 900, 600, 400, 200, { dialog: true, className: '#32770' }),
    w(4, '三月七小助手', 70, 'March7th Assistant', 0, 0, 1920, 1080),
    w(5, '崩坏：星穹铁道', 80, 'StarRail', 0, 0, 2560, 1440),
    w(6, 'StarRail.exe 已停止工作', 90, 'WerFault', 1000, 600, 500, 250, { dialog: true, minimized: true }),
    w(7, '记事本', 91, 'notepad', 0, 0, 800, 600),
  ]
  const owns = ownedBy({ pids: new Set([70, 71]), processes: ['starrail.EXE'] })
  const states = runWindows(desktop, owns)
  assert.deepEqual(states.map(s => [s.window.title, s.covered, s.coveredByOthers, unseen(s)]), [
    ['错误', true, true, true],
    ['三月七小助手', true, true, true],
    ['崩坏：星穹铁道', true, true, true],
    ['StarRail.exe 已停止工作', false, false, true],
  ], "the click-through overlay hides nothing; notepad is not the run's")
  assert.deepEqual(toRaise(states).map(x => x.hwnd), [3, 6, 4, 5], 'the hidden dialogs on top, the rest in their own order')

  const inSight = [desktop[2]!, desktop[3]!, w(2, 'MultiGameAssistant', 60, 'MultiGameAssistant', 2000, 1200, 500, 200)]
  assert.deepEqual(toRaise(runWindows(inSight, owns)), [], 'nothing out of sight: nothing is moved')
  const underItsScript = [w(4, '三月七小助手', 70, 'March7th Assistant', 0, 0, 1920, 1080), w(3, '错误', 71, 'March7th Assistant', 900, 600, 400, 200, { dialog: true })]
  const box = runWindows(underItsScript, owns)[1]!
  assert.ok(box.covered && !box.coveredByOthers && unseen(box), "a dialog under its own script's window is out of sight too")
})

test("screens: the run's hidden windows are brought forward before the desktop shot; what stays hidden is reported", async () => {
  let z = [w(2, 'MultiGameAssistant', 60, 'MultiGameAssistant', 0, 0, 1920, 1080), w(3, '错误', 71, 'maa', 800, 500, 300, 150, { dialog: true }), w(4, 'MAA', 70, 'maa', 0, 0, 1280, 720)]
  const { win, calls } = fakeWin({ windows: () => z, tree: [70, 71], onRaise: () => { z = [z[1]!, z[2]!, z[0]!] } })
  const screens = new Screens({ adb: () => undefined, win, maxEdge: () => 1280 })
  const shot = await screens.captureFor({ pid: 70, processes: [] })
  assert.deepEqual(calls.filter(c => c['op'] === 'raise'), [{ op: 'raise', hwnds: [3, 4] }])
  assert.deepEqual([shot.raised, shot.hidden], [['错误', 'MAA'], []])
  assert.deepEqual(pngSize(shot.png), { width: 2560, height: 1440 }, 'the raw desktop, not shrunk')

  // Behind an always-on-top window (or run as administrator): raising does nothing.
  z = [w(9, '置顶播放器', 99, 'player', 0, 0, 1920, 1080, { topmost: true }), w(3, '错误', 71, 'maa', 800, 500, 300, 150, { dialog: true })]
  const stuck = fakeWin({ windows: () => z, tree: [71] })
  const again = await new Screens({ adb: () => undefined, win: stuck.win, maxEdge: () => 1280 }).captureFor({ pid: 71, processes: [] })
  assert.deepEqual([again.raised, again.hidden], [[], ['错误']])

  // Nothing hidden: no window is moved.
  const calm = fakeWin({ windows: () => [w(3, '错误', 71, 'maa', 800, 500, 300, 150, { dialog: true })], tree: [71] })
  await new Screens({ adb: () => undefined, win: calm.win, maxEdge: () => 1280 }).captureFor({ pid: 71, processes: [] })
  assert.equal(calm.calls.filter(c => c['op'] === 'raise').length, 0)
})

test('screens: keys and text into a window that would not take the focus are refused; a tap still goes', async () => {
  const { win, calls } = fakeWin({ focused: false })
  const screens = new Screens({ adb: () => undefined, win, maxEdge: () => 1280 })
  const shot = await screens.capture('window', { window: '终末地', signal: AbortSignal.timeout(5000) })
  await assert.rejects(screens.key(shot.frame, 'enter'), /没能把窗口「终末地」切到最前/)
  await assert.rejects(screens.type(shot.frame, 'ok'), /没能把窗口「终末地」切到最前/)
  await screens.tap(shot.frame, 10, 10)
  assert.equal(calls.at(-1)?.['op'], 'click')
  assert.equal(calls.filter(c => c['op'] === 'keys' || c['op'] === 'type').length, 0)
})

test("the agent is told about the run's windows, which are brought forward before the script is paused", async () => {
  let prompt = ''
  const windows: RunWindow[] = [
    { window: w(3, '错误', 71, 'maa', 800, 500, 300, 150, { dialog: true }), covered: false, coveredByOthers: false },
    { window: w(4, 'MAA', 70, 'maa', 0, 0, 1280, 720, { minimized: true }), covered: false, coveredByOthers: false },
  ]
  const env = interventions({ windows, ask: async (sessionId, text) => { prompt = text; env.iv().done(sessionId, 'resolved', '关掉了报错框'); return '好' } })
  await env.iv().handle(incident, 'act', Buffer.from('png'))
  assert.deepEqual(env.suspended.slice(0, 2), ['reveal', 'suspend 4242'], 'a paused window does not move: revealed first')
  assert.match(prompt, /这次运行在桌面上的窗口（从上到下）：「错误」（对话框）、「MAA」（最小化）/)
  assert.match(prompt, /先看清它写了什么/)
  assert.match(prompt, /screen_capture（target=window/)
})

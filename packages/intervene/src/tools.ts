/**
 * The screen tools (our own protocol, any image-capable model can use them,
 * docs/PLAN.zh.md §5.4): look with `screen_capture`, act with tap / swipe /
 * scroll / key / type in that screenshot's coordinates.
 *
 * Acting needs the screen's lock: an intervention may act on the screen of
 * the run it paused; anywhere else the screen must be free, and the agent
 * asks the user once per session before it first acts. Looking needs no lock.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Holder } from '@adg/runner'
import { z } from 'zod'
import type { Interventions } from './interventions.ts'
import type { Frame, Screens, TargetKind } from './screens.ts'

export interface ScreenToolDeps {
  readonly screens: Screens
  readonly interventions: Interventions
  readonly locks: { held(): ReadonlyMap<string, Holder>; acquire(keys: readonly string[], holder: Holder): () => void }
  /** Store a PNG for the model. @returns the attachment reference to put in an image block. */
  readonly saveImage: (png: Buffer) => Promise<Record<string, unknown>>
  /** @throws Error when the session's model cannot take images. */
  readonly checkVision: (exec: ToolRunContext) => Promise<void>
  /** Ask the user once for this session. @returns whether they allowed it. */
  readonly approve: (exec: ToolRunContext, reason: string) => Promise<boolean>
  /** Send a screenshot to the person whose chat this session is. @returns false when it is not a chat conversation. */
  readonly sendToSession: (sessionId: string, title: string, png: Buffer) => Promise<boolean>
}

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args)
  if (!parsed.success) throw new Error(`参数无效：${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)
  return parsed.data
}

const TARGET: JsonSchemaNode = { type: 'string', enum: ['emulator', 'desktop', 'window'], description: 'emulator：模拟器（ADB，不占用鼠标）；desktop：整个桌面；window：某个窗口（要先用 screen_capture 指定 window 标题）。' }
const Target = z.enum(['emulator', 'desktop', 'window'])

export function screenTools(deps: ScreenToolDeps): ToolDefinition[] {
  /** session → target → the latest screenshot's frame. */
  const frames = new Map<string, Map<TargetKind, Frame>>()
  const approved = new Set<string>()
  const sessionOf = (exec: ToolRunContext) => exec.agent?.session.id as string | undefined

  const frameFor = (exec: ToolRunContext, target: TargetKind): Frame => {
    const frame = frames.get(sessionOf(exec) ?? '')?.get(target)
    if (frame === undefined) throw new Error(`先用 screen_capture（target=${target}）截一张图，坐标按那张图来`)
    return frame
  }

  /** May this session act on the frame's screen now? @returns the release of the short lock taken for the action. */
  const permit = async (exec: ToolRunContext, frame: Frame): Promise<() => void> => {
    const sessionId = sessionOf(exec) ?? ''
    const active = deps.interventions.forSession(sessionId)
    if (active?.mode === 'diagnose') throw new Error('这次只做诊断，不能点击或输入；把建议写进 intervention_done 的 summary')
    if (active !== undefined && active.allowedKeys.has(frame.lockKey)) return () => {}
    const holder = deps.locks.held().get(frame.lockKey)
    if (holder !== undefined) throw new Error(`${frame.label}正被「${holder.label}」使用，现在不能操作；等它结束，或先用 script_stop 停止它`)
    if (active === undefined && !approved.has(sessionId)) {
      const ok = await deps.approve(exec, `agent 想要操作${frame.label}（点击、按键、输入），这一次对话里只问一次`)
      if (!ok) throw new Error('用户没有同意操作屏幕')
      approved.add(sessionId)
    }
    return deps.locks.acquire([frame.lockKey], { runId: `agent:${sessionId}`, label: 'agent 正在操作' })
  }

  const act = async (exec: ToolRunContext, target: TargetKind, work: (frame: Frame) => Promise<void>, settleMs = 600) => {
    const frame = frameFor(exec, target)
    const release = await permit(exec, frame)
    try {
      await work(frame)
    } finally {
      release()
    }
    await new Promise(resolve => setTimeout(resolve, settleMs))
    return { ok: true, next: '用 screen_capture 再截一张图确认结果' }
  }

  const tool = (spec: {
    name: string; description: string; properties: Record<string, JsonSchemaNode>; required?: string[]; readOnly?: boolean; timeoutMs?: number
    title(a: Record<string, unknown>): string; execute(args: unknown, exec: ToolRunContext): Promise<unknown>; render?: ToolDefinition['output']['render']
  }): ToolDefinition => ({
    name: spec.name,
    description: spec.description,
    parameters: { type: 'object', properties: spec.properties, ...(spec.required === undefined ? {} : { required: spec.required }), additionalProperties: false },
    output: { schema: {}, render: spec.render ?? ((_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }]) },
    timeoutMs: spec.timeoutMs ?? 60_000,
    isConcurrencySafe: () => spec.readOnly === true,
    execute: async (args, exec) => JSON.parse(JSON.stringify(await spec.execute(args, exec) ?? null)) as never,
    presentCall: args => ({ card: 'generic', title: spec.title((args ?? {}) as Record<string, unknown>), kind: spec.readOnly === true ? 'read' : 'other' }),
  })

  return [
    tool({
      name: 'screen_capture',
      description: '截图看看屏幕：模拟器画面（ADB）、整个桌面、或某个窗口（就算被挡住也能截）。返回图片和它的像素大小；之后的点击、滑动都用这张图的坐标。用户说「截个图看看」时，send_to_user 设为 true，图片会直接发给他（例如在飞书里）。',
      properties: {
        target: TARGET,
        window: { type: 'string', description: 'target=window 时：窗口标题里的一段文字（window_list 可查）。' },
        send_to_user: { type: 'boolean', description: '把截图也发给用户。' },
      },
      required: ['target'],
      readOnly: true,
      title: a => `截图：${String(a['target'] ?? '')}${typeof a['window'] === 'string' ? `「${a['window']}」` : ''}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ target: Target, window: z.string().nullish(), send_to_user: z.boolean().nullish() }), args)
        await deps.checkVision(exec)
        const shot = await deps.screens.capture(a.target, { window: a.window ?? undefined, signal: exec.signal })
        const sessionId = sessionOf(exec) ?? ''
        let byTarget = frames.get(sessionId)
        if (byTarget === undefined) frames.set(sessionId, byTarget = new Map())
        byTarget.set(a.target, shot.frame)
        deps.interventions.rememberShot(sessionId, shot.png)
        const image = await deps.saveImage(shot.png)
        const sent = a.send_to_user !== true ? undefined : await deps.sendToSession(sessionId, shot.frame.label, shot.png).then(
          ok => ok ? '已发给用户' : '没能发给用户：这个对话不在聊天渠道（如飞书）里，截图只在界面里显示',
          error => `没能发给用户：${error instanceof Error ? error.message : String(error)}`)
        return {
          target: a.target, label: shot.frame.label, width: shot.frame.width, height: shot.frame.height, image,
          note: `坐标以这张 ${shot.frame.width}×${shot.frame.height} 的图为准（左上角是 0,0）`,
          ...(sent === undefined ? {} : { sent_to_user: sent }),
        }
      },
      render: (_args, value): ContentBlock[] => {
        const v = value as { label: string; width: number; height: number; note: string; image: Record<string, unknown>; sent_to_user?: string }
        return [
          // The UI shows this image under the tool call; a Markdown image in the reply would point nowhere.
          { type: 'text', text: `${v.label}：${v.note}${v.sent_to_user === undefined ? '' : `；${v.sent_to_user}`}。截图已显示在界面上，回复里不要用 Markdown 插入图片。` },
          { type: 'image', attachment: v.image } as unknown as ContentBlock,
        ]
      },
    }),
    tool({
      name: 'screen_tap',
      description: '在最近一次截图的坐标 (x, y) 处点击（模拟器是点按，桌面是鼠标点击）。点完会等一下，再截图确认。',
      properties: {
        target: TARGET,
        x: { type: 'number', description: '截图里的横坐标（像素）。' },
        y: { type: 'number', description: '截图里的纵坐标（像素）。' },
        button: { type: 'string', enum: ['left', 'right'], description: '桌面：鼠标键，默认 left。' },
        double: { type: 'boolean', description: '双击。' },
      },
      required: ['target', 'x', 'y'],
      title: a => `点击 ${String(a['x'])}, ${String(a['y'])}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ target: Target, x: z.number(), y: z.number(), button: z.enum(['left', 'right']).nullish(), double: z.boolean().nullish() }), args)
        return act(exec, a.target, frame => deps.screens.tap(frame, a.x, a.y, { button: a.button ?? 'left', double: a.double === true }))
      },
    }),
    tool({
      name: 'screen_swipe',
      description: '从 (x1, y1) 滑到 (x2, y2)（模拟器是手指滑动，桌面是按住鼠标拖动），坐标用最近一次截图的。',
      properties: {
        target: TARGET,
        x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
        duration_ms: { type: 'integer', description: '用时（毫秒），默认 400。' },
      },
      required: ['target', 'x1', 'y1', 'x2', 'y2'],
      title: () => '滑动',
      execute: async (args, exec) => {
        const a = parse(z.object({ target: Target, x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), duration_ms: z.number().int().nullish() }), args)
        return act(exec, a.target, frame => deps.screens.swipe(frame, a.x1, a.y1, a.x2, a.y2, a.duration_ms ?? 400))
      },
    }),
    tool({
      name: 'screen_scroll',
      description: '在 (x, y) 处滚动：amount 正数往下、负数往上，单位是滚轮的一格。',
      properties: { target: TARGET, x: { type: 'number' }, y: { type: 'number' }, amount: { type: 'integer', description: '格数，例如 3 或 -3。' } },
      required: ['target', 'x', 'y', 'amount'],
      title: a => `滚动 ${String(a['amount'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ target: Target, x: z.number(), y: z.number(), amount: z.number().int() }), args)
        // Wheel notches: positive = down the page, which is a negative wheel delta.
        return act(exec, a.target, frame => deps.screens.scroll(frame, a.x, a.y, -a.amount))
      },
    }),
    tool({
      name: 'screen_key',
      description: '按键。桌面：enter、esc、tab、space、backspace、delete、方向键、f1–f12、字母数字，组合键用 +，例如 ctrl+a、alt+f4。模拟器：back、home、enter、esc、tab、方向键、menu、recent。',
      properties: { target: TARGET, key: { type: 'string', description: '按键，例如 enter、esc、ctrl+a、back。' } },
      required: ['target', 'key'],
      title: a => `按键 ${String(a['key'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ target: Target, key: z.string().min(1).max(40) }), args)
        return act(exec, a.target, frame => deps.screens.key(frame, a.key))
      },
    }),
    tool({
      name: 'screen_type',
      description: '在当前输入框里输入文字（先点一下输入框）。桌面支持中文；模拟器只能输入英文、数字和符号。不要输入密码。',
      properties: { target: TARGET, text: { type: 'string', description: '要输入的文字。' } },
      required: ['target', 'text'],
      title: () => '输入文字',
      execute: async (args, exec) => {
        const a = parse(z.object({ target: Target, text: z.string().max(2000) }), args)
        return act(exec, a.target, frame => deps.screens.type(frame, a.text))
      },
    }),
    tool({
      name: 'window_list',
      description: '列出桌面上可见的窗口（标题、进程、位置大小），用来找游戏或脚本的窗口。',
      properties: { filter: { type: 'string', description: '只看标题或进程名里含这段文字的。' } },
      readOnly: true,
      title: () => '查看窗口',
      execute: async args => {
        const a = parse(z.object({ filter: z.string().nullish() }), args)
        const want = (a.filter ?? '').toLowerCase()
        const windows = (await deps.screens.windows()).filter(w => want === '' || w.title.toLowerCase().includes(want) || (w.process ?? '').toLowerCase().includes(want))
        return { windows: windows.slice(0, 40).map(w => ({ title: w.title, process: w.process, x: w.x, y: w.y, width: w.width, height: w.height, minimized: w.minimized })) }
      },
    }),
    tool({
      name: 'window_focus',
      description: '把一个窗口切到最前面（例如游戏窗口被别的窗口挡住时）。需要桌面可以操作。',
      properties: { title: { type: 'string', description: '窗口标题里的一段文字。' } },
      required: ['title'],
      title: a => `切换窗口：${String(a['title'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ title: z.string().min(1) }), args)
        const frame: Frame = { target: 'desktop', label: '桌面', lockKey: 'desktop', originX: 0, originY: 0, scale: 1, width: 1, height: 1 }
        const release = await permit(exec, frame)
        try {
          const found = await deps.screens.focus(a.title)
          return { ok: true, window: found.title }
        } finally {
          release()
        }
      },
    }),
    tool({
      name: 'intervention_done',
      description: '处理脚本异常时最后调用（只在「干预」会话里）：resolved = 已经恢复，脚本继续；retry = 需要重新运行这个任务（例如更新了脚本、游戏重启了）；give-up = 处理不了，交给用户。summary 写清楚原因、做了什么、用户需要做什么。',
      properties: {
        result: { type: 'string', enum: ['resolved', 'retry', 'give-up'] },
        summary: { type: 'string', description: '一两句话的说明。' },
      },
      required: ['result', 'summary'],
      title: a => `处理结论：${String(a['result'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ result: z.enum(['resolved', 'retry', 'give-up']), summary: z.string().min(1).max(2000) }), args)
        return { ok: true, message: deps.interventions.done(sessionOf(exec), a.result, a.summary) }
      },
    }),
  ]
}

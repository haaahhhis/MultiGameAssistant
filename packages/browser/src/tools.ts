/**
 * The agent's browser tools. They work from the page as text (an
 * accessibility snapshot with `[ref=eN]` on what can be acted on), and every
 * action answers with the page as it is afterwards, so a step needs no
 * separate look; a screenshot is there for what text cannot show.
 *
 * Each conversation (session) works in its own tab; the user sees it in the
 * app's browser panel and can take over or point at an element there.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { BrowserCall, PageView, Shot } from './client.ts'

export const BROWSER_TOOLS = {
  navigate: 'browser_navigate',
  snapshot: 'browser_snapshot',
  click: 'browser_click',
  type: 'browser_type',
  press: 'browser_press',
  scroll: 'browser_scroll',
  screenshot: 'browser_screenshot',
  text: 'browser_text',
  tabs: 'browser_tabs',
} as const

export interface BrowserToolDeps {
  readonly call: BrowserCall
  /** Store a PNG for the model. @returns the attachment reference to put in an image block. */
  readonly saveImage: (png: Buffer) => Promise<Record<string, unknown>>
  /** @throws Error when the session's model cannot take images. */
  readonly checkVision: (exec: ToolRunContext) => Promise<void>
}

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args)
  if (!parsed.success) throw new Error(`参数无效：${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)
  return parsed.data
}

/** A page view as the model reads it. */
export function renderPage(view: PageView): string {
  return `标签页 ${view.tab}：${view.title === '' ? '（无标题）' : view.title}\n${view.url}${view.loading === true ? '\n（还在加载）' : ''}\n\n${view.snapshot}`
}

const REF: JsonSchemaNode = { type: 'string', description: '页面内容里的 [ref=…]（如 e12）。只在最近一次返回的页面内容里有效。' }

export function browserTools(deps: BrowserToolDeps): ToolDefinition[] {
  const sessionOf = (exec: ToolRunContext) => exec.agent?.session.id as string | undefined
  const call = (exec: ToolRunContext, method: string, params: Record<string, unknown>) => {
    const session = sessionOf(exec)
    return deps.call(method, { ...params, ...(session === undefined ? {} : { session }) }, exec.signal)
  }
  /** Drop nulls the model sends for "not given". */
  const given = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null))

  const tool = (spec: {
    name: string; description: string; properties: Record<string, JsonSchemaNode>; required?: string[]; readOnly?: boolean
    title(a: Record<string, unknown>): string; execute(args: unknown, exec: ToolRunContext): Promise<unknown>
    render?: ToolDefinition['output']['render']
  }): ToolDefinition => ({
    name: spec.name,
    description: spec.description,
    parameters: { type: 'object', properties: spec.properties, ...(spec.required === undefined ? {} : { required: spec.required }), additionalProperties: false },
    output: { schema: {}, render: spec.render ?? ((_args, value): ContentBlock[] => [{ type: 'text', text: renderPage(value as unknown as PageView) }]) },
    timeoutMs: 90_000,
    // One page, one cursor: the agent's actions on it go one after another.
    isConcurrencySafe: () => false,
    execute: async (args, exec) => JSON.parse(JSON.stringify(await spec.execute(args, exec) ?? null)) as never,
    presentCall: args => ({ card: 'generic', title: spec.title((args ?? {}) as Record<string, unknown>), kind: spec.readOnly === true ? 'read' : 'other' }),
  })

  return [
    tool({
      name: BROWSER_TOOLS.navigate,
      description: '在内置浏览器里打开网页（用户能在多游戏助手的浏览器面板里看到，也能接手），或者后退、前进、刷新。适合 web_fetch 只拿到标题或空壳的网页（前端渲染的官网、公告页、活动页），要点击、翻页、展开才看得到的内容，或者用户让你在浏览器里操作；普通的静态页面和 JSON 接口用 web_fetch 更省。读文字用 browser_text。每个对话有自己的标签页；返回页面内容：角色和文字按层级列出，能操作的元素带 [ref=…]，接着用 browser_click / browser_type 操作它们。内置浏览器是隔离的：不保存登录、不能下载文件，只开 http / https 网页。',
      properties: {
        url: { type: 'string', description: '要打开的网址（不写 https:// 也行）。' },
        action: { type: 'string', enum: ['back', 'forward', 'reload'], description: '不给 url 时：后退、前进或刷新。' },
        new_tab: { type: 'boolean', description: '在新标签页打开（原来的留着）。' },
      },
      title: a => (typeof a['url'] === 'string' ? `打开网页：${a['url']}` : `浏览器：${String(a['action'] ?? '')}`),
      execute: async (args, exec) => {
        const a = parse(z.object({ url: z.string().trim().min(1).nullish(), action: z.enum(['back', 'forward', 'reload']).nullish(), new_tab: z.boolean().nullish() }), args)
        if ((a.url ?? undefined) === undefined && (a.action ?? undefined) === undefined) throw new Error('要给 url，或 action（back / forward / reload）')
        return call(exec, 'navigate', given({ url: a.url, action: a.url === undefined || a.url === null ? a.action : undefined, newTab: a.new_tab === true ? true : undefined }))
      },
    }),
    tool({
      name: BROWSER_TOOLS.snapshot,
      description: '重新读一遍当前页面的内容（带 [ref=…]）。每次操作都已经返回了页面内容，一般不用单独调用；页面自己变了（等加载、定时刷新）或内容被截断想看更多时再用。',
      properties: { max_chars: { type: 'integer', description: '最多返回多少字，默认 20000，最多 60000。' } },
      readOnly: true,
      title: () => '读取页面',
      execute: async (args, exec) => {
        const a = parse(z.object({ max_chars: z.number().int().min(2000).max(60000).nullish() }), args)
        return call(exec, 'snapshot', given({ maxChars: a.max_chars }))
      },
    }),
    tool({
      name: BROWSER_TOOLS.click,
      description: '点击页面上的元素：给 ref；画面上才看得到的位置（画布、地图）可以给 browser_screenshot 截图上的 x、y。返回点击后的页面内容。',
      properties: {
        ref: REF,
        x: { type: 'number', description: '没有 ref 时：截图上的横坐标。' },
        y: { type: 'number', description: '没有 ref 时：截图上的纵坐标。' },
        double: { type: 'boolean', description: '双击。' },
      },
      title: a => `点击：${String(a['ref'] ?? `${String(a['x'])},${String(a['y'])}`)}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ ref: z.string().nullish(), x: z.number().nullish(), y: z.number().nullish(), double: z.boolean().nullish() }), args)
        return call(exec, 'click', given({ ref: a.ref, x: a.x, y: a.y, double: a.double }))
      },
    }),
    tool({
      name: BROWSER_TOOLS.type,
      description: '在输入框里输入文字（默认先清空原来的内容）；submit=true 输入后按回车（提交搜索、表单）。返回之后的页面内容。不要输入用户的密码、支付信息或证件号：需要登录或付款时请用户在浏览器面板里自己操作。',
      properties: {
        ref: REF,
        text: { type: 'string', description: '要输入的文字。' },
        clear: { type: 'boolean', description: '先清空原来的内容，默认 true。' },
        submit: { type: 'boolean', description: '输入后按回车。' },
      },
      required: ['ref', 'text'],
      title: a => `输入：${String(a['ref'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ ref: z.string().min(1), text: z.string().max(10_000), clear: z.boolean().nullish(), submit: z.boolean().nullish() }), args)
        return call(exec, 'type', given({ ref: a.ref, text: a.text, clear: a.clear, submit: a.submit }))
      },
    }),
    tool({
      name: BROWSER_TOOLS.press,
      description: '按键：Enter、Escape、Tab、ArrowDown、PageDown 等，或组合键如 Control+A、Shift+Tab。按在当前获得焦点的元素上。返回之后的页面内容。',
      properties: { key: { type: 'string', description: '按键名，或用 + 连起来的组合键。' } },
      required: ['key'],
      title: a => `按键：${String(a['key'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ key: z.string().min(1).max(40) }), args)
        return call(exec, 'press', { key: a.key })
      },
    }),
    tool({
      name: BROWSER_TOOLS.scroll,
      description: '滚动页面：direction 和 amount（像素，默认 600）；给 ref 不给 direction 就把那个元素滚到看得见的地方；两个都给就在那个元素（例如一个可以滚动的列表）里滚。返回之后的页面内容。',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'integer', description: '滚多少像素，默认 600。' },
        ref: REF,
      },
      title: a => `滚动：${String(a['direction'] ?? a['ref'] ?? 'down')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ direction: z.enum(['up', 'down', 'left', 'right']).nullish(), amount: z.number().int().min(50).max(5000).nullish(), ref: z.string().nullish() }), args)
        return call(exec, 'scroll', given({ direction: a.direction, amount: a.amount, ref: a.ref }))
      },
    }),
    tool({
      name: BROWSER_TOOLS.screenshot,
      description: '给当前标签页截图（模型要能看图）。页面内容是文字时不用截图；画面、图表、画布、验证效果时再用。截图的坐标可以给 browser_click 用。',
      properties: {},
      readOnly: true,
      title: () => '浏览器截图',
      execute: async (_args, exec) => {
        await deps.checkVision(exec)
        const shot = await call(exec, 'screenshot', {}) as Shot
        const image = await deps.saveImage(Buffer.from(shot.png, 'base64'))
        return { tab: shot.tab, url: shot.url, title: shot.title, width: shot.width, height: shot.height, image }
      },
      render: (_args, value): ContentBlock[] => {
        const v = value as { tab: string; url: string; title: string; width: number; height: number; image: Record<string, unknown> }
        return [
          { type: 'text', text: `标签页 ${v.tab}：${v.title}\n${v.url}\n截图 ${v.width}×${v.height}（左上角是 0,0，browser_click 的 x、y 按这张图）` },
          { type: 'image', attachment: v.image } as unknown as ContentBlock,
        ]
      },
    }),
    tool({
      name: BROWSER_TOOLS.text,
      description: '取当前页面的全部可见文字（不带结构和 ref），适合读长文章、公告、表格内容。',
      properties: { max_chars: { type: 'integer', description: '最多返回多少字，默认 20000，最多 100000。' } },
      readOnly: true,
      title: () => '读取页面文字',
      execute: async (args, exec) => {
        const a = parse(z.object({ max_chars: z.number().int().min(1000).max(100_000).nullish() }), args)
        return call(exec, 'text', given({ maxChars: a.max_chars }))
      },
      render: (_args, value): ContentBlock[] => {
        const v = value as { tab: string; url: string; title: string; text: string; truncated?: number }
        return [{ type: 'text', text: `标签页 ${v.tab}：${v.title}\n${v.url}\n\n${v.text}${v.truncated === undefined ? '' : `\n…（还有 ${v.truncated} 字，加大 max_chars 看更多）`}` }]
      },
    }),
    tool({
      name: BROWSER_TOOLS.tabs,
      description: '内置浏览器的标签页：list 列出全部（标出你在用的那个）；select 换到某个标签页（之后的操作都在它上面，例如用户打开的页面）；close 关掉一个。',
      properties: {
        action: { type: 'string', enum: ['list', 'select', 'close'] },
        tab: { type: 'string', description: 'select / close：标签页 id（list 可查）。' },
      },
      required: ['action'],
      title: a => `浏览器标签页：${String(a['action'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ action: z.enum(['list', 'select', 'close']), tab: z.string().nullish() }), args)
        if (a.action !== 'list' && (a.tab ?? undefined) === undefined) throw new Error(`${a.action} 要给 tab`)
        return call(exec, 'tabs', given({ action: a.action, tab: a.tab }))
      },
      render: (_args, value): ContentBlock[] => {
        const v = value as PageView | { tabs: { id: string; title: string; url: string; yours?: boolean }[] }
        if ('snapshot' in v) return [{ type: 'text', text: renderPage(v) }]
        return [{ type: 'text', text: v.tabs.length === 0 ? '没有打开的标签页' : v.tabs.map(t => `${t.id}${t.yours === true ? '（你在用）' : ''}：${t.title === '' ? '（无标题）' : t.title}  ${t.url}`).join('\n') }]
      },
    }),
  ]
}

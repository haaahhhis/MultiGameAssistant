/**
 * The page as the agent reads it: Chromium's accessibility tree (CDP
 * `Accessibility.getFullAXTree`) as indented text, each element the agent can
 * act on tagged `[ref=eN]`. The browser tools act on refs, so the agent works
 * from this text instead of a screenshot loop, and every action answers with
 * the page as it is afterwards. Plain JS, no Electron: tested with node.
 */

/** Roles the agent acts on; any focusable element gets a ref as well. */
const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'slider', 'spinbutton', 'listbox', 'treeitem', 'textarea',
])

/** Wrappers with nothing to say of their own: their children stand in their place. */
const TRANSPARENT = new Set(['generic', 'none', 'presentation', 'LineBreak', 'InlineTextBox', 'Section', 'GenericContainer', 'Div', 'paragraph', 'ListMarker', 'LabelText'])

/** Element states worth showing, as `name=value` (true booleans as just the name). */
const STATES = ['checked', 'pressed', 'selected', 'expanded', 'disabled', 'required', 'readonly', 'level', 'focused']

const value = field => field?.value
const clean = text => String(text ?? '').replace(/\s+/g, ' ').trim()
const quote = text => JSON.stringify(text.length > 120 ? `${text.slice(0, 117)}…` : text)

/**
 * @param {readonly any[]} nodes - `Accessibility.getFullAXTree`'s nodes (the first is the document).
 * @param {{ maxChars?: number }} [options]
 * @returns {{ text: string, refs: Map<string, number>, truncated: boolean }} refs: ref → backendDOMNodeId.
 */
export function formatAxTree(nodes, options = {}) {
  const maxChars = options.maxChars ?? 12_000
  const byId = new Map(nodes.map(node => [node.nodeId, node]))
  const refs = new Map()
  const lines = []

  const walk = (node, depth) => {
    if (node === undefined) return
    const children = () => { for (const id of node.childIds ?? []) walk(byId.get(id), depth) }
    const role = value(node.role) ?? ''
    const name = clean(value(node.name))
    if (node.ignored === true || role === 'RootWebArea' || role === 'WebArea') return children()
    if (role === 'StaticText') {
      if (name !== '') lines.push(`${'  '.repeat(depth)}- text: ${quote(name)}`)
      return
    }
    const props = new Map((node.properties ?? []).map(p => [p.name, value(p.value)]))
    const actionable = INTERACTIVE.has(role) || props.get('focusable') === true
    if (TRANSPARENT.has(role) && name === '' && !actionable) return children()
    let line = `${'  '.repeat(depth)}- ${role}${name === '' ? '' : ` ${quote(name)}`}`
    if (actionable && node.backendDOMNodeId !== undefined) {
      const ref = `e${refs.size + 1}`
      refs.set(ref, node.backendDOMNodeId)
      line += ` [ref=${ref}]`
    }
    const shown = clean(value(node.value))
    if (shown !== '' && shown !== name) line += ` value=${quote(shown)}`
    for (const state of STATES) {
      const v = props.get(state)
      if (v === undefined || v === false || v === 'false') continue
      line += v === true || v === 'true' ? ` [${state}]` : ` [${state}=${v}]`
    }
    lines.push(line)
    for (const id of node.childIds ?? []) {
      const child = byId.get(id)
      // A link or button named by its own text, a field showing its value: the text again adds nothing.
      if (child !== undefined && value(child.role) === 'StaticText' && [name, shown].includes(clean(value(child.name)))) continue
      walk(child, depth + 1)
    }
  }
  walk(nodes[0], 0)

  let text = ''
  let shown = 0
  for (const line of lines) {
    if (text.length + line.length + 1 > maxChars) break
    text += `${line}\n`
    shown += 1
  }
  const truncated = shown < lines.length
  if (truncated) text += `…（后面还有 ${lines.length - shown} 行没显示：用 browser_snapshot 加大 max_chars，或先滚动到要看的地方）\n`
  if (lines.length === 0) text = '（页面上没有可读的内容，可能还在加载，或者内容画在画布里：用 browser_screenshot 看）\n'
  return { text, refs, truncated }
}

/** Windows virtual-key codes for the keys browser_press takes by name. */
const KEYS = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, PageUp: 33, PageDown: 34, Home: 36, End: 35,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
}
const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 }

/**
 * Turn `Enter`, `Control+A`, `Shift+Tab` into CDP key events.
 * @returns {{ modifiers: number, key: string, code: string, keyCode: number, text?: string }}
 * @throws Error for a key it does not know.
 */
export function parseKey(combo) {
  const parts = String(combo).split('+').map(p => p.trim()).filter(p => p !== '')
  if (parts.length === 0) throw new Error('key 是空的')
  let modifiers = 0
  for (const part of parts.slice(0, -1)) {
    const bit = MODIFIERS[part]
    if (bit === undefined) throw new Error(`不认识的修饰键：${part}（可用 Control、Shift、Alt、Meta）`)
    modifiers |= bit
  }
  const last = parts.at(-1)
  if (KEYS[last] !== undefined) {
    const key = last === 'Space' ? ' ' : last
    return { modifiers, key, code: last, keyCode: KEYS[last], ...(last === 'Enter' && modifiers === 0 ? { text: '\r' } : last === 'Space' && modifiers === 0 ? { text: ' ' } : {}) }
  }
  if (last.length === 1) {
    const upper = last.toUpperCase()
    const letter = /[A-Z]/.test(upper)
    const digit = /[0-9]/.test(last)
    return {
      modifiers,
      key: last,
      code: letter ? `Key${upper}` : digit ? `Digit${last}` : '',
      keyCode: letter || digit ? upper.charCodeAt(0) : 0,
      // Typed text only without Control / Alt / Meta: those are shortcuts.
      ...((modifiers & 7) === 0 ? { text: last } : {}),
    }
  }
  throw new Error(`不认识的按键：${last}（可用 ${Object.keys(KEYS).join('、')}，或一个字符，可加 Control+ 等）`)
}

/**
 * May the agent's browser go here? Web pages (http, https) and about:blank;
 * never the app's own pages (their origins are `blocked`), local files or the
 * browser's internal pages.
 * @param {string} input - what the agent or the address bar gave: a bare host becomes https.
 * @param {readonly string[]} blocked - origins kept out (the app's UI, dsh's own page).
 * @returns {string} the URL to load.
 * @throws Error saying why not.
 */
export function checkUrl(input, blocked = []) {
  const raw = String(input ?? '').trim()
  if (raw === '') throw new Error('网址是空的')
  if (raw === 'about:blank') return raw
  let url
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`)
  } catch {
    throw new Error(`看不懂这个网址：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`内置浏览器只打开 http / https 网页，不打开 ${url.protocol}`)
  if (url.username !== '' || url.password !== '') throw new Error('网址里不能带用户名或密码')
  if (blocked.includes(url.origin)) throw new Error('这是多游戏助手自己的界面，内置浏览器不打开它')
  return url.href
}

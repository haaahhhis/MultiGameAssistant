import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { checkUrl, formatAxTree, parseKey } from '../../apps/desktop/browser-snapshot.mjs'

const node = (nodeId, role, name, extra = {}) => ({ nodeId, role: { value: role }, ...(name === undefined ? {} : { name: { value: name } }), childIds: [], ...extra })

test('the page reads as indented roles and names; what can be acted on gets a ref', () => {
  const nodes = [
    node('1', 'RootWebArea', '页', { childIds: ['2', '3', '6', '8'] }),
    node('2', 'heading', '活动', { properties: [{ name: 'level', value: { value: 1 } }] }),
    node('3', 'generic', undefined, { childIds: ['4'] }),
    node('4', 'link', '下一页', { backendDOMNodeId: 40, childIds: ['5'] }),
    node('5', 'StaticText', '下一页'),
    node('6', 'textbox', '搜索', { backendDOMNodeId: 60, value: { value: '原神' }, properties: [{ name: 'focused', value: { value: true } }] }),
    node('7', 'button', 'unused', { backendDOMNodeId: 70 }),
    node('8', 'checkbox', '记住我', { backendDOMNodeId: 80, properties: [{ name: 'checked', value: { value: 'true' } }, { name: 'disabled', value: { value: false } }] }),
  ]
  const { text, refs, truncated } = formatAxTree(nodes)
  assert.equal(text, [
    '- heading "活动" [level=1]',
    '- link "下一页" [ref=e1]',
    '- textbox "搜索" [ref=e2] value="原神" [focused]',
    '- checkbox "记住我" [ref=e3] [checked]',
    '',
  ].join('\n'))
  assert.deepEqual([...refs], [['e1', 40], ['e2', 60], ['e3', 80]])
  assert.equal(truncated, false)
})

test('ignored nodes pass their children up; a long page is cut with a note', () => {
  const many = Array.from({ length: 50 }, (_, i) => node(String(i + 10), 'StaticText', `第 ${i} 段文字`))
  const nodes = [node('1', 'RootWebArea', '', { childIds: ['2'] }), node('2', 'none', undefined, { ignored: true, childIds: many.map(n => n.nodeId) }), ...many]
  const { text, truncated } = formatAxTree(nodes, { maxChars: 200 })
  assert.equal(truncated, true)
  assert.match(text, /^- text: "第 0 段文字"/)
  assert.match(text, /后面还有 \d+ 行没显示/)
  assert.match(formatAxTree([node('1', 'RootWebArea', '')]).text, /没有可读的内容/)
})

test('keys by name, characters and combinations', () => {
  assert.deepEqual(parseKey('Enter'), { modifiers: 0, key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' })
  assert.deepEqual(parseKey('Control+A'), { modifiers: 2, key: 'A', code: 'KeyA', keyCode: 65 })
  assert.deepEqual(parseKey('Shift+Tab'), { modifiers: 8, key: 'Tab', code: 'Tab', keyCode: 9 })
  assert.deepEqual(parseKey('a'), { modifiers: 0, key: 'a', code: 'KeyA', keyCode: 65, text: 'a' })
  assert.throws(() => parseKey('Hyper+Q'), /修饰键/)
  assert.throws(() => parseKey('Launch'), /不认识的按键/)
})

test('web pages only: no files, other schemes, credentials in the address, or the app\'s own pages', () => {
  assert.equal(checkUrl('example.com/a'), 'https://example.com/a')
  assert.equal(checkUrl('http://127.0.0.1:5173/'), 'http://127.0.0.1:5173/')
  assert.equal(checkUrl('about:blank'), 'about:blank')
  assert.throws(() => checkUrl('file:///C:/a.txt'), /http \/ https/)
  assert.throws(() => checkUrl('javascript:alert(1)'), /http \/ https/)
  assert.throws(() => checkUrl('https://user:pw@example.com'), /用户名或密码/)
  assert.throws(() => checkUrl('http://127.0.0.1:3290/?token=x', ['http://127.0.0.1:3290']), /自己的界面/)
  assert.throws(() => checkUrl('  '), /空的/)
})

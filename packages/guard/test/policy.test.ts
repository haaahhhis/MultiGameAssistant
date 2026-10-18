import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { judgeCall, type ProtectedDir } from '../src/policy.ts'

const TOOLS = 'D:\\adg\\tools'
const DIRS: ProtectedDir[] = [
  { scriptId: 'maa', dir: 'D:\\adg\\tools\\maa\\6.19.0' },
  { scriptId: 'm7a', dir: 'E:\\Games\\March7thAssistant' },
  { scriptId: '_tools', dir: TOOLS },
]
const blocked = (toolName: string, args: unknown, allowed: string[] = [], cwd?: string) => judgeCall({ toolName, args, cwd }, DIRS, allowed)?.scriptId

test('file tools are refused inside script directories and allowed elsewhere', () => {
  assert.equal(blocked('write', { file_path: 'D:\\adg\\tools\\maa\\6.19.0\\MaaCore.dll' }), 'maa')
  assert.equal(blocked('edit', { file_path: 'e:/games/march7thassistant/main.py' }), 'm7a', 'case and separators do not matter')
  assert.equal(blocked('edit', { file_path: 'main.py' }, [], 'E:\\Games\\March7thAssistant'), 'm7a', 'relative paths resolve from the session cwd')
  assert.equal(blocked('write', { file_path: 'D:\\adg\\tools\\_shared\\x.txt' }), '_tools')
  assert.equal(blocked('write', { file_path: 'C:\\Users\\me\\notes.md' }), undefined)
  assert.equal(blocked('read', { file_path: 'D:\\adg\\tools\\maa\\6.19.0\\config\\gui.json' }), undefined, 'reading is fine')
  assert.equal(blocked('write', { file_path: 'D:\\adg\\tools\\maa\\6.19.0\\x.txt' }, ['D:\\adg\\tools\\maa\\6.19.0']), undefined, 'a grant opens the script')
})

test('shell commands that write into a script directory are refused', () => {
  assert.equal(blocked('pwsh', { command: 'Set-Content D:\\adg\\tools\\maa\\6.19.0\\a.txt hi' }), 'maa')
  assert.equal(blocked('pwsh', { command: 'Remove-Item -Recurse "E:/Games/March7thAssistant/assets"' }), 'm7a')
  assert.equal(blocked('pwsh', { command: 'echo x > E:\\Games\\March7thAssistant\\config.yaml' }), 'm7a')
  assert.equal(blocked('bash', { command: "sed -i 's/a/b/' main.py", workdir: 'E:\\Games\\March7thAssistant' }), 'm7a')
  assert.equal(blocked('pwsh', { command: 'Copy-Item a.zip D:\\adg\\tools\\x' }), '_tools')
})

test('reading, listing, running and harmless redirects stay allowed', () => {
  assert.equal(blocked('pwsh', { command: 'Get-ChildItem D:\\adg\\tools\\maa\\6.19.0' }), undefined)
  assert.equal(blocked('pwsh', { command: 'Get-Content E:\\Games\\March7thAssistant\\config.yaml' }), undefined)
  assert.equal(blocked('pwsh', { command: '& "E:\\Games\\March7thAssistant\\March7th Assistant.exe" --help 2>&1' }), undefined)
  assert.equal(blocked('pwsh', { command: 'Get-Item D:\\adg\\tools\\maa > $null' }), undefined)
  assert.equal(blocked('pwsh', { command: 'Set-Content C:\\temp\\out.txt hi' }), undefined)
  assert.equal(blocked('pwsh', { command: 'Set-Content D:\\adg\\tools\\maa\\6.19.0\\a.txt hi' }, ['D:\\adg\\tools\\maa\\6.19.0']), undefined, 'granted')
})

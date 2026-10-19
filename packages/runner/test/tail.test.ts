import { strict as assert } from 'node:assert'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { lineSplitter, LogTail } from '../src/tail.ts'

// "欢迎使用 March7th Assistant" and "任务完成" in GBK, as a Python script prints them when piped on Chinese Windows.
const WELCOME_GBK = Buffer.concat([Buffer.from([0xbb, 0xb6, 0xd3, 0xad, 0xca, 0xb9, 0xd3, 0xc3]), Buffer.from(' March7th Assistant')])
const DONE_GBK = Buffer.from([0xc8, 0xce, 0xce, 0xf1, 0xcd, 0xea, 0xb3, 0xc9])

function collect(encoding: string, chunks: Buffer[]): string[] {
  const lines: string[] = []
  const splitter = lineSplitter(encoding, line => lines.push(line))
  for (const chunk of chunks) splitter.push(chunk)
  splitter.end()
  return lines
}

test('auto decodes GBK console output, even when a character is split across chunks', () => {
  const bytes = Buffer.concat([Buffer.from('+----+\r\n|'), WELCOME_GBK, Buffer.from('|\r\n'), DONE_GBK])
  const chunks = [bytes.subarray(0, 11), bytes.subarray(11, 20), bytes.subarray(20)] // 11 splits 欢 in two
  assert.deepEqual(collect('auto', chunks), ['+----+', '|欢迎使用 March7th Assistant|', '任务完成'])
})

test('auto keeps UTF-8 as UTF-8, and explicit encodings still win', () => {
  assert.deepEqual(collect('auto', [Buffer.from('开始任务\n任务已全部完成！\n')]), ['开始任务', '任务已全部完成！'])
  assert.deepEqual(collect('gbk', [WELCOME_GBK]), ['欢迎使用 March7th Assistant'])
  assert.match(collect('utf-8', [WELCOME_GBK])[0]!, /�/, 'utf-8 means utf-8')
  assert.deepEqual(collect('utf-16le', [Buffer.from('第一行\r\n第二行', 'utf16le')]), ['第一行', '第二行'])
})

test('terminal colours and other control sequences are dropped', () => {
  const onnx = '\x1b[1;31m2026-10-19 21:40:30 [W:onnxruntime:, session_state.cc:1316 VerifyEachNodeIsAssignedToAnEp] Rerunning with verbose output\x1b[m'
  assert.deepEqual(collect('auto', [Buffer.from(`${onnx}\n\x1b]0;MAA\x07进度 50%\x1b[K\n\x1b[2J\n`)]), [
    '2026-10-19 21:40:30 [W:onnxruntime:, session_state.cc:1316 VerifyEachNodeIsAssignedToAnEp] Rerunning with verbose output',
    '进度 50%',
  ], 'a line that was only control sequences is gone')
})

test('auto sticks to GBK once a line needed it', () => {
  // 0xC3 0xA9 is "é" in UTF-8 but "茅" in GBK; after a GBK line it is read as GBK.
  const ambiguous = Buffer.from([0xc3, 0xa9])
  assert.deepEqual(collect('auto', [Buffer.concat([DONE_GBK, Buffer.from('\n'), ambiguous, Buffer.from('\nok\n')])]), ['任务完成', '茅', 'ok'])
})

test('a log file written in GBK is followed with auto decoding', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'adg-tail-')), 'run.log')
  writeFileSync(file, 'before the run\n')
  const lines: string[] = []
  const tail = new LogTail(file, 'auto', line => lines.push(line), 10_000)
  await tail.start()
  appendFileSync(file, Buffer.concat([WELCOME_GBK, Buffer.from('\r\n'), DONE_GBK]))
  await tail.poll()
  await tail.stop()
  assert.deepEqual(lines, ['欢迎使用 March7th Assistant', '任务完成'])
})

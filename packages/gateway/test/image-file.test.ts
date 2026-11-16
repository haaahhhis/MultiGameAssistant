import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { imageFilePath, readImageFile } from '../src/image-file.ts'

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')

test('an image file a reply shows is read by its path, its file URL or relative to the workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-image-file-'))
  const file = join(dir, '截图 1.png')
  writeFileSync(file, PNG)
  for (const written of [file, pathToFileURL(file).href, '截图 1.png', '截图%201.png']) {
    const read = await readImageFile(written, dir)
    assert.equal(read.mediaType, 'image/png', written)
    assert.equal(read.path, file)
    assert.deepEqual(Buffer.from(read.data, 'base64'), PNG)
  }
})

test('only image files are read, and a missing one says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-image-file-'))
  writeFileSync(join(dir, 'notes.txt'), 'secret')
  await assert.rejects(readImageFile(join(dir, 'notes.txt'), dir), /不是图片文件/)
  await assert.rejects(readImageFile(join(dir, 'gone.png'), dir), /找不到这个文件/)
  await assert.rejects(readImageFile('shot.png', undefined), /相对路径/)
})

test('a Git Bash path is a Windows path on Windows', { skip: process.platform !== 'win32' }, () => {
  assert.equal(imageFilePath('/c/Users/a/shot.png', undefined), 'C:\\Users\\a\\shot.png')
})

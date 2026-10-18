import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PACKAGES = fileURLToPath(new URL('../../packages/', import.meta.url))

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? sources(path) : entry.name.endsWith('.ts') ? [path] : []
  })
}

// Cordis hands other plugins a proxy of a service (ctx.get / ctx.<name>), so a
// method reading `this.#field` throws "Cannot read private member". Services
// use TypeScript `private` instead. (M2 real-device test, step 6.)
test('Cordis services declare no #private members', () => {
  const offenders = []
  for (const pkg of readdirSync(PACKAGES)) {
    let files
    try { files = sources(join(PACKAGES, pkg, 'src')) } catch { continue }
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      if (!/\bextends Service\b/.test(text)) continue
      for (const [line, n] of text.split('\n').map((l, i) => [l, i + 1])) {
        if (/^\s*(?:static\s+)?(?:readonly\s+|async\s+)*#\w+|this\.#\w+/.test(line)) offenders.push(`${file}:${n}: ${line.trim()}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})

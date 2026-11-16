#!/usr/bin/env node
/**
 * Write (or refresh) the app's overrides of dsh's agent presets (standard and
 * ptc) in packages/bundle/cordis.patch.yml from the installed dsh-web-app; see
 * scripts/lib/standard-preset.mjs. Run after updating dsh.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentBlock, PRESETS, presetOverride, upstreamPreset } from './lib/standard-preset.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'packages', 'bundle', 'cordis.patch.yml')
let patch = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
let changed = false
for (const id of PRESETS) {
  const block = presetOverride(upstreamPreset(root, id), id)
  const current = currentBlock(patch, id)
  if (current === block) {
    console.log(`the ${id} preset override is up to date`)
    continue
  }
  patch = current === undefined ? `${patch.trimEnd()}\n\n${block}\n` : patch.replace(current, block)
  changed = true
  console.log(`${current === undefined ? 'added' : 'updated'} the ${id} preset override in ${file}`)
}
if (changed) writeFileSync(file, patch)

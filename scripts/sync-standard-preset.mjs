#!/usr/bin/env node
/**
 * Write (or refresh) the app's override of dsh's standard agent preset in
 * packages/bundle/cordis.patch.yml from the installed dsh-web-app; see
 * scripts/lib/standard-preset.mjs. Run after updating dsh.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentBlock, standardOverride, upstreamStandard } from './lib/standard-preset.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'packages', 'bundle', 'cordis.patch.yml')
const patch = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const block = standardOverride(upstreamStandard(root))
const current = currentBlock(patch)
if (current === block) {
  console.log('the standard preset override is up to date')
} else {
  writeFileSync(file, current === undefined ? `${patch.trimEnd()}\n\n${block}\n` : patch.replace(current, block))
  console.log(`${current === undefined ? 'added' : 'updated'} the standard preset override in ${file}`)
}

#!/usr/bin/env node
/** Prepare the development DSH_HOME (outside the checkout, profile.mjs devHome) with profile "adg". */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { devHome, prepareAdgProfile } from '../apps/desktop/profile.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = await prepareAdgProfile({
  home: devHome(root),
  bundleDir: join(root, 'packages', 'bundle'),
  dshBin: join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
})
console.log(`profile ready: ${profile}`)
console.log('bundles: @deepseek-ai/dsh-base → @deepseek-ai/dsh-web-app → @adg/bundle')

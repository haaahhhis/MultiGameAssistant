#!/usr/bin/env node
/** Prepare .dev-home with profile "adg" (see profile.mjs). */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareAdgProfile } from '../apps/desktop/profile.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = await prepareAdgProfile({
  home: process.env.DSH_HOME ?? join(root, '.dev-home'),
  bundleDir: join(root, 'packages', 'bundle'),
  dshBin: join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
})
console.log(`profile ready: ${profile}`)
console.log('bundles: @deepseek-ai/dsh-base → @deepseek-ai/dsh-web-app → @adg/bundle')

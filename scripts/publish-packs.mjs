#!/usr/bin/env node
/**
 * Copy the official packs (packages/packs) into a checkout of the skills
 * repository (MultiGameAssistant/skills), beside each one's SKILL.md: a script
 * pack's adg.script.yaml into the folder of the skill named like its id, a
 * game pack's game.yaml into game-<id>'s. The app downloads them from there.
 * Then bump the versions of the folders that changed in its index.json and
 * run its check (node .github/scripts/check.mjs HEAD).
 *
 *   node scripts/publish-packs.mjs <skills checkout>
 */
import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GAMES_DIR, PACKS_DIR } from '../packages/packs/index.js'

const target = process.argv[2]
if (target === undefined || !existsSync(join(target, 'index.json'))) {
  console.error('usage: node scripts/publish-packs.mjs <a checkout of MultiGameAssistant/skills>')
  process.exit(1)
}
const index = JSON.parse(readFileSync(join(target, 'index.json'), 'utf8').replace(/^﻿/, ''))
const pathOf = name => index.skills.find(s => s.name === name)?.path
const missing = []
const copy = (from, name, file) => {
  const path = pathOf(name)
  if (path === undefined) { missing.push(name); return }
  const to = join(target, ...path.split('/'), file)
  const before = existsSync(to) ? readFileSync(to, 'utf8') : undefined
  copyFileSync(from, to)
  console.log(`${before === readFileSync(to, 'utf8') ? '  same   ' : '  changed'} ${path}/${file}`)
}
for (const id of readdirSync(PACKS_DIR)) copy(join(PACKS_DIR, id, 'adg.script.yaml'), id, 'adg.script.yaml')
for (const id of readdirSync(GAMES_DIR)) copy(join(GAMES_DIR, id, 'game.yaml'), `game-${id}`, 'game.yaml')
if (missing.length > 0) {
  console.error(`index.json has no skill for: ${missing.join(', ')} (add each one's folder and SKILL.md first)`)
  process.exit(1)
}

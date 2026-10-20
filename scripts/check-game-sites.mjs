#!/usr/bin/env node
/**
 * Reads every built-in Game Pack's data sites for real (PRTS, the Bilibili
 * wikis) the way the plugin does, and prints the events found. Read-only;
 * needs the network and `pnpm build`.
 *
 *   pnpm check:sites
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseGameManifest } from '../packages/pack-schema/lib/index.js'
import { GAMES_DIR } from '../packages/packs/index.js'
import { leftText, readSmw, shortDate } from '../packages/game-intel/lib/index.js'

let failed = 0
const now = Date.now()
for (const id of readdirSync(GAMES_DIR)) {
  const game = parseGameManifest(readFileSync(join(GAMES_DIR, id, 'game.yaml'), 'utf8'))
  for (const source of game.sources) {
    if (source.smw === undefined) {
      console.log(`- ${game.name} · ${source.name}: read by the agent (${source.homepage ?? 'no address'})`)
      continue
    }
    const started = Date.now()
    try {
      const events = await readSmw(source.smw, game, now, (url, init) => fetch(url, init))
      console.log(`✔ ${game.name} · ${source.name}: ${events.length} events (${Date.now() - started} ms)`)
      for (const e of events) {
        console.log(`    ${e.name}  ${e.startsAt === undefined ? '' : `${shortDate(e.startsAt, game.timezone)} – `}${shortDate(e.endsAt, game.timezone)}（${leftText(e.endsAt, now)}）${e.shopEndsAt === undefined ? '' : `  商店到 ${shortDate(e.shopEndsAt, game.timezone)}`}`)
      }
      if (events.length === 0) { failed++; console.log('    (no events: is the query still right?)') }
    } catch (error) {
      failed++
      console.log(`✖ ${game.name} · ${source.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
process.exitCode = failed === 0 ? 0 : 1

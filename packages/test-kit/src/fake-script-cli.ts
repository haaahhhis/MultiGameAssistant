#!/usr/bin/env node
/**
 * `node fake-script-cli.js <scenario.json>`: a stand-in for a managed script.
 * Exits with the scenario's exit code; SIGTERM or Ctrl+C stop it like a real one.
 */
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { parseScenario, runScenario } from './fake-script.ts'

const file = process.argv[2]
if (file === undefined) {
  process.stderr.write('usage: fake-script-cli <scenario.json>\n')
  process.exit(2)
}

const scenario = parseScenario(JSON.parse(readFileSync(file, 'utf8')))
const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort())

try {
  process.exitCode = await runScenario(scenario, {
    stdout: line => process.stdout.write(`${line}\n`),
    stderr: line => process.stderr.write(`${line}\n`),
    sleep: (ms, signal) => delay(ms, undefined, signal === undefined ? {} : { signal }),
  }, controller.signal)
} catch (error) {
  if (!controller.signal.aborted) throw error
  process.exitCode = 130
}

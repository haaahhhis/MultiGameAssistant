/**
 * Scenario-driven fake script.
 *
 * A scenario is a list of steps a managed script would take: print log lines,
 * append to a log file, rewrite a config file, go quiet (to look stuck), or
 * exit with a code. Runner, monitor and orchestrator tests spawn the CLI
 * wrapper (`fake-script-cli`) with a scenario file instead of a real game script.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type ScenarioStep =
  /** One line on stdout (or stderr). */
  | { readonly log: string; readonly stream?: 'stdout' | 'stderr' }
  /** One line appended to a log file, the way GUI scripts write `debug/*.log`. */
  | { readonly logFile: string; readonly line: string }
  /** Replace a file's content, e.g. a script rewriting its own config. */
  | { readonly writeFile: string; readonly content: string }
  /** Do nothing for a while; long sleeps model a script that is stuck. */
  | { readonly sleepMs: number }
  /** Stop here with this exit code. */
  | { readonly exit: number }

export interface Scenario {
  readonly name?: string
  readonly steps: readonly ScenarioStep[]
}

/** Where a scenario's effects go; tests can capture them instead of using real streams. */
export interface ScenarioIo {
  stdout(line: string): void
  stderr(line: string): void
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

/**
 * Validate an untrusted scenario value.
 * @throws Error naming the first invalid step.
 */
export function parseScenario(value: unknown): Scenario {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { steps?: unknown }).steps)) {
    throw new Error('scenario must be an object with a steps array')
  }
  const { name, steps } = value as { name?: unknown; steps: unknown[] }
  steps.forEach((step, index) => {
    if (!isStep(step)) throw new Error(`scenario step ${index} is not a known step: ${JSON.stringify(step)}`)
  })
  return { ...(typeof name === 'string' ? { name } : {}), steps: steps as ScenarioStep[] }
}

function isStep(step: unknown): step is ScenarioStep {
  if (typeof step !== 'object' || step === null) return false
  const s = step as Record<string, unknown>
  if (typeof s['log'] === 'string') return s['stream'] === undefined || s['stream'] === 'stdout' || s['stream'] === 'stderr'
  if (typeof s['logFile'] === 'string') return typeof s['line'] === 'string'
  if (typeof s['writeFile'] === 'string') return typeof s['content'] === 'string'
  if (typeof s['sleepMs'] === 'number') return Number.isFinite(s['sleepMs']) && s['sleepMs'] >= 0
  if (typeof s['exit'] === 'number') return Number.isInteger(s['exit'])
  return false
}

/**
 * Play the steps in order.
 * @returns the exit code: the first `exit` step's, else 0.
 */
export async function runScenario(scenario: Scenario, io: ScenarioIo, signal?: AbortSignal): Promise<number> {
  for (const step of scenario.steps) {
    signal?.throwIfAborted()
    if ('log' in step) {
      if (step.stream === 'stderr') io.stderr(step.log)
      else io.stdout(step.log)
    } else if ('logFile' in step) {
      await mkdir(dirname(step.logFile), { recursive: true })
      await appendFile(step.logFile, `${step.line}\n`)
    } else if ('writeFile' in step) {
      await mkdir(dirname(step.writeFile), { recursive: true })
      await writeFile(step.writeFile, step.content)
    } else if ('sleepMs' in step) {
      await io.sleep(step.sleepMs, signal)
    } else {
      return step.exit
    }
  }
  return 0
}

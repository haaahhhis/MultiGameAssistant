import { parse as parseYaml, YAMLParseError } from 'yaml'
import { ScriptManifest } from './manifest.ts'

/** A manifest that failed to load, with every problem named by its path. */
export class PackError extends Error {
  readonly file: string
  readonly issues: readonly string[]

  constructor(file: string, issues: readonly string[]) {
    super(`${file}: ${issues.join('; ')}`)
    this.name = 'PackError'
    this.file = file
    this.issues = issues
  }
}

/**
 * Parse and validate `adg.script.yaml` text.
 * @param file - used in error messages only.
 * @throws PackError for YAML syntax errors and schema violations.
 */
export function parseManifest(text: string, file = 'adg.script.yaml'): ScriptManifest {
  let raw: unknown
  try {
    raw = parseYaml(text, { prettyErrors: true, maxAliasCount: 100 })
  } catch (error) {
    throw new PackError(file, [error instanceof YAMLParseError ? error.message.split('\n')[0]! : String(error)])
  }
  const parsed = ScriptManifest.safeParse(raw)
  if (!parsed.success) {
    throw new PackError(file, parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`))
  }
  return parsed.data
}

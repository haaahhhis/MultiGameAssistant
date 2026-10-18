/**
 * A quick look at a script directory: launchers and marker files near the
 * top, and the adapter family the markers alone imply. The analyzer (M2)
 * reads documentation and configs; this only has to be fast and safe.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectProbe, ScriptFamily } from '@adg/protocol'

const MARKERS = [
  'interface.json', 'pyproject.toml', 'requirements.txt', 'package.json', 'main.py', 'app.py',
  'config', 'resource', 'assets', 'README.md', 'README_EN.md', 'README.en.md',
]
const LAUNCHER = /\.(exe|bat|cmd|ps1)$/i
const NOT_LAUNCHER = /(unins\d*|uninstall|updater?|crashpad|crash_?handler|vc_?redist|setup|dependencysetup)/i

export async function probeProject(dir: string): Promise<ProjectProbe> {
  const top = await readdir(dir, { withFileTypes: true })
  const names = new Set(top.map(e => e.name))
  const markers = MARKERS.filter(m => names.has(m))
  // MaaFramework projects often keep interface.json under assets/ in source form.
  if (!names.has('interface.json') && names.has('assets') && await exists(join(dir, 'assets', 'interface.json'))) markers.push('assets/interface.json')

  const executables: string[] = []
  for (const entry of top) {
    if (entry.isFile() && LAUNCHER.test(entry.name) && !NOT_LAUNCHER.test(entry.name)) executables.push(entry.name)
  }
  // One level down catches `bin/xxx.exe` layouts without walking the tree.
  if (executables.length === 0) {
    for (const entry of top.filter(e => e.isDirectory()).slice(0, 20)) {
      const inner = await readdir(join(dir, entry.name), { withFileTypes: true }).catch(() => [])
      for (const file of inner) {
        if (file.isFile() && LAUNCHER.test(file.name) && !NOT_LAUNCHER.test(file.name)) executables.push(`${entry.name}/${file.name}`)
      }
    }
  }
  const family: ScriptFamily | undefined = markers.some(m => m.endsWith('interface.json')) ? 'maafw-pi' : undefined
  return { executables: executables.sort(), markers, ...(family === undefined ? {} : { family }) }
}

/** Whether every `files` entry exists under `dir`. */
export async function matchesDetect(dir: string, files: readonly string[]): Promise<boolean> {
  for (const file of files) if (!(await exists(join(dir, file)))) return false
  return true
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

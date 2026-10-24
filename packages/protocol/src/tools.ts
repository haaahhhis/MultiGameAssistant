/**
 * How a tool call is shown in one line, the same in the app's session view
 * and in replies sent to chat channels: the tool's name plus its most telling
 * argument (a command, a path, a query…).
 */
export function summarizeToolArgs(args: string): string {
  try {
    const value = JSON.parse(args) as Record<string, unknown>
    for (const key of ['command', 'cmd', 'path', 'file_path', 'pattern', 'query', 'url', 'description', 'prompt']) {
      const v = value[key]
      if (typeof v === 'string' && v !== '') return v.split('\n')[0]!.slice(0, 160)
    }
    const first = Object.values(value).find(v => typeof v === 'string')
    return typeof first === 'string' ? first.slice(0, 160) : ''
  } catch {
    return args.slice(0, 160)
  }
}

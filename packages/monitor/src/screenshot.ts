/**
 * A PNG of the whole Windows desktop (all monitors), through PowerShell and
 * System.Drawing: no native module to build or ship. DPI-aware, so a scaled
 * display is captured at its real resolution. M5's executors replace this for
 * window and background captures.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class AdgDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][AdgDpi]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
try { $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size) } catch { [Console]::Error.WriteLine('ADG_ERR:' + $_.Exception.InnerException.Message); exit 3 }
$bmp.Save($env:ADG_SHOT, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`

/** @throws Error off Windows, on a locked or disconnected session, or when PowerShell fails. */
export async function desktopScreenshot(): Promise<Buffer> {
  if (process.platform !== 'win32') throw new Error('桌面截图目前只支持 Windows')
  const dir = await mkdtemp(join(tmpdir(), 'adg-shot-'))
  const file = join(dir, 'desktop.png')
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
        windowsHide: true, timeout: 30_000, env: { ...process.env, ADG_SHOT: file },
      }, (error, _stdout, stderr) => error === null ? resolve() : reject(new Error(explain(stderr, error.message))))
    })
    return await readFile(file)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** What went wrong, for people: no desktop to capture is the usual case on an unattended machine. */
function explain(stderr: string, fallback: string): string {
  const reason = /ADG_ERR:(.*)/.exec(stderr)?.[1]?.trim() ?? stderr.split('\n').map(l => l.trim()).find(l => l !== '') ?? fallback
  if (/handle is invalid|句柄无效/i.test(reason)) return '没有可截图的桌面（屏幕锁定、远程桌面已断开或没有显示器）'
  return `桌面截图失败：${reason}`
}

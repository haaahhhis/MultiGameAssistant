/**
 * `files/pick`: a file or folder dialog on the gateway's computer, for pages
 * without the desktop app's (the dsh plugin, a browser): the path of a game's
 * program, a script folder to import. Windows only; one dialog at a time.
 */
import { execFile } from 'node:child_process'
import { isAbsolute, normalize } from 'node:path'

export type PickOptions = {
  readonly kind: 'file' | 'folder'
  readonly title?: string | undefined
  readonly defaultPath?: string | undefined
  readonly filterName?: string | undefined
  readonly extensions?: readonly string[] | undefined
}

/**
 * Windows Forms' dialog (the Explorer-style one) over an invisible topmost
 * window placed so the dialog comes up in the middle of the screen, above the
 * browser. Folders: the same dialog, where 「打开」 on the folder shown picks it
 * (the shell's own folder mode stays hidden when started from here).
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
# Started hidden (so no console flashes up), Windows keeps the dialog hidden too: show it once it is there.
Add-Type -Namespace Adg -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
'@
[System.Windows.Forms.Application]::EnableVisualStyles()
$folder = $env:ADG_PICK_KIND -eq 'folder'
$start = $env:ADG_PICK_PATH
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; FormBorderStyle = 'None'; StartPosition = 'Manual'; Width = 1; Height = 1; Opacity = 0 }
$owner.Location = New-Object System.Drawing.Point ([Math]::Max($area.X, $area.X + ($area.Width - 960) / 2)), ([Math]::Max($area.Y, $area.Y + ($area.Height - 560) / 2))
$owner.Show()
$owner.Activate()
$reveal = New-Object System.Windows.Forms.Timer -Property @{ Interval = 100 }
$reveal.add_Tick({
  $popup = [Adg.Win]::GetWindow($owner.Handle, 6)
  if ($popup -ne [IntPtr]::Zero -and $popup -ne $owner.Handle) {
    if (-not [Adg.Win]::IsWindowVisible($popup)) { [void][Adg.Win]::ShowWindow($popup, 5) }
    [void][Adg.Win]::SetForegroundWindow($popup)
    $reveal.Stop()
  }
})
$reveal.Start()
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = $env:ADG_PICK_TITLE
if ($folder) {
  $placeholder = '选择此文件夹'
  $dialog.ValidateNames = $false
  $dialog.CheckFileExists = $false
  $dialog.CheckPathExists = $true
  $dialog.FileName = $placeholder
  $dialog.Filter = '文件夹|*.adg-folder-only'
  if ($start -and [IO.Directory]::Exists($start)) { $dialog.InitialDirectory = $start }
} else {
  $dialog.CheckFileExists = $true
  if ($env:ADG_PICK_FILTER) { $dialog.Filter = $env:ADG_PICK_FILTER }
  if ($start) {
    if ([IO.Directory]::Exists($start)) { $dialog.InitialDirectory = $start }
    elseif ([IO.File]::Exists($start)) { $dialog.InitialDirectory = [IO.Path]::GetDirectoryName($start); $dialog.FileName = [IO.Path]::GetFileName($start) }
  }
}
$path = $null
if ($dialog.ShowDialog($owner) -eq 'OK') {
  $path = $dialog.FileName
  if ($folder) { $path = if ([IO.Directory]::Exists($path)) { $path } else { [IO.Path]::GetDirectoryName($path) } }
}
$owner.Close()
if ($path) { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($path))) }
`

let open: Promise<string | undefined> | undefined

/** @returns the path picked, undefined when the dialog was closed. @throws Error off Windows, or while another is open. */
export function pickPath(options: PickOptions, signal?: AbortSignal): Promise<string | undefined> {
  if (process.platform !== 'win32') return Promise.reject(new Error('只有 Windows 上能打开选择窗口，请直接填写路径'))
  if (open !== undefined) return Promise.reject(new Error('已经打开了一个选择窗口，先把它关掉'))
  const extensions = (options.extensions ?? []).filter(e => /^\w+$/.test(e))
  const filter = extensions.length === 0 ? '' : `${(options.filterName ?? '文件').replace(/\|/g, '')}|${extensions.map(e => `*.${e}`).join(';')}|所有文件|*.*`
  const pending = new Promise<string | undefined>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], {
      windowsHide: true,
      signal,
      maxBuffer: 1 << 20,
      env: {
        ...process.env,
        ADG_PICK_KIND: options.kind,
        ADG_PICK_TITLE: options.title ?? (options.kind === 'folder' ? '选择文件夹' : '选择文件'),
        ADG_PICK_PATH: options.defaultPath !== undefined && isAbsolute(options.defaultPath) ? normalize(options.defaultPath) : '',
        ADG_PICK_FILTER: filter,
      },
    }, (error, stdout, stderr) => {
      if (error !== null) { reject(new Error(`打不开选择窗口：${(String(stderr) || error.message).trim().split('\n')[0]}`)); return }
      const out = String(stdout).trim()
      resolve(out === '' ? undefined : Buffer.from(out, 'base64').toString('utf8'))
    })
  })
  open = pending
  const done = () => { if (open === pending) open = undefined }
  pending.then(done, done)
  return pending
}

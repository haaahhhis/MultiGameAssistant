/**
 * A game program's own icon, as Explorer and the Start menu show it: asked of
 * the Windows shell (IShellItemImageFactory) at 256 px with its transparency,
 * through PowerShell, and kept as a PNG under the games folder keyed by the
 * program's path and modification time. Windows only; elsewhere there is none.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve as absolute } from 'node:path'

/** The size asked for; the shell gives the nearest the program has (most have 256). */
const ICON_SIZE = 256
const TIMEOUT_MS = 20_000

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:ADG_ICON_PATH
$size = [int]$env:ADG_ICON_SIZE
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
[ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellItemImageFactory { [PreserveSig] int GetImage(AdgSize size, int flags, out IntPtr bitmap); }
[StructLayout(LayoutKind.Sequential)] struct AdgSize { public int cx; public int cy; }
public static class AdgExeIcon {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr bc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory item);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);
  public static string Png(string path, int size) {
    IShellItemImageFactory factory;
    SHCreateItemFromParsingName(path, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out factory);
    IntPtr handle;
    // SIIGBF_BIGGERSIZEOK | SIIGBF_ICONONLY: the icon, never a thumbnail of the file.
    int hr = factory.GetImage(new AdgSize { cx = size, cy = size }, 0x1 | 0x4, out handle);
    if (hr != 0) Marshal.ThrowExceptionForHR(hr);
    try {
      using (Bitmap rgb = Image.FromHbitmap(handle)) {
        Rectangle all = new Rectangle(0, 0, rgb.Width, rgb.Height);
        BitmapData bits = rgb.LockBits(all, ImageLockMode.ReadOnly, rgb.PixelFormat);
        try {
          // FromHbitmap drops the alpha channel's meaning, not its bytes: read them again as ARGB.
          using (Bitmap argb = new Bitmap(bits.Width, bits.Height, bits.Stride, PixelFormat.Format32bppArgb, bits.Scan0))
          using (MemoryStream png = new MemoryStream()) {
            argb.Save(png, ImageFormat.Png);
            return Convert.ToBase64String(png.ToArray());
          }
        } finally { rgb.UnlockBits(bits); }
      }
    } finally { DeleteObject(handle); }
  }
}
'@
[Console]::Out.Write([AdgExeIcon]::Png($path, $size))
`

/**
 * The icon Windows associates with the file (32 px): no code to compile, for where the shell's own
 * (SCRIPT, which compiles a small helper) cannot run.
 */
const FALLBACK = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:ADG_ICON_PATH)
$png = New-Object IO.MemoryStream
$icon.ToBitmap().Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
[Console]::Out.Write([Convert]::ToBase64String($png.ToArray()))
`

/** Ask Windows for a program's icon: the shell's at 256 px, else the associated one. @returns PNG bytes. */
export async function extractExeIcon(path: string, signal?: AbortSignal): Promise<Buffer> {
  if (process.platform !== 'win32') throw new Error('只有 Windows 上能读程序图标')
  try {
    return await runIcon(SCRIPT, path, signal)
  } catch (e) {
    if (signal?.aborted === true) throw e
    return runIcon(FALLBACK, path, signal)
  }
}

function runIcon(script: string, path: string, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: { ...process.env, ADG_ICON_PATH: absolute(path), ADG_ICON_SIZE: String(ICON_SIZE) },
      timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...(signal === undefined ? {} : { signal }),
    }, (error, stdout, stderr) => {
      if (error !== null) { reject(new Error(`读不到 ${path} 的图标：${(stderr || error.message).trim().split('\n')[0]}`)); return }
      const png = Buffer.from(stdout.trim(), 'base64')
      if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) { reject(new Error(`读不到 ${path} 的图标`)); return }
      resolve(png)
    })
  })
}

/** Program icons read once, kept as PNGs: a program changes its icon only when it is updated. */
export class ExeIcons {
  readonly #dir: string
  readonly #extract: typeof extractExeIcon
  readonly #pending = new Map<string, Promise<Buffer>>()

  constructor(dir: string, extract: typeof extractExeIcon = extractExeIcon) {
    this.#dir = dir
    this.#extract = extract
  }

  /** @returns the program's icon as PNG. @throws Error when the program is gone or has no icon. */
  async png(path: string, signal?: AbortSignal): Promise<Buffer> {
    const info = await stat(path).catch(() => undefined)
    if (info === undefined || !info.isFile()) throw new Error(`找不到 ${path}`)
    const key = createHash('sha1').update(`${path.toLowerCase()}|${info.mtimeMs}|${info.size}`).digest('hex')
    const file = join(this.#dir, `${key}.png`)
    if (existsSync(file)) return readFile(file)
    let pending = this.#pending.get(key)
    if (pending === undefined) {
      pending = this.#extract(path, signal).then(async png => {
        await mkdir(this.#dir, { recursive: true })
        await writeFile(file, png)
        return png
      }).finally(() => this.#pending.delete(key))
      this.#pending.set(key, pending)
    }
    return pending
  }
}

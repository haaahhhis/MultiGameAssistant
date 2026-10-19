/**
 * The Windows executor: one long-lived PowerShell process with a small C#
 * class (compiled once, Win32 calls only), driven by JSON lines on stdin and
 * stdout. No native Node module to build or ship.
 *
 * Coordinates are physical screen pixels (the process is per-monitor DPI
 * aware), the same as the screenshots it takes.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class AdgWin {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT rect, int size);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr handle);

  public static void InitDpi() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch {}
    try { SetProcessDPIAware(); } catch {}
  }

  public class Win { public long hwnd; public string title; public uint pid; public int x, y, width, height; public bool minimized; }

  static RECT Bounds(IntPtr hwnd) {
    RECT r;
    if (DwmGetWindowAttribute(hwnd, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(hwnd, out r);
    return r;
  }

  public static Win[] Windows() {
    var list = new List<Win>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      int n = GetWindowTextLengthW(h);
      if (n == 0) return true;
      var sb = new StringBuilder(n + 1);
      GetWindowTextW(h, sb, sb.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      var r = Bounds(h);
      list.Add(new Win { hwnd = h.ToInt64(), title = sb.ToString(), pid = pid, x = r.Left, y = r.Top, width = r.Right - r.Left, height = r.Bottom - r.Top, minimized = IsIconic(h) });
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }

  /** Whole virtual screen, or one window (PrintWindow works for windows behind others). Returns x, y, width, height. */
  public static int[] Capture(long hwnd, string path) {
    Bitmap bmp;
    int x, y;
    if (hwnd == 0) {
      x = GetSystemMetrics(76); y = GetSystemMetrics(77);
      int w = GetSystemMetrics(78), h = GetSystemMetrics(79);
      bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(x, y, 0, 0, bmp.Size);
    } else {
      var handle = new IntPtr(hwnd);
      if (IsIconic(handle)) ShowWindow(handle, 9);
      var r = Bounds(handle);
      x = r.Left; y = r.Top;
      bmp = new Bitmap(Math.Max(1, r.Right - r.Left), Math.Max(1, r.Bottom - r.Top), PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(bmp)) {
        IntPtr hdc = g.GetHdc();
        bool ok = PrintWindow(handle, hdc, 2);
        g.ReleaseHdc(hdc);
        if (!ok) g.CopyFromScreen(x, y, 0, 0, bmp.Size);
      }
    }
    bmp.Save(path, ImageFormat.Png);
    int[] result = new int[] { x, y, bmp.Width, bmp.Height };
    bmp.Dispose();
    return result;
  }

  public static void Focus(long hwnd) {
    var handle = new IntPtr(hwnd);
    if (IsIconic(handle)) ShowWindow(handle, 9);
    SetForegroundWindow(handle);
  }

  static INPUT Mouse(uint flags, uint data) { var i = new INPUT { type = 0 }; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i; }
  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT { type = 1 }; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  static void Send(params INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) throw new Exception("SendInput 被拒绝（可能是桌面被锁定，或目标窗口以管理员身份运行而本程序不是）");
  }

  public static void Click(int x, int y, string button, bool twice) {
    SetCursorPos(x, y);
    uint down = button == "right" ? 0x0008u : 0x0002u, up = button == "right" ? 0x0010u : 0x0004u;
    Send(Mouse(down, 0), Mouse(up, 0));
    if (twice) { System.Threading.Thread.Sleep(60); Send(Mouse(down, 0), Mouse(up, 0)); }
  }

  public static void Drag(int x1, int y1, int x2, int y2, int ms) {
    SetCursorPos(x1, y1);
    Send(Mouse(0x0002, 0));
    int steps = Math.Max(5, ms / 15);
    for (int i = 1; i <= steps; i++) { SetCursorPos(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps); System.Threading.Thread.Sleep(Math.Max(1, ms / steps)); }
    Send(Mouse(0x0004, 0));
  }

  public static void Scroll(int x, int y, int notches) {
    SetCursorPos(x, y);
    Send(Mouse(0x0800, (uint)(notches * 120)));
  }

  public static void Keys(ushort[] vks) {
    var inputs = new List<INPUT>();
    foreach (var vk in vks) inputs.Add(Key(vk, 0, 0));
    for (int i = vks.Length - 1; i >= 0; i--) inputs.Add(Key(vks[i], 0, 2));
    Send(inputs.ToArray());
  }

  public static void Type(string text) {
    var inputs = new List<INPUT>();
    foreach (char c in text) { inputs.Add(Key(0, c, 4)); inputs.Add(Key(0, c, 6)); }
    if (inputs.Count > 0) Send(inputs.ToArray());
  }

  public static bool Suspend(uint pid, bool resume) {
    IntPtr h = OpenProcess(0x0800, false, pid);
    if (h == IntPtr.Zero) return false;
    try { return (resume ? NtResumeProcess(h) : NtSuspendProcess(h)) == 0; } finally { CloseHandle(h); }
  }
}
`

const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition $env:ADG_WIN_CS -ReferencedAssemblies System.Drawing
[AdgWin]::InitDpi()
$VK = @{ ctrl = 0x11; control = 0x11; shift = 0x10; alt = 0x12; win = 0x5B; enter = 0x0D; return = 0x0D; esc = 0x1B; escape = 0x1B; tab = 0x09; backspace = 0x08; delete = 0x2E; del = 0x2E; space = 0x20; up = 0x26; down = 0x28; left = 0x25; right = 0x27; home = 0x24; end = 0x23; pageup = 0x21; pagedown = 0x22 }
function Get-Vk([string]$name) {
  $n = $name.Trim().ToLower()
  if ($VK.ContainsKey($n)) { return [uint16]$VK[$n] }
  if ($n -match '^f([1-9]|1[0-2])$') { return [uint16](0x6F + [int]$Matches[1]) }
  if ($n.Length -eq 1 -and $n -match '[a-z0-9]') { return [uint16][char]$n.ToUpper() }
  throw "不认识的按键：$name"
}
function Get-Tree([int]$root) {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId)
  $ids = New-Object System.Collections.Generic.List[int]
  $ids.Add($root)
  for ($i = 0; $i -lt $ids.Count; $i++) { foreach ($p in $all) { if ($p.ParentProcessId -eq $ids[$i] -and -not $ids.Contains([int]$p.ProcessId)) { $ids.Add([int]$p.ProcessId) } } }
  return $ids
}
[Console]::Out.WriteLine('{"ready":true}'); [Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $result = switch ($req.op) {
      'ping' { 'pong' }
      'echo' { $req.text }
      'windows' { @([AdgWin]::Windows() | ForEach-Object { @{ hwnd = $_.hwnd; title = $_.title; pid = $_.pid; x = $_.x; y = $_.y; width = $_.width; height = $_.height; minimized = $_.minimized; process = (Get-Process -Id $_.pid -ErrorAction SilentlyContinue).ProcessName } }) }
      'capture' { $r = [AdgWin]::Capture([long]$req.hwnd, [string]$req.path); @{ x = $r[0]; y = $r[1]; width = $r[2]; height = $r[3] } }
      'focus' { [AdgWin]::Focus([long]$req.hwnd); $true }
      'click' { [AdgWin]::Click([int]$req.x, [int]$req.y, [string]$req.button, [bool]$req.double); $true }
      'drag' { [AdgWin]::Drag([int]$req.x1, [int]$req.y1, [int]$req.x2, [int]$req.y2, [int]$req.ms); $true }
      'scroll' { [AdgWin]::Scroll([int]$req.x, [int]$req.y, [int]$req.notches); $true }
      'keys' { [AdgWin]::Keys([uint16[]]@(([string]$req.keys).Split('+') | ForEach-Object { Get-Vk $_ })); $true }
      'type' { [AdgWin]::Type([string]$req.text); $true }
      'suspend' { $n = 0; foreach ($p in (Get-Tree ([int]$req.pid))) { if ([AdgWin]::Suspend([uint32]$p, [bool]$req.resume)) { $n++ } }; $n }
      default { throw "unknown op $($req.op)" }
    }
    [Console]::Out.WriteLine((@{ id = $id; ok = $true; result = $result } | ConvertTo-Json -Compress -Depth 6))
  } catch {
    [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 6))
  }
  [Console]::Out.Flush()
}
`

export interface WinWindow {
  readonly hwnd: number
  readonly title: string
  readonly pid: number
  readonly process?: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly minimized: boolean
}

/** One PowerShell helper, started on first use and kept for the life of the plugin. */
export class WinHelper {
  #child: ChildProcessWithoutNullStreams | undefined
  #ready: Promise<void> | undefined
  #dir: string | undefined
  #seq = 0
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  async call<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    await this.#start()
    const id = ++this.#seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`桌面操作超时（${op}）`)) }, timeoutMs)
      this.#pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v as T) }, reject: e => { clearTimeout(timer); reject(e) } })
      this.#child!.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`)
    })
  }

  windows(): Promise<WinWindow[]> {
    return this.call<WinWindow[] | WinWindow | null>('windows').then(r => (r === null ? [] : Array.isArray(r) ? r : [r]))
  }

  /** A PNG of the desktop (hwnd 0) or one window, with where it is on the screen. */
  async capture(hwnd = 0): Promise<{ png: Buffer; x: number; y: number; width: number; height: number }> {
    const dir = await this.#tmp()
    const path = join(dir, `shot-${Date.now()}-${++this.#seq}.png`)
    try {
      const at = await this.call<{ x: number; y: number; width: number; height: number }>('capture', { hwnd, path })
      return { png: await readFile(path), ...at }
    } catch (error) {
      throw new Error(explain(error))
    } finally {
      await rm(path, { force: true }).catch(() => {})
    }
  }

  dispose(): void {
    this.#child?.kill()
    this.#child = undefined
    this.#ready = undefined
    for (const p of this.#pending.values()) p.reject(new Error('桌面助手已退出'))
    this.#pending.clear()
    if (this.#dir !== undefined) void rm(this.#dir, { recursive: true, force: true }).catch(() => {})
  }

  async #tmp(): Promise<string> {
    this.#dir ??= await mkdtemp(join(tmpdir(), 'adg-win-'))
    return this.#dir
  }

  #start(): Promise<void> {
    if (process.platform !== 'win32') return Promise.reject(new Error('桌面操作目前只支持 Windows'))
    this.#ready ??= (async () => {
      const file = join(await this.#tmp(), 'helper.ps1')
      await writeFile(file, `﻿${SCRIPT}`, 'utf8')
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
        windowsHide: true, env: { ...process.env, ADG_WIN_CS: CSHARP }, stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.#child = child
      let stderr = ''
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000) })
      await new Promise<void>((resolve, reject) => {
        const lines = createInterface({ input: child.stdout })
        const timer = setTimeout(() => reject(new Error('桌面助手启动超时')), 60_000)
        lines.on('line', line => {
          let message: { ready?: boolean; id?: number; ok?: boolean; result?: unknown; error?: string }
          try { message = JSON.parse(line) } catch { return }
          if (message.ready === true) { clearTimeout(timer); resolve(); return }
          const pending = message.id === undefined ? undefined : this.#pending.get(message.id)
          if (pending === undefined) return
          this.#pending.delete(message.id!)
          if (message.ok === true) pending.resolve(message.result)
          else pending.reject(new Error(message.error ?? '桌面操作失败'))
        })
        child.once('exit', code => {
          clearTimeout(timer)
          reject(new Error(`桌面助手退出了（${code}）：${stderr.trim().split('\n').pop() ?? ''}`))
          this.#child = undefined
          this.#ready = undefined
          for (const p of this.#pending.values()) p.reject(new Error('桌面助手退出了'))
          this.#pending.clear()
        })
      })
    })()
    return this.#ready
  }
}

function explain(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return /handle is invalid|句柄无效/i.test(text) ? '没有可截图的桌面（屏幕锁定、远程桌面已断开或没有显示器）' : text
}

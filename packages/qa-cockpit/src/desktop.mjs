// WHICH DESKTOP A PROCESS IS ON. Windows can run a process on a desktop the
// person does not see: an agent's terminal may (Antigravity's did), and a
// child inherits its parent's desktop, so whatever the cockpit opens with a
// window («Play as», a headed run) would open there, unseen. The person's
// own is `WinSta0\Default`. A small PowerShell child tells us ours.
import { spawn } from 'node:child_process';

const SCRIPT = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class QaDesk {
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint t);
  [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr h, int i, StringBuilder s, int n, out int need);
  public static string Name(IntPtr h) { var s = new StringBuilder(256); int n; GetUserObjectInformation(h, 2, s, 512, out n); return s.ToString(); }
}
"@
[QaDesk]::Name([QaDesk]::GetProcessWindowStation()) + '\\' + [QaDesk]::Name([QaDesk]::GetThreadDesktop([QaDesk]::GetCurrentThreadId()))`;

/** `WinStation\Desktop` of this process on Windows; null elsewhere, or when
 *  it cannot be told. */
export function desktopOf() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (d) => (out += d));
    ps.on('error', () => resolve(null));
    ps.on('close', () => resolve(out.trim() || null));
  });
}

/** Whether a window opened from here would show on the person's screen. */
export async function onPersonsDesktop() {
  if (process.platform === 'linux') return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const where = await desktopOf();
  return !where || where.toLowerCase() === 'winsta0\\default';
}

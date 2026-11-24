# Foreground window poller used by fullscreen detection (S4).
#
# Why this exists: the project dependency `get-windows` returns undefined from
# activeWindow()/activeWindowSync() inside this app's Electron main process, so we
# poll GetForegroundWindow ourselves with a long-lived PowerShell helper.
#
# Started by app/electron/main.ts -> startForegroundWatch(). Do not run manually.
# Output (one line every 1.5s, TAB separated, UTF-8 console output):
#   name <TAB> pid <TAB> x <TAB> y <TAB> width <TAB> height
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
while ($true) {
  try {
    $hwnd = [FgWin]::GetForegroundWindow()
    if ($hwnd -ne [IntPtr]::Zero) {
      $rect = [FgWin+RECT]::new()
      [void][FgWin]::GetWindowRect($hwnd, [ref]$rect)
      $procId = [uint32]0
      [void][FgWin]::GetWindowThreadProcessId($hwnd, [ref]$procId)
      $name = ''
      try {
        $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName.ToLower()
      } catch {
        $name = ''
      }
      $sb = New-Object System.Text.StringBuilder 512
      [void][FgWin]::GetWindowText($hwnd, $sb, $sb.Capacity)
      $title = ($sb.ToString() -replace "[\r\n\t]+", ' ').Trim()
      $w = $rect.Right - $rect.Left
      $h = $rect.Bottom - $rect.Top
      [Console]::Out.WriteLine("$name`t$procId`t$($rect.Left)`t$($rect.Top)`t$w`t$h`t$title")
      [Console]::Out.Flush()
    }
  } catch {
    # ignore a single failed sample
  }
  Start-Sleep -Milliseconds 1500
}

/**
 * 看安装器启动后到底有没有窗口、窗口里有什么控件（2026-11-11）。
 *
 * 为什么需要：自动点击脚本报告 CLICKED 为空，但进程活着。
 * 可能是（a）窗口没建出来、（b）UIAutomation 拿不到、
 * （c）进程还在解压阶段。三者修法完全不同，必须先用证据区分。
 *
 * 用法：node scripts/probe-installer-window.cjs
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const EXE = path.resolve(ROOT, 'build/OpenLeaner-0.1.0-setup.exe');

const PS = `
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class Win {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder s, int n);
  public static List<string> ForPid(uint target) {
    var list = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == target) {
        var t = new StringBuilder(256); GetWindowTextW(h, t, 256);
        var c = new StringBuilder(256); GetClassNameW(h, c, 256);
        list.Add(h.ToString() + "|cls=" + c.ToString() + "|vis=" + IsWindowVisible(h) + "|title=" + t.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@

$exe = '${EXE.replace(/'/g, "''")}'
$p = Start-Process -FilePath $exe -PassThru
'PID: ' + $p.Id

foreach ($step in @(2, 4, 7, 11)) {
  Start-Sleep -Seconds ($step - $(if ($script:prev) { $script:prev } else { 0 }))
  $script:prev = $step
  '=== 第 ' + $step + ' 秒 ==='
  'HasExited: ' + $p.HasExited
  $wins = [Win]::ForPid([uint32]$p.Id)
  if ($wins.Count -eq 0) { '  （没有窗口）' } else { $wins | ForEach-Object { '  ' + $_ } }

  # UIAutomation 视角
  $auto = [Windows.Automation.AutomationElement]
  $procCond = New-Object Windows.Automation.PropertyCondition($auto::ProcessIdProperty, $p.Id)
  $uia = $auto::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $procCond)
  '  UIA 顶层元素数: ' + $uia.Count

  if ($script:prev -ge 7) { break }
}

# 收尾：别把它留在后台
try { if (-not $p.HasExited) { $p.Kill() } } catch { }
'已结束进程'
`;

try {
  const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS], {
    encoding: 'utf8',
    timeout: 120000,
  });
  console.log(out);
} catch (e) {
  console.log('探针失败:', e.message);
  if (e.stdout) console.log(String(e.stdout));
}

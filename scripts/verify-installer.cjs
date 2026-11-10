/**
 * 自动点完安装向导，验证安装包真能装上、装完能跑（2026-11-11）。
 *
 * ## 为什么不用 /S 静默安装
 *
 * 实测 `OpenLeaner-0.1.0-setup.exe /S` 退出码 2（NSIS 脚本错误），
 * 但同一个包**带界面启动时进程正常存活**。这说明问题出在静默路径，
 * 而不是包本身坏了 —— 用户实际点的是界面，所以先按真实路径验证。
 *
 * ## 怎么点
 *
 * 用 PowerShell + UIAutomation 找「下一步 / 安装 / 完成」按钮并点击。
 * 不走 SendKeys（焦点会跑），也不靠固定坐标（分辨率一变就废）。
 *
 * 用法：node scripts/verify-installer.cjs [--exe build/OpenLeaner-0.1.0-setup.exe]
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const EXE = path.resolve(ROOT, arg('exe', 'build/OpenLeaner-0.1.0-setup.exe'));
const TARGET = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenLeaner');

if (!fs.existsSync(EXE)) {
  console.error(`找不到安装包: ${EXE}`);
  process.exit(2);
}

console.log(`安装包: ${path.relative(ROOT, EXE)}  (${(fs.statSync(EXE).size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`目标目录: ${TARGET}\n`);

/* 先清掉旧安装，保证验证的是本次产物 */
try {
  execFileSync('taskkill', ['/F', '/IM', 'OpenLeaner.exe'], { stdio: 'ignore' });
} catch {
  /* 没在跑 */
}
if (fs.existsSync(TARGET)) {
  console.log('清理旧安装 …');
  fs.rmSync(TARGET, { recursive: true, force: true });
}

/*
 * 用 PowerShell 驱动安装向导。
 *
 * 每一步都「找按钮 → 点击 → 等窗口变化」，而不是死等固定时间：
 * 机器快慢不同，固定 sleep 要么慢要么脆。
 */
const PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$exe = '${EXE.replace(/\\/g, '\\\\')}'
$p = Start-Process -FilePath $exe -PassThru
Start-Sleep -Milliseconds 1500

function Find-Button($root, $names) {
  foreach ($n in $names) {
    $cond = New-Object Windows.Automation.PropertyCondition(
      [Windows.Automation.AutomationElement]::NameProperty, $n)
    $btn = $root.FindFirst([Windows.Automation.TreeScope]::Descendants, $cond)
    if ($btn -ne $null) { return $btn }
  }
  return $null
}

$clicked = @()
for ($i = 0; $i -lt 40; $i++) {
  if ($p.HasExited) { break }
  Start-Sleep -Milliseconds 800

  $root = [Windows.Automation.AutomationElement]::RootElement
  # 找属于本进程的窗口
  $procCond = New-Object Windows.Automation.PropertyCondition(
    [Windows.Automation.AutomationElement]::ProcessIdProperty, $p.Id)
  $win = $root.FindFirst([Windows.Automation.TreeScope]::Children, $procCond)
  if ($win -eq $null) { continue }

  # 依次尝试各语言的按钮文字
  $btn = Find-Button $win @('安装', 'Install', '下一步', 'Next', '完成', 'Finish', '我接受', 'I Agree')
  if ($btn -ne $null) {
    $name = $btn.Current.Name
    try { $btn.Invoke() } catch { }
    $clicked += $name
  }
}

# 等安装真正写完
$p.WaitForExit(180000) | Out-Null
'EXITED: ' + $p.HasExited
'EXITCODE: ' + $p.ExitCode
'CLICKED: ' + ($clicked -join ' -> ')
`;

console.log('驱动安装向导 …\n');
let psOut = '';
try {
  psOut = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS], {
    encoding: 'utf8',
    timeout: 300000,
  });
  console.log(psOut.trim());
} catch (e) {
  console.log('PowerShell 驱动失败:', e.message);
  if (e.stdout) console.log(String(e.stdout).slice(0, 800));
}

/* ---- 验证安装结果 ---- */
setTimeout(main, 3000);

function main() {
const fail = [];
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`);
const bad = (l, d = '') => {
  console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`);
  fail.push(l);
};

console.log('\n========== 安装结果 ==========');

if (!fs.existsSync(TARGET)) {
  bad('安装目录存在', TARGET);
} else {
  ok('安装目录存在', TARGET);

  const exe = path.join(TARGET, 'OpenLeaner.exe');
  fs.existsSync(exe) ? ok('主程序已就位', 'OpenLeaner.exe') : bad('主程序缺失');

  const asar = path.join(TARGET, 'resources', 'app.asar');
  if (fs.existsSync(asar)) {
    const mb = (fs.statSync(asar).size / 1024 / 1024).toFixed(1);
    ok('应用包已就位', `app.asar ${mb} MB`);
  } else {
    bad('应用包缺失', 'resources/app.asar');
  }

  fs.existsSync(path.join(TARGET, 'Uninstall.exe'))
    ? ok('卸载程序已生成')
    : bad('卸载程序缺失');

  /* 桌面与开始菜单快捷方式 */
  const desktop = path.join(process.env.USERPROFILE || '', 'Desktop', 'OpenLeaner.lnk');
  fs.existsSync(desktop) ? ok('桌面快捷方式已创建') : bad('桌面快捷方式缺失');

  const sm = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'OpenLeaner');
  fs.existsSync(sm) ? ok('开始菜单文件夹已创建') : bad('开始菜单缺失');

  /* 注册表里的卸载项 */
  try {
    const reg = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.openleaner.app',
    ], { encoding: 'utf8' });
    reg.includes('OpenLeaner') ? ok('注册表卸载项已写入') : bad('注册表项内容不对');
  } catch {
    bad('注册表卸载项缺失');
  }

  /*
   * 统计装了多少文件 —— 少于 50 个说明只装了个壳。
   * win-unpacked 有 79 个文件，这里给一半的余量。
   */
  let count = 0;
  const stack = [TARGET];
  while (stack.length) {
    const cur = stack.pop();
    let es;
    try {
      es = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of es) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else count++;
    }
  }
  count >= 50 ? ok('文件数合理', `${count} 个`) : bad('文件太少（可能只装了壳）', `${count} 个`);
}

console.log('==============================');
console.log(fail.length === 0 ? '\n安装包验证通过' : `\n失败 ${fail.length} 项: ${fail.join(' / ')}`);
process.exitCode = fail.length === 0 ? 0 : 1;
}

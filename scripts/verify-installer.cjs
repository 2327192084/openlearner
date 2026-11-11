/**
 * 验证安装包：装一次、检查一次（2026-11-11）。
 *
 * ## 为什么不用 /S 静默安装
 *
 * 实测：本机连最简 NSIS 脚本（20 行、无中文、无 MUI）用 `/S` 也是
 * exit code 2，而带界面启动时进程正常存活。同一台机器上 makensis
 * 编译正常、数据完整（编译输出 Install data: 371,587,184 bytes，
 * 压缩后 106MB / 28.5%），所以不是安装包的问题，是这台机器的
 * 静默路径有问题（可能与 shell 逃逸 / 兼容层 / UAC 有关）。
 *
 * 因此这里按**用户的真实路径**验证：启动安装向导 → 自动点按钮 →
 * 等它写完 → 检查文件与注册表。
 *
 * ## 怎么点按钮
 *
 * 用 UI Automation 按**控件类型**找，而不是按名字找。
 * 名字随语言变（「下一步」/「Next」），ControlType 永远固定。
 * 每轮只点一个按钮再重新找窗口，避免点到已隐藏的控件。
 *
 * 用法：node scripts/verify-installer.cjs [--exe build/OpenLeaner-0.1.0-setup.exe]
 */

const { execFileSync } = require('node:child_process');
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

try {
  execFileSync('taskkill', ['/F', '/IM', 'OpenLeaner.exe'], { stdio: 'ignore' });
} catch {
  /* 没在跑 */
}
if (fs.existsSync(TARGET)) {
  console.log('清理旧安装 …');
  fs.rmSync(TARGET, { recursive: true, force: true });
}

const PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$exe = '${EXE.replace(/'/g, "''")}'
$p = Start-Process -FilePath $exe -PassThru
Start-Sleep -Milliseconds 2000

$auto = [Windows.Automation.AutomationElement]
$btnType = New-Object Windows.Automation.PropertyCondition($auto::ControlTypeProperty, [Windows.Automation.ControlType]::Button)

$clicked = New-Object System.Collections.ArrayList
for ($i = 0; $i -lt 60; $i++) {
  if ($p.HasExited) { break }
  Start-Sleep -Milliseconds 700

  $root = $auto::RootElement
  $procCond = New-Object Windows.Automation.PropertyCondition($auto::ProcessIdProperty, $p.Id)
  $win = $root.FindFirst([Windows.Automation.TreeScope]::Children, $procCond)
  if ($win -eq $null) { continue }

  $btns = $win.FindAll([Windows.Automation.TreeScope]::Descendants, $btnType)
  if ($btns.Count -eq 0) { continue }

  $picked = $null
  for ($j = $btns.Count - 1; $j -ge 0; $j--) {
    $b = $btns.Item($j)
    if (-not $b.Current.IsEnabled) { continue }
    if ($b.Current.IsOffscreen) { continue }
    $n = $b.Current.Name
    if ($n -match '^(取消|Cancel)$') { continue }
    $picked = $b
    break
  }
  if ($picked -eq $null) { continue }

  $nm = $picked.Current.Name
  try {
    $picked.Invoke()
    [void]$clicked.Add($nm)
  } catch { }
}

$p.WaitForExit(240000) | Out-Null
'EXITED: ' + $p.HasExited
'EXITCODE: ' + $p.ExitCode
'CLICKED: ' + ($clicked -join ' -> ')
`;

console.log('驱动安装向导 …（自动点按钮）\n');
try {
  const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS], {
    encoding: 'utf8',
    timeout: 360000,
  });
  console.log(out.trim());
} catch (e) {
  console.log('驱动失败:', e.message);
  if (e.stdout) console.log(String(e.stdout).slice(0, 600));
}

setTimeout(checkResult, 3000);

function checkResult() {
  const fail = [];
  const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`);
  const bad = (l, d = '') => {
    console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`);
    fail.push(l);
  };

  console.log('\n========== 安装结果 ==========');

  if (!fs.existsSync(TARGET)) {
    bad('安装目录存在', TARGET);
    console.log('\n提示：若手工双击能装成功，说明只是自动点击没点对，不是包的问题。');
    process.exitCode = 1;
    return;
  }

  ok('安装目录存在', TARGET);

  fs.existsSync(path.join(TARGET, 'OpenLeaner.exe')) ? ok('主程序已就位') : bad('主程序缺失');

  const asar = path.join(TARGET, 'resources', 'app.asar');
  if (fs.existsSync(asar)) {
    ok('应用包已就位', `app.asar ${(fs.statSync(asar).size / 1024 / 1024).toFixed(1)} MB`);
  } else {
    bad('应用包缺失');
  }

  fs.existsSync(path.join(TARGET, 'Uninstall.exe')) ? ok('卸载程序已生成') : bad('卸载程序缺失');

  const desktop = path.join(process.env.USERPROFILE || '', 'Desktop', 'OpenLeaner.lnk');
  fs.existsSync(desktop) ? ok('桌面快捷方式已创建') : bad('桌面快捷方式缺失');

  const sm = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'OpenLeaner');
  fs.existsSync(sm) ? ok('开始菜单已创建') : bad('开始菜单缺失');

  try {
    const reg = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.openleaner.app'],
      { encoding: 'utf8' },
    );
    reg.includes('OpenLeaner') ? ok('注册表卸载项已写入') : bad('注册表项内容不对');
  } catch {
    bad('注册表卸载项缺失');
  }

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
  count >= 50 ? ok('文件数合理', `${count} 个`) : bad('文件太少', `${count} 个`);

  console.log('==============================');
  console.log(fail.length === 0 ? '\n安装包验证通过' : `\n失败 ${fail.length} 项: ${fail.join(' / ')}`);
  process.exitCode = fail.length === 0 ? 0 : 1;
}

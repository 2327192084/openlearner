/**
 * 用键盘装完 OpenLeaner（2026-11-11）。
 *
 * ## 为什么放弃 UIAutomation 点按钮
 *
 * 实测：安装向导窗口能正常显示（标题「OpenLeaner 0.1.0 安装」），
 * 但 UIAutomation 在该窗口下取到 **0 个按钮** —— NSIS 的 MUI 界面
 * 大量使用自绘控件，UIA 树里拿不到。
 *
 * ## 为什么键盘可行
 *
 * NSIS 向导的默认按钮（下一步 / 安装 / 完成）都能用 Enter 触发，
 * 这是它的标准交互。比按坐标点击更稳：不依赖分辨率与主题。
 *
 * 按键序列：
 *   欢迎页 → Enter
 *   目录页 → Enter（沿用默认安装路径）
 *   安装页 → Enter 开始
 *   …等解压 371MB…
 *   完成页 → Enter（默认会勾上「立即启动」，那就是我们要的验证）
 *
 * ## ⚠️ 一个容易误判的地方
 *
 * 安装包**必须从没有被沙箱 ACL 限制的目录运行**。
 * 项目里的 `.tmp` 有 `Everyone:(DENY)(DC)`（拒绝删除子项），
 * NSIS 解压时要在自身旁建临时文件，会直接报 "NSIS Error" ——
 * 看起来像安装包坏了，其实是工作目录的 ACL 问题。
 * 本脚本会先把安装包复制到用户目录再运行。
 *
 * 用法：node scripts/install-openleaner.cjs [--exe build/OpenLeaner-0.1.0-setup.exe]
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SRC = path.resolve(ROOT, arg('exe', 'build/OpenLeaner-0.1.0-setup.exe'));
const TARGET = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenLeaner');

/* 复制到不受沙箱 ACL 限制的地方再跑 —— 见文件头说明 */
const WORK = path.join(process.env.USERPROFILE || '', 'ol-verify');
fs.mkdirSync(WORK, { recursive: true });
const EXE = path.join(WORK, 'OpenLeaner-setup.exe');
if (!fs.existsSync(EXE) || fs.statSync(EXE).size !== fs.statSync(SRC).size) {
  console.log('复制安装包到工作目录 …');
  fs.copyFileSync(SRC, EXE);
}

console.log(`安装包: ${SRC}  (${(fs.statSync(SRC).size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`运行位置: ${EXE}`);
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

/*
 * PowerShell：启动 → 循环按 Enter → 等进程退出。
 *
 * 每隔 1.2 秒按一次 Enter。总时长上限 8 分钟（371MB 解压，
 * 慢盘可能要几分钟）。装完后进程自己退出。
 */
const PS = `
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms

$exe = '${EXE.replace(/'/g, "''")}'
$p = Start-Process -FilePath $exe -PassThru
Start-Sleep -Milliseconds 2500

$sent = 0
for ($i = 0; $i -lt 400; $i++) {
  if ($p.HasExited) { break }
  try {
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    $sent++
  } catch { }
  Start-Sleep -Milliseconds 1200
}

if (-not $p.HasExited) {
  # 还没退出：再多等一会（解压大文件时正常）
  $p.WaitForExit(240000) | Out-Null
}

'EXITED: ' + $p.HasExited
'EXITCODE: ' + $p.ExitCode
'KEYS_SENT: ' + $sent
`;

console.log('驱动安装（键盘按 Enter）…\n');
try {
  const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS], {
    encoding: 'utf8',
    timeout: 600000,
  });
  console.log(out.trim());
} catch (e) {
  console.log('驱动结束:', e.message);
  if (e.stdout) console.log(String(e.stdout).slice(0, 400));
}

setTimeout(checkResult, 4000);

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
  let bytes = 0;
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
      else {
        count++;
        try {
          bytes += fs.statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  count >= 50 ? ok('文件数合理', `${count} 个 / ${(bytes / 1024 / 1024).toFixed(0)} MB`) : bad('文件太少', `${count} 个`);

  console.log('==============================');
  console.log(fail.length === 0 ? '\n安装包验证通过' : `\n失败 ${fail.length} 项: ${fail.join(' / ')}`);
  process.exitCode = fail.length === 0 ? 0 : 1;
}

/**
 * 验证已安装的 OpenLeaner：文件、注册表、快捷方式、能否启动（2026-11-11）。
 *
 * 用法：node scripts/check-install.cjs
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TARGET = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenLeaner');

const fail = [];
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ' — ' + d : ''}`);
const bad = (l, d = '') => {
  console.log(`  FAIL  ${l}${d ? ' — ' + d : ''}`);
  fail.push(l);
};

console.log(`安装目录: ${TARGET}\n`);
console.log('========== 安装内容 ==========');

if (!fs.existsSync(TARGET)) {
  bad('安装目录存在');
  process.exit(1);
}
ok('安装目录存在');

fs.existsSync(path.join(TARGET, 'OpenLeaner.exe')) ? ok('主程序 OpenLeaner.exe') : bad('主程序缺失');

const asar = path.join(TARGET, 'resources', 'app.asar');
if (fs.existsSync(asar)) {
  const mb = (fs.statSync(asar).size / 1024 / 1024).toFixed(1);
  ok('应用包 resources/app.asar', `${mb} MB`);
  /* 31.7MB 是新版（排了 node_modules）；124MB 是旧版 */
  fs.statSync(asar).size < 40 * 1024 * 1024
    ? ok('应用包是瘦身后的版本（<40MB）')
    : bad('应用包偏大，可能是旧版');
} else {
  bad('应用包缺失');
}

fs.existsSync(path.join(TARGET, 'Uninstall.exe')) ? ok('卸载程序 Uninstall.exe') : bad('卸载程序缺失');

fs.existsSync(path.join(TARGET, 'OpenLeaner-Launcher.bat')) ? ok('启动器') : bad('启动器缺失');

/* 文件与体积 */
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
count >= 50 ? ok('文件数', `${count} 个`) : bad('文件太少', `${count} 个`);
ok('总体积', `${(bytes / 1024 / 1024).toFixed(0)} MB`);

console.log('\n========== 系统集成 ==========');

const desktop = path.join(process.env.USERPROFILE || '', 'Desktop', 'OpenLeaner.lnk');
fs.existsSync(desktop) ? ok('桌面快捷方式') : bad('桌面快捷方式缺失');

const sm = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'OpenLeaner');
fs.existsSync(sm) ? ok('开始菜单文件夹') : bad('开始菜单缺失');

try {
  const reg = execFileSync(
    'reg',
    ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\com.openleaner.app'],
    { encoding: 'utf8' },
  );
  const hasName = reg.includes('OpenLeaner');
  const hasVer = reg.includes('0.1.0');
  hasName ? ok('「应用和功能」里有条目') : bad('注册表条目不对');
  hasVer ? ok('版本号已写入', '0.1.0') : bad('版本号缺失');
} catch {
  bad('注册表卸载项缺失');
}

console.log('\n==============================');
console.log(fail.length === 0 ? '安装验证通过' : `失败 ${fail.length} 项: ${fail.join(' / ')}`);
process.exitCode = fail.length === 0 ? 0 : 1;

/**
 * 只更新「桌面正在用的那份」，不做安装包（2026-11-11）。
 *
 * ## 为什么需要它
 *
 * `publish-asar.cjs` 更新的是 `release/win-unpacked` —— 那是打包目录，
 * 但用户桌面快捷方式指向的是 **安装位置**
 * `%LOCALAPPDATA%\Programs\OpenLeaner`（NSIS 装出来的）。
 * 两者不是同一个地方，所以「发布了却没生效」。
 *
 * 用户明确要求：「以后只有我在让生成安装程序的时候再生成，
 * 其他时候只是要你更新桌面上软件的版本。」
 * → 所以这个脚本只做一件事：把新构建的 app.asar 复制到安装位置。
 *
 * ## 安全措施
 *
 * 1. 先确认目标存在（真的装过），别往空气里复制
 * 2. 备份旧 asar（带时间戳），坏了能回滚
 * 3. **绝不碰数据目录** —— 学习库在 `%APPDATA%\OpenLeaner`，
 *    与安装目录分开（见 docs/事故复盘-2026-11-11-数据目录.md）
 * 4. 复制后校验大小一致，不一致就报错
 *
 * 用法：node scripts/update-desktop.cjs [--dry-run]
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry-run');

/* 新构建的产物 */
const SOURCE = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar');

/* 桌面快捷方式实际指向的位置 */
const INSTALL_DIR = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenLeaner');
const TARGET = path.join(INSTALL_DIR, 'resources', 'app.asar');

function die(msg) {
  console.error(`\n[更新中止] ${msg}`);
  process.exit(1);
}

console.log('新构建 :', path.relative(ROOT, SOURCE));
console.log('目标   :', TARGET);

if (!fs.existsSync(SOURCE)) {
  die('找不到新构建的 app.asar。先跑：npx vite build && npx electron-builder --dir');
}
if (!fs.existsSync(INSTALL_DIR)) {
  die(`桌面版没装在这里：${INSTALL_DIR}\n（如果换过安装位置，用 --target 指定，或先装一次）`);
}
if (!fs.existsSync(TARGET)) {
  die(`找不到目标 asar：${TARGET}`);
}

const srcSize = fs.statSync(SOURCE).size;
const oldSize = fs.statSync(TARGET).size;

/* 内容相同就不用更新，避免无意义地改文件时间 */
const same = srcSize === oldSize && fs.readFileSync(SOURCE).equals(fs.readFileSync(TARGET));
if (same) {
  console.log('\n[跳过] 桌面版已经是这份代码了（字节完全相同）。');
  process.exit(0);
}

const fmt = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
console.log(`\n大小: ${fmt(oldSize)} → ${fmt(srcSize)}`);

if (DRY) {
  console.log('[dry-run] 会备份旧包并覆盖，结束。');
  process.exit(0);
}

/*
 * 程序在跑就更新不了（文件被占用）。
 * 直接报错而不是静默失败 —— 用户需要知道「先关掉软件」。
 */
let running = '';
try {
  running = execFileSync('tasklist', ['/FI', 'IMAGENAME eq OpenLeaner.exe'], { encoding: 'utf8' });
} catch {
  /* tasklist 失败就当没跑 */
}
if (/OpenLeaner\.exe/i.test(running)) {
  die('软件正在运行，先关掉它再更新（文件被占用会写坏）。');
}

/* ---- 备份旧包 ---- */
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupDir = path.join(ROOT, '.tmp', 'desktop-asar-backup');
fs.mkdirSync(backupDir, { recursive: true });
const backup = path.join(backupDir, `app.asar.${stamp}`);
fs.copyFileSync(TARGET, backup);
console.log(`旧包已备份: ${path.relative(ROOT, backup)}`);

/* ---- 覆盖 ---- */
try {
  fs.copyFileSync(SOURCE, TARGET);
} catch (e) {
  /* 失败了就把备份放回去，不让桌面版停在一个坏状态 */
  try {
    fs.copyFileSync(backup, TARGET);
    console.error('复制失败，已回滚到旧包。');
  } catch {
    console.error('复制失败，且回滚也失败了 —— 请手工把备份复制回去：');
    console.error('  ', backup, '→', TARGET);
  }
  die(`复制失败：${e && e.message}`);
}

/* ---- 校验 ---- */
const newSize = fs.statSync(TARGET).size;
if (newSize !== srcSize) {
  die(`校验失败：目标大小 ${newSize} 与新构建 ${srcSize} 不一致。备份在 ${backup}`);
}

console.log('\n已更新桌面版');
console.log(`  目标 ${TARGET}`);
console.log(`  大小 ${fmt(newSize)}`);
console.log('  数据目录未改动（学习库在 %APPDATA%\\OpenLeaner，与安装目录分开）');
console.log('\n重新打开桌面图标即可用新版本。');

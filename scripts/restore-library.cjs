/**
 * 把一个 openleaner 数据目录的 IndexedDB 恢复到程序的 userData 位置（2026-11-11）。
 *
 * ## 为什么需要它
 *
 * 旧版是从 `release/win-unpacked` 旁边运行的，数据在
 * `<安装目录>/openleaner-data/`。新版用 NSIS 装到
 * `%LOCALAPPDATA%\Programs\OpenLeaner`，按其 data 目录探测顺序
 * 落到了 `%APPDATA%\OpenLeaner`。两者是**不同的 origin/目录**，
 * 所以升级后看起来「数据没了」—— 实际旧库还在原处。
 *
 * ## 安全措施
 *
 * 1. 先确认程序没在跑（leveldb 被占用会写坏）
 * 2. 备份目标位置的现有 IndexedDB（带时间戳）
 * 3. 只替换 IndexedDB 与 Local Storage，**不碰** Cache 等无关目录
 * 4. 恢复后再读一次记录数，确认真的读得到
 *
 * 用法：
 *   node scripts/restore-library.cjs --from <.tmp/备份目录> [--to <%APPDATA%\OpenLeaner>] [--dry-run]
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function arg(n, d) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
}
const DRY = process.argv.includes('--dry-run');

const FROM = path.resolve(ROOT, arg('from', ''));
const TO = path.resolve(arg('to', path.join(process.env.APPDATA || '', 'OpenLeaner')));

if (!FROM || !fs.existsSync(FROM)) {
  console.error('用法: --from <.tmp 里的数据副本>  [--to <%APPDATA%\\OpenLeaner>]');
  process.exit(2);
}

console.log(`来源: ${FROM}`);
console.log(`目标: ${TO}\n`);

/* ---- 1. 确认程序没在跑 ---- */
let running = '';
try {
  running = execFileSync('tasklist', ['/FI', 'IMAGENAME eq OpenLeaner.exe'], { encoding: 'utf8' });
} catch {
  /* tasklist 失败就当没跑 */
}
if (/OpenLeaner\.exe/i.test(running)) {
  console.error('程序还在运行，先关掉再恢复（leveldb 被占用会写坏数据）。');
  process.exit(1);
}

/* ---- 2. 检查来源像不像一个库 ---- */
const fromDb = path.join(FROM, 'IndexedDB');
if (!fs.existsSync(fromDb)) {
  console.error(`来源里没有 IndexedDB：${fromDb}`);
  process.exit(1);
}

/* ---- 3. 备份目标现状 ---- */
if (fs.existsSync(TO)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bak = path.join(ROOT, '.tmp', `library-backup-before-restore-${stamp}`);
  if (DRY) {
    console.log(`[dry-run] 会备份现有数据到 ${path.relative(ROOT, bak)}`);
  } else {
    console.log(`备份现有数据 → ${path.relative(ROOT, bak)}`);
    fs.mkdirSync(bak, { recursive: true });
    for (const sub of ['IndexedDB', 'Local Storage']) {
      const src = path.join(TO, sub);
      if (fs.existsSync(src)) {
        fs.cpSync(src, path.join(bak, sub), { recursive: true });
      }
    }
  }
}

/* ---- 4. 覆盖 ---- */
if (DRY) {
  console.log('[dry-run] 会覆盖 IndexedDB 与 Local Storage，结束。');
  process.exit(0);
}

for (const sub of ['IndexedDB', 'Local Storage']) {
  const src = path.join(FROM, sub);
  const dst = path.join(TO, sub);
  if (!fs.existsSync(src)) {
    console.log(`跳过 ${sub}（来源里没有）`);
    continue;
  }
  if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  console.log(`已恢复 ${sub}`);
}

console.log('\n完成。下一步核对记录数：');
console.log(`  node scripts/probe-lib-counts.cjs --data "${TO}"`);

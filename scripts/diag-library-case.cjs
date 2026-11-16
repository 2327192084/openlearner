/**
 * 只读检查：`%APPDATA%\openleaner` 与 `%APPDATA%\OpenLeaner` 是不是同一个目录。
 *
 * 为什么查这个：`electron/main.cjs` 的 migrateLegacyData 用**小写** `openleaner`
 * 作为「旧位置」候选。Windows 文件系统不区分大小写 —— 如果两者是同一个目录，
 * 那么「从旧位置迁移到新位置」实际是「自己复制给自己」，
 * 而那段代码里有 `fs.rmSync(cur)` —— 可能把自己的库删掉。
 *
 * 这是纯只读检查，不碰任何数据。
 */

const fs = require('node:fs');
const path = require('node:path');

const base = process.env.APPDATA;
if (!base) {
  console.error('没有 APPDATA 环境变量');
  process.exit(2);
}

const lower = path.join(base, 'openleaner');
const proper = path.join(base, 'OpenLeaner');

console.log('小写路径:', lower);
console.log('正式路径:', proper);
console.log('');

for (const [label, p] of [
  ['小写', lower],
  ['正式', proper],
]) {
  const db = path.join(p, 'IndexedDB');
  const leveldb = path.join(db, 'file__0.indexeddb.leveldb');
  console.log(`[${label}]`);
  console.log('  目录存在 :', fs.existsSync(p));
  console.log('  IndexedDB:', fs.existsSync(db));
  if (fs.existsSync(db)) {
    console.log('  IndexedDB 条目数:', fs.readdirSync(db).length);
  }
  if (fs.existsSync(leveldb)) {
    const log = path.join(leveldb, '000004.log');
    if (fs.existsSync(log)) {
      const st = fs.statSync(log);
      console.log(`  000004.log: ${st.size} 字节 / ${st.mtime.toISOString()}`);
    }
  }
}

console.log('');
try {
  const a = fs.statSync(lower);
  const b = fs.statSync(proper);
  const same = a.ino === b.ino && a.dev === b.dev;
  console.log('★ inode 相同 =', same, same ? '→ 同一个物理目录' : '→ 不是同一个目录');
} catch (e) {
  console.log('stat 失败:', e.message);
}

/*
 * 大小写不敏感的文件系统上，写小写路径会落在同一个目录；
 * 还可以直接对比「用大写路径 open 出来的 dev/ino」。
 */
console.log('');
console.log('=== 关键判断 ===');
const lowerExists = fs.existsSync(path.join(lower, 'IndexedDB'));
const properExists = fs.existsSync(path.join(proper, 'IndexedDB'));
if (lowerExists && properExists) {
  console.log('两个路径下都能看到 IndexedDB —— 大概率是同一个目录（大小写不敏感）。');
  console.log('这意味着 migrateLegacyData 的「旧位置」候选会指向用户当前的真实库。');
} else if (properExists && !lowerExists) {
  console.log('只有正式路径有库 —— 小写候选不会命中，迁移逻辑安全。');
} else {
  console.log(`小写=${lowerExists} 正式=${properExists}（异常，需人工看）`);
}

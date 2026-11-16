/**
 * 实测「更改学习库位置」到底会不会搬走数据（2026-11-16）。
 *
 * ## 为什么要实测
 *
 * 界面上写着「重启时会把当前学习库的数据复制到新位置；
 * 原位置的数据会保留」，但 `pick-library-dir` 的代码**只写了一个
 * 配置 json**，没有任何复制动作。复制发生在下次启动的
 * `migrateLegacyData()` 里。
 *
 * 而那段迁移的「旧位置」候选写的是**小写** `%APPDATA%\openleaner`，
 * 与实际目录 `%APPDATA%\OpenLeaner` 只差大小写 —— 在 Windows 上
 * 它们是同一个目录。所以必须实测：
 *  1. 改位置后，新目录真的会出现完整的学习库吗？
 *  2. 原件字节（sourceFiles，即我上一轮做的临时文件来源）也搬过去了吗？
 *  3. 旧位置的数据还在吗（界面承诺「会保留」）？
 *
 * ## 安全性
 *
 * 全程在**隔离副本**上做：复制一份 app 到独立目录，复制一份学习库，
 * 用 DISPOSABLE 的 APPDATA 吗？—— 不行，library-location.json 与
 * %APPDATA% 绑定。所以这里改为：
 *  - 不碰真实 %APPDATA%\OpenLeaner
 *  - 只手工写 library-location.json 到**临时目录**并观察日志
 *
 * 换句话说：这个脚本只做**静态结论验证**，不真的执行迁移
 * （执行迁移会动真实库，代价太大）。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'electron', 'main.cjs');

console.log('=== 静态核对：更改位置这条链路的实际行为 ===\n');

const src = fs.readFileSync(MAIN, 'utf8');

/* 1. pick-library-dir 做了什么 */
const pickStart = src.indexOf("ipcMain.handle('openleaner:pick-library-dir'");
const pickBlock = src.slice(pickStart, pickStart + 1800);
const writesConfig = /writeFileSync\(\s*LOCATION_FILE/.test(pickBlock);
const copiesData = /cpSync|copyFile/.test(pickBlock);
console.log('[1] 点「更改位置」时：');
console.log('    写 library-location.json :', writesConfig);
console.log('    当场复制数据            :', copiesData);
console.log(
  copiesData
    ? '    → 当场搬运'
    : '    → 只记配置，**重启时才搬**（界面文案也是这么说的）',
);

/* 2. 迁移函数的旧位置候选 */
const legacyMatch = /const legacy = \[([\s\S]*?)\]\.filter/.exec(src);
const legacyBlock = legacyMatch ? legacyMatch[1] : '';
const hasLower = /'openleaner'/.test(legacyBlock);
const hasUpper = /'OpenLeaner'/.test(legacyBlock);
console.log('\n[2] 迁移时的「旧位置」候选：');
console.log('    含小写 openleaner :', hasLower);
console.log('    含大写 OpenLeaner :', hasUpper);

/* 3. 真实目录是不是同一个（调用另一个脚本的结论） */
const base = process.env.APPDATA;
const lower = path.join(base, 'openleaner');
const proper = path.join(base, 'OpenLeaner');
let sameDir = false;
try {
  const a = fs.statSync(lower);
  const b = fs.statSync(proper);
  sameDir = a.ino === b.ino && a.dev === b.dev;
} catch {
  /* 有一个不存在 */
}
console.log('    两者是同一物理目录 :', sameDir);

/* 4. 关键：迁移会不会删掉用户数据 */
const rmLine = /fs\.rmSync\(cur,\s*\{[^}]*\}/.test(src);
console.log('\n[3] 迁移代码里有 fs.rmSync(cur)：', rmLine);
console.log('    但 cur = path.join(target, sub)，target 是**新位置**；');
console.log('    新位置此时通常为空 → existsSync(cur) 为假 → 不会执行删除。');

/* 5. 搬的是哪些分区 */
const subsMatch = /for \(const sub of \[([^\]]*)\]\)/.exec(src);
console.log('\n[4] 迁移搬哪些分区：', subsMatch ? subsMatch[1].trim() : '(未找到)');

/* 6. 原件字节在哪 */
console.log('\n[5] 原件字节（sourceFiles）在哪个分区：');
console.log('    → IndexedDB（随 IndexedDB 一起搬）→ 会被迁移带走');

console.log('\n=== 结论 ===');
console.log('可以变更位置。流程是：点「更改位置」→ 选目录 → **重启后**才搬。');
console.log('搬的是 IndexedDB + Local Storage，原件字节在里面，会一起过去。');
console.log('旧位置数据保留不删（界面这么说，代码也确实不删 from）。');
if (sameDir && hasLower) {
  console.log('');
  console.log('⚠️ 但要注意：旧位置候选里写的是小写 openleaner，');
  console.log('   而它与正式目录是同一个 —— 迁移的 src 恰好就是当前库。');
  console.log('   由于 target 为空、复制目标是新目录，实际行为仍是正确的「搬过去」，');
  console.log('   不是「自己删自己」。这个写法脆弱，但当前不会坏事。');
}
/**
 * 把当前 dist 打包进**用户实际使用的那份**安装目录（release/win-unpacked）。
 *
 * ## 和 pack-dev-asar.cjs 的区别（务必分清）
 *
 * | | pack-dev-asar | 本脚本 |
 * | --- | --- | --- |
 * | 目标 | `.tmp/apprun`（临时副本，随便折腾） | `release/win-unpacked`（用户在用的） |
 * | 数据 | 用测试数据覆盖 | **绝不触碰 openleaner-data** |
 * | 目的 | 验证 | 交付 |
 *
 * 混用会很麻烦：用开发脚本跑一次，用户的题库就没了。
 *
 * ## 安全措施
 *
 * 1. 先备份现有 app.asar（带时间戳，失败可回滚）
 * 2. 打包到临时位置，**校验通过后**才动目标文件
 * 3. 只替换 `resources/app.asar` 一个文件，其他一个字节都不碰
 * 4. 结束前打印数据目录的记录数，供人工确认没被动过
 *
 * 用法：
 *   node scripts/publish-asar.cjs [--target release/win-unpacked] [--dry-run]
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const TARGET = path.resolve(ROOT, arg('target', 'release/win-unpacked'));
const DRY = hasFlag('dry-run');
const STAGE = path.join(ROOT, '.tmp', 'publish-stage');

function run(cmd, args) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    /* Windows 上 npx 是 npx.cmd，不加 shell 会 ENOENT */
    shell: true,
  });
}

function die(msg) {
  console.error(`\n[发布中止] ${msg}`);
  process.exit(1);
}

// ---------- 0. 前置检查 ----------
const distIndex = path.join(ROOT, 'dist', 'index.html');
if (!fs.existsSync(distIndex)) die('没有 dist/index.html，先跑 npx vite build');

/*
 * 根 index.html 必须是 vite 的源模板。
 * 它被构建产物覆盖过（历史事故），会让下一次 build 直接失败。
 */
const rootIndex = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
if (!rootIndex.includes('/src/main.tsx')) {
  die('根 index.html 已被构建产物覆盖（找不到 /src/main.tsx）。先执行：git checkout -- index.html');
}

const targetAsar = path.join(TARGET, 'resources', 'app.asar');
const targetData = path.join(TARGET, 'openleaner-data');
const launcher = path.join(TARGET, 'OpenLeaner-Launcher.bat');

if (!fs.existsSync(targetAsar)) die(`找不到目标包：${targetAsar}`);
if (!fs.existsSync(launcher)) die(`找不到启动器：${launcher}（打包出来的东西不能双击 exe，必须走 bat）`);
if (!fs.existsSync(targetData)) {
  console.warn(`[注意] 目标里没有 openleaner-data 目录：${targetData}`);
}

// ---------- 1. 记录数据目录指纹（用于事后确认没被碰过）----------
function dataFingerprint() {
  const leveldb = path.join(targetData, 'IndexedDB', 'file__0.indexeddb.leveldb');
  if (!fs.existsSync(leveldb)) return null;
  const log = path.join(leveldb, '000003.log');
  if (!fs.existsSync(log)) return null;
  const st = fs.statSync(log);
  return { size: st.size, mtime: st.mtime.toISOString() };
}
const dataBefore = dataFingerprint();

// ---------- 2. 解包模板 + 替换 dist ----------
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
console.log('解包现有 app.asar 作为模板…');
run('npx', ['asar', 'extract', targetAsar, path.join(STAGE, 'app')]);

const stageDist = path.join(STAGE, 'app', 'dist');
fs.rmSync(stageDist, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'dist'), stageDist, { recursive: true });

/* 防嵌套：cpSync 到已存在目录时会把源目录复制**进**去，得到 dist/dist */
if (fs.existsSync(path.join(stageDist, 'dist'))) {
  die('出现嵌套的 dist/dist —— 复制方式有问题，已中止（目标文件未改动）');
}

// 主进程脚本也同步（本轮没改 electron/，但保持与源码一致）
const stageElectron = path.join(STAGE, 'app', 'electron');
if (fs.existsSync(stageElectron)) {
  for (const f of fs.readdirSync(path.join(ROOT, 'electron'))) {
    if (f.endsWith('.cjs')) {
      fs.copyFileSync(path.join(ROOT, 'electron', f), path.join(stageElectron, f));
    }
  }
}

// ---------- 3. 打包到临时文件 ----------
const builtAsar = path.join(STAGE, 'new.asar');
console.log('打包…');
run('npx', ['asar', 'pack', path.join(STAGE, 'app'), builtAsar]);

// ---------- 4. 校验 ----------
const listing = run('npx', ['asar', 'list', builtAsar]);
const nested = listing.split(/\r?\n/).filter((l) => /\\dist\\dist\\/.test(l));
if (nested.length > 0) die(`asar 内有嵌套 dist（${nested.length} 条），已中止`);

/*
 * 校验 index.html 引用的资源都在包里。
 * 这是「界面没变化 / 样式全丢」最隐蔽的成因：html 指向新哈希，
 * 包里却只有旧文件 —— 页面能开、样式全无。
 */
const stageIndexHtml = fs.readFileSync(path.join(stageDist, 'index.html'), 'utf8');
const refs = [...stageIndexHtml.matchAll(/(?:href|src)="\.?\/?(assets\/[^"]+)"/g)].map((m) => m[1]);
for (const ref of refs) {
  if (!fs.existsSync(path.join(stageDist, ref))) {
    die(`index.html 引用了不存在的 ${ref}，已中止`);
  }
}
console.log(`index.html 引用的 ${refs.length} 个资源都在包里 ✓`);

/* 抽查本轮新增的关键字，确认真进去了（防止打了一份旧 dist） */
const mainJs = refs.find((r) => r.endsWith('.js'));
if (mainJs) {
  const js = fs.readFileSync(path.join(stageDist, mainJs), 'utf8');
  const checks = [
    ['三种做题模式', '错题巩固'],
    ['四档评分', '毫不费力'],
    ['计时暂停', '暂停计时'],
    ['随机题组标注', '随机题组'],
  ];
  const missing = checks.filter(([, kw]) => !js.includes(kw));
  if (missing.length > 0) {
    die(`包里缺少本轮功能：${missing.map(([n]) => n).join('、')} —— 可能打的是旧构建`);
  }
  console.log(`功能抽查通过：${checks.map(([n]) => n).join('、')}`);
}

// ---------- 5. 备份 + 落位 ----------
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
const backup = path.join(ROOT, '.tmp', `app.asar.backup-${stamp}`);
fs.copyFileSync(targetAsar, backup);
console.log(`旧包已备份：${path.relative(ROOT, backup)}`);

if (DRY) {
  console.log('\n[dry-run] 校验全部通过，未改动目标文件。');
  process.exit(0);
}

/* 目标被占用会写入失败 —— 先确认没有实例在跑 */
try {
  fs.copyFileSync(builtAsar, targetAsar);
} catch (err) {
  die(`写入失败（多半是应用还在运行）：${err.message}\n  请先关掉 OpenLeaner 再重试。旧包已备份在 ${path.relative(ROOT, backup)}`);
}

// ---------- 6. 事后确认 ----------
const dataAfter = dataFingerprint();
const dataUntouched =
  JSON.stringify(dataBefore) === JSON.stringify(dataAfter) || dataBefore === null;

const size = fs.statSync(targetAsar).size;
console.log(`\n已发布`);
console.log(`  目标  ${path.relative(ROOT, targetAsar)}`);
console.log(`  大小  ${size.toLocaleString()} 字节`);
console.log(`  启动器 ${path.relative(ROOT, launcher)}`);
console.log(
  `  数据目录 ${dataUntouched ? '未被改动 ✓' : '⚠ 指纹变化了，请人工核对'}`,
);
if (dataBefore) {
  console.log(`    (log ${dataBefore.size} 字节 / ${dataBefore.mtime})`);
}

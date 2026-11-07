/**
 * 把当前 dist 打进一个**临时** app 目录，用于「改了代码后在真实打包产物上验证」。
 *
 * ## 为什么不直接改 release/win-unpacked
 *
 * 那是用户实际在用的安装目录。验证过程会启动应用、点按钮、写数据 ——
 * 万一有问题就污染了用户环境。所以复制一份到 .tmp 里折腾。
 *
 * ## 这个脚本存在的原因（踩过的坑）
 *
 * 原先手工执行 `cp -r dist app/dist`，而 `app/dist` 已经存在时，
 * cp 会把 dist **复制进** dist 里面，得到 `app/dist/dist/assets/...`。
 * 于是 asar 里有两个 dist，应用加载的还是旧的 index.html 指向的旧 CSS ——
 * 表现是「代码改了、重新打包了、界面上完全看不出变化」，
 * 会让人误以为是 CSS 优先级问题，去改一堆 !important（更糟）。
 *
 * 所以这里先 `rm -rf` 目标再复制，并在打包后**校验**：
 * asar 里不能出现嵌套 dist，且 index.html 引用的 css 必须真实存在。
 *
 * 用法：
 *   node scripts/pack-dev-asar.cjs [--out .tmp/apprun]
 *        [--source release/win-unpacked] [--data .tmp/idbcheck/rel]
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT = path.resolve(ROOT, arg('out', '.tmp/apprun'));
const SOURCE = path.resolve(ROOT, arg('source', 'release/win-unpacked'));
const DATA = arg('data', '.tmp/idbcheck/rel');
const STAGE = path.join(ROOT, '.tmp', 'pk-stage');

function run(cmd, args) {
  /*
   * shell: true 是必需的：Windows 上 `npx` 实际是 npx.cmd，
   * execFileSync 直接 spawn 会 ENOENT（不认识 .cmd 后缀）。
   * 参数都是本脚本内部固定的字面量，没有用户输入，拼接安全。
   */
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
}

// ---- 0. 前置检查 ----
if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('没有 dist/index.html，先跑 npx vite build');
  process.exit(2);
}
/*
 * 根 index.html 是 vite 的**源模板**，必须是 `<script src="/src/main.tsx">`。
 *
 * 踩过的坑：手工 `cp -r dist <某处>` 时如果不小心把 dist/index.html
 * 覆盖到了根目录，下一次 `vite build` 会报
 * 「Failed to resolve ./assets/index-xxx.js from index.html」——
 * 因为模板里已经写死了上一个构建产物的哈希文件名。
 * 那时 dist 还是旧的、界面看不出任何变化，很容易误判成 CSS 优先级问题。
 */
const rootIndex = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
if (!rootIndex.includes('/src/main.tsx')) {
  console.error(
    '根 index.html 已被构建产物覆盖（找不到 /src/main.tsx）。\n' +
      '请先执行: git checkout -- index.html',
  );
  process.exit(2);
}

const sourceAsar = path.join(SOURCE, 'resources', 'app.asar');
if (!fs.existsSync(sourceAsar)) {
  console.error(`找不到 ${sourceAsar}`);
  process.exit(2);
}

// ---- 1. 解包模板 ----
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
console.log('解包模板 app.asar…');
run('npx', ['asar', 'extract', sourceAsar, path.join(STAGE, 'app')]);

// ---- 2. 替换 dist（先删再拷，杜绝嵌套）----
const stageDist = path.join(STAGE, 'app', 'dist');
fs.rmSync(stageDist, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'dist'), stageDist, { recursive: true });

if (fs.existsSync(path.join(stageDist, 'dist'))) {
  console.error('打包中止：出现了嵌套的 dist/dist —— 复制方式有问题');
  process.exit(1);
}

// ---- 3. 替换 electron 主进程（改了才需要，但每次都拷也无害）----
const stageElectron = path.join(STAGE, 'app', 'electron');
if (fs.existsSync(stageElectron)) {
  for (const f of fs.readdirSync(path.join(ROOT, 'electron'))) {
    if (f.endsWith('.cjs')) {
      fs.copyFileSync(path.join(ROOT, 'electron', f), path.join(stageElectron, f));
    }
  }
}

// ---- 4. 打包 ----
const outAsar = path.join(STAGE, 'new.asar');
console.log('打包…');
run('npx', ['asar', 'pack', path.join(STAGE, 'app'), outAsar]);

// ---- 5. 校验：嵌套 dist 与 index.html 引用 ----
const listing = run('npx', ['asar', 'list', outAsar]);
const nested = listing.split(/\r?\n/).filter((l) => /\\dist\\dist\\/.test(l));
if (nested.length > 0) {
  console.error(`打包校验失败：asar 内有签名重复的 dist（${nested.length} 条）`);
  process.exit(1);
}

/*
 * 校验 index.html 引用的 css 真的在包里。
 *
 * 这是「界面没变化」最隐蔽的一种成因：index.html 指向 index-XXXX.css，
 * 而包里只有旧名的那个 —— 页面照样能打开（浏览器 404 后无样式），
 * 只是所有自定义样式全丢，看起来像「布局炸了」。
 */
const stageIndex = fs.readFileSync(path.join(stageDist, 'index.html'), 'utf8');
const cssRefs = [...stageIndex.matchAll(/(?:href|src)="\.?\/?(assets\/[^"]+)"/g)].map((m) => m[1]);
for (const ref of cssRefs) {
  const inDist = path.join(stageDist, ref);
  if (!fs.existsSync(inDist)) {
    console.error(`打包校验失败：index.html 引用了不存在的 ${ref}`);
    process.exit(1);
  }
}
console.log(`index.html 引用的 ${cssRefs.length} 个资源都在包里 ✓`);

// ---- 6. 装到目标目录 ----
fs.mkdirSync(OUT, { recursive: true });
if (fs.existsSync(path.join(OUT, 'OpenLeaner.exe'))) {
  // 已有可运行的 app 目录：只换 asar 与数据
  fs.rmSync(path.join(OUT, 'resources', 'app.asar'), { force: true });
  fs.copyFileSync(outAsar, path.join(OUT, 'resources', 'app.asar'));
} else {
  // 新目录：从 source 整份复制（exe、dll、locales 等）
  fs.cpSync(SOURCE, OUT, { recursive: true });
  fs.rmSync(path.join(OUT, 'openleaner-data'), { recursive: true, force: true });
  fs.copyFileSync(outAsar, path.join(OUT, 'resources', 'app.asar'));
}

// 数据副本（每次重建，保证验证从已知状态开始）
if (DATA) {
  const from = path.resolve(ROOT, DATA);
  const to = path.join(OUT, 'openleaner-data');
  if (fs.existsSync(from)) {
    fs.rmSync(to, { recursive: true, force: true });
    /*
     * 逐项复制而不是一次性 cpSync 整个目录。
     *
     * 踩过的坑：源目录如果正被另一个 Electron 实例打开（我在跑探针），
     * 直接 cpSync 会**静默地只拷到一部分** —— 目标目录看起来完整、
     * 文件大小也对，但应用读出来 `questions: 0`。
     * 表现是「同一份数据，探针说有 16 道题，应用说一道都没有」，
     * 极难判断到底是数据问题还是打包问题。
     *
     * 所以：先删干净、逐项拷、再核对每个顶层条目确实落地。
     */
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      if (entry === 'LOCK' || entry.endsWith('-journal')) continue;
      fs.cpSync(path.join(from, entry), path.join(to, entry), { recursive: true });
    }

    /*
     * 清掉 leveldb 的 LOCK。
     *
     * 复制过来的 LOCK 是源进程留下的陈迹；Electron 打开时会认为
     * 「这个库已被占用」而另建一个空库 —— 又是「界面里一道题都没有」。
     */
    const levelDir = path.join(to, 'IndexedDB', 'file__0.indexeddb.leveldb');
    if (fs.existsSync(levelDir)) {
      fs.rmSync(path.join(levelDir, 'LOCK'), { force: true });
    }

    const srcEntries = fs.readdirSync(from).length;
    const dstEntries = fs.readdirSync(to).length;
    if (dstEntries < srcEntries - 2) {
      console.error(`数据复制不完整：源 ${srcEntries} 项，目标 ${dstEntries} 项`);
      process.exit(1);
    }
  }
}

const size = fs.statSync(outAsar).size;
console.log(`\n完成: ${path.relative(ROOT, path.join(OUT, 'resources', 'app.asar'))}`);
console.log(`      ${size.toLocaleString()} 字节`);
console.log(`数据: ${DATA ? path.join(path.relative(ROOT, OUT), 'openleaner-data') : '(沿用原目录)'}`);

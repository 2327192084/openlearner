/**
 * 从 node_modules 复制 tesseract 的离线资源到 public/tesseract/。
 *
 * 为什么需要这个脚本：这些是**二进制资源**，不是代码，没法用 import 引用，
 * 只能作为静态文件随构建产物发布。手抄一次可以，但没人记得住哪几个文件、
 * 哪个变体、为什么要 `.wasm.js` —— 所以固化成脚本。
 *
 * 用法：
 *   node scripts/sync-tesseract-assets.cjs
 *
 * ## 三个容易搞错的点（都真踩过）
 *
 * 1. `.wasm` 和 `.wasm.js` 都要复制。后者是 Emscripten 胶水，worker 用
 *    importScripts 加载它再去取 .wasm。只复制 .wasm 时单元测试全绿，
 *    真浏览器报 `importScripts … failed to load`。
 *
 * 2. 只复制 LSTM 变体。我们创建 worker 时传 oem=1（LSTM_ONLY），
 *    tesseract.js 因此把 lstmOnly 定为 true，getCore.js 只在三个
 *    `-lstm` 变体里按 CPU 特性挑一个，非 lstm 的永远不会被加载。
 *    全复制是 43MB，只复制 lstm 是 20MB，省一半。
 *
 * 3. 语言包用 `4.0.0_best_int`（1.7MB）而不是 `4.0.0`（20MB）。
 *    实测两者识别质量相同（置信度 93 vs 94），best_int 反而更快
 *    （1.4s vs 2.1s/页），因为它是 int 量化版。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'tesseract');

/** getCore.js 可能选择的三个变体，按 CPU 支持程度排 */
const LSTM_VARIANTS = [
  'tesseract-core-lstm',
  'tesseract-core-simd-lstm',
  'tesseract-core-relaxedsimd-lstm',
];

function copy(sources, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const src of sources) {
    if (!fs.existsSync(src)) {
      console.error(`缺少文件：${src}`);
      console.error('请先 npm install，确认 tesseract.js 与 tesseract.js-core 已安装。');
      process.exit(1);
    }
    fs.copyFileSync(src, path.join(destDir, path.basename(src)));
  }
}

function main() {
  const tess = path.join(ROOT, 'node_modules', 'tesseract.js');
  const core = path.join(ROOT, 'node_modules', 'tesseract.js-core');
  const lang = path.join(
    ROOT,
    'node_modules',
    '@tesseract.js-data',
    'chi_sim',
    '4.0.0_best_int',
    'chi_sim.traineddata.gz',
  );

  if (!fs.existsSync(lang)) {
    console.error(`缺少中文语言包：${lang}`);
    console.error('请先安装：npm install --save-dev @tesseract.js-data/chi_sim');
    process.exit(1);
  }

  // 1. worker
  copy([path.join(tess, 'dist', 'worker.min.js')], OUT);

  // 2. wasm 核心：.wasm 与 .wasm.js 成对复制，只要 LSTM 变体
  const coreFiles = [];
  for (const v of LSTM_VARIANTS) {
    coreFiles.push(path.join(core, `${v}.wasm`));
    coreFiles.push(path.join(core, `${v}.wasm.js`));
  }
  copy(coreFiles, path.join(OUT, 'core'));

  // 3. 语言包
  copy([lang], path.join(OUT, 'lang'));

  const total = coreFiles.reduce((n, f) => n + fs.statSync(f).size, 0) + fs.statSync(lang).size;
  console.log(`已同步到 public/tesseract/`);
  console.log(`  worker: 1 个`);
  console.log(`  core:   ${coreFiles.length} 个（${LSTM_VARIANTS.length} 个变体 × wasm+胶水）`);
  console.log(`  语言包: chi_sim 4.0.0_best_int`);
  console.log(`  合计约 ${(total / 1024 / 1024).toFixed(1)} MB`);
}

main();

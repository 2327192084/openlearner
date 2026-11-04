/**
 * 验证打包产物里到底是哪个版本的代码。
 *
 * 起因：用户截图里出现「暂不可用，P5 接入」这句已被删除的文案，
 * 说明他运行的是旧打包版本。只看文件时间戳不够可靠，
 * 这里直接从 asar 里把 JS 抽出来，检查关键代码特征在不在。
 */

const asar = require('@electron/asar');
const path = require('node:path');

const asarPath = path.join(__dirname, '..', 'release', 'win-unpacked', 'resources', 'app.asar');

const entries = asar.listPackage(asarPath);
const mainJs = entries.find((f) => /assets[\\/]index-.*\.js$/.test(f) && !/pdf/.test(f));

if (!mainJs) {
  console.error('找不到主 bundle');
  process.exit(1);
}

// listPackage 返回的路径带前导分隔符，extractFile 需要相对路径
const rel = mainJs.replace(/^[\\/]+/, '');
const js = asar.extractFile(asarPath, rel).toString('utf8');

console.log(`主 bundle: ${rel}`);
console.log(`大小: ${(js.length / 1024 / 1024).toFixed(2)} MB\n`);

const checks = [
  ['P5 真实调用（chat/completions）', 'chat/completions', 'want'],
  ['P5 测试连接按钮', '测试连接', 'want'],
  ['新徽标（示例后端·非 AI）', '示例后端·非 AI', 'want'],
  ['cMap 配置（cmaps/）', 'cmaps/', 'want'],
  ['扫描件路线①（本地文字识别）', '本地文字识别', 'want'],
  ['扫描件路线②（看图模型）', '看图模型', 'want'],
  ['旧占位文案（应已删除）', '暂不可用，P5 接入', 'avoid'],
  ['旧占位文案变体（应已删除）', 'P5 接入', 'avoid'],
];

let bad = 0;
for (const [label, kw, kind] of checks) {
  const n = js.split(kw).length - 1;
  const ok = kind === 'want' ? n > 0 : n === 0;
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${n} 处`);
}

// cMap 资源是否也在包里
const cmapCount = entries.filter((f) => /cmaps[\\/].*\.bcmap$/.test(f)).length;
console.log(`\ncMap 文件在 asar 里: ${cmapCount} 个 ${cmapCount > 100 ? 'PASS' : 'FAIL'}`);
if (cmapCount <= 100) bad += 1;

console.log(`\n结论: ${bad === 0 ? '这个包是包含 P5 的新版本' : `有 ${bad} 项不符，包是旧的或构建不完整`}`);
process.exit(bad === 0 ? 0 : 1);

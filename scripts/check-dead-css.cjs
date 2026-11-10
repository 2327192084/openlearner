/**
 * 找出「CSS 里定义了、但没有任何组件在用」的类名（2026-11-10）。
 *
 * ## 为什么这能抓到真 bug
 *
 * today-page.css 里写了一整套 `.stat__value / .stat__unit / .stat__label`，
 * 而 TodayPage 的 Stat 组件渲染的是 `today__stat-value` 等 ——
 * 字面量差一截，规则从未生效。界面上表现为「数字没放大、单位粘在一起」，
 * 看着像设计不够精细，其实是漏了。
 *
 * 这类 bug 不会报错、单测也测不到（组件渲染出来是对的，
 * 只是没被样式命中），只能靠比对「CSS 里的选择器」与
 * 「tsx 里出现过的类名」发现。
 *
 * ## 判定口径
 *
 * 只统计形如 `.prefix__elem` / `.prefix-elem` 的 BEM 类名，
 * 忽略状态修饰（`--on` / `:hover` 等）与纯工具类。
 * 另外排除动态拼接的（`${...}`）否则会误报一片。
 *
 * 用法：node scripts/check-dead-css.cjs [--all]
 *   --all 连只出现一次的也列出来（默认只看出现 >=2 处的，降噪）
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ALL = process.argv.includes('--all');

function collect(dir, exts, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      collect(p, exts, out);
    } else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) {
      out.push(p);
    }
  }
  return out;
}

const cssFiles = collect(path.join(ROOT, 'src'), ['.css']);
const codeFiles = collect(path.join(ROOT, 'src'), ['.tsx', '.ts']).filter(
  (f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'),
);

/** CSS 里声明的类名 → 出现次数与来源 */
const declared = new Map();
for (const f of cssFiles) {
  const txt = fs.readFileSync(f, 'utf8');
  /* 去掉注释，避免注释里提到的类名被当成声明 */
  const clean = txt.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) {
    const name = m[1];
    /* 只看 BEM 形态，避免 .btn / .row 这类通用名满屏误报 */
    if (!/[_-]/.test(name)) continue;
    /* 去掉状态修饰后缀 */
    const base = name.replace(/--[a-z0-9-]+$/, '');
    if (!base) continue;
    const rec = declared.get(base) ?? { count: 0, files: new Set() };
    rec.count++;
    rec.files.add(path.relative(ROOT, f));
    declared.set(base, rec);
  }
}

/** 代码里出现过的类名（字符串字面量 + 模板字符串片段） */
const usedText = codeFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const isUsed = (name) => {
  /* 直接出现即算用过；className 里常是 "a b" 或模板拼接，包含即可 */
  return usedText.includes(name);
};

const threshold = ALL ? 1 : 2;
const dead = [];
for (const [name, rec] of declared) {
  if (rec.count < threshold) continue;
  if (!isUsed(name)) dead.push({ name, ...rec, files: [...rec.files] });
}

dead.sort((a, b) => b.count - a.count);

console.log(`CSS 声明 ${declared.size} 个 BEM 类名，代码文件 ${codeFiles.length} 个\n`);

if (dead.length === 0) {
  console.log('✅ 没有「声明了但没人用」的类名');
  process.exit(0);
}

console.log(`⚠️  ${dead.length} 个类名在 CSS 里声明了，但代码里找不到任何引用：\n`);
for (const d of dead.slice(0, 60)) {
  console.log(`  .${d.name}   (${d.count} 处)  ${d.files[0]}`);
}
if (dead.length > 60) console.log(`  … 还有 ${dead.length - 60} 个`);

console.log(
  '\n注意：这一类里有些是**正常**的（v1 遗留样式、被 JS 动态拼接的名字、' +
    '或只在媒体查询里用的），要逐个看文件判断。\n' +
    '但「组件明明渲染了这个类名、CSS 却写成另一个名字」必然出现在这个列表里。',
);

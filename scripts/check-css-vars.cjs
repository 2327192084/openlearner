/**
 * 扫描 CSS 里引用但不存在的变量（2026-11-10）。
 *
 * ## 为什么这是个真问题而不是吹毛求疵
 *
 * `var(--fs-md)` 写错成 `--font-md` 时，CSS **不报错、不回退到默认值**，
 * 而是让整条声明失效（invalid at computed-value time）。
 * 表现是「字号没变」，看起来像「设计就是这样」——
 * 但其实是漏了。项目里已经有一处：`today-dashboard.css` 用了
 * `var(--font-md / --font-sm)`，而 tokens 里定义的是 `--fs-md / --fs-sm`。
 *
 * ## 怎么判「存在」
 *
 * 变量可能在 :root 之外的 `.app[data-theme]` 里定义（本项目就是），
 * 所以不能只看 :root —— 扫所有 CSS 文件里的 `--xxx:` 定义即为全集。
 *
 * 用法：node scripts/check-css-vars.cjs
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = [path.join(ROOT, 'src')];

/** 递归收集 .css 文件 */
function collect(dir, out = []) {
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
      collect(p, out);
    } else if (e.isFile() && e.name.endsWith('.css')) {
      out.push(p);
    }
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => collect(d));
console.log(`扫描 ${files.length} 个 CSS 文件\n`);

/** 已定义的变量名集合 */
const defined = new Set();
/** 每处定义在哪（排查用） */
const definedAt = new Map();

for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  /* 定义形如 `--name:`（允许前面有空白） */
  for (const m of txt.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) {
    defined.add(m[1]);
    if (!definedAt.has(m[1])) definedAt.set(m[1], path.relative(ROOT, f));
  }
}

/** 收集使用处 */
const problems = [];
let totalUses = 0;

for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  const lines = txt.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
      totalUses++;
      const name = m[1];
      if (!defined.has(name)) {
        problems.push({
          file: path.relative(ROOT, f),
          line: i + 1,
          name,
          /* 有 fallback 就只是保险，不写 fallback 才是真失效 */
          hasFallback: /var\(\s*--[a-zA-Z0-9-]+\s*,/.test(line),
          snippet: line.trim().slice(0, 100),
        });
      }
    }
  });
}

console.log(`共 ${totalUses} 处 var() 引用，${defined.size} 个变量已定义\n`);

if (problems.length === 0) {
  console.log('✅ 没有引用不存在的变量');
  process.exit(0);
}

/* 无 fallback 的才是真问题：那条声明会整条失效 */
const hard = problems.filter((p) => !p.hasFallback);
const soft = problems.filter((p) => p.hasFallback);

if (hard.length > 0) {
  console.log(`❌ ${hard.length} 处引用了不存在的变量（无 fallback，声明会整条失效）：\n`);
  for (const p of hard) {
    console.log(`  ${p.file}:${p.line}  ${p.name}`);
    console.log(`    ${p.snippet}`);
  }
}

if (soft.length > 0) {
  console.log(`\n⚠️  ${soft.length} 处引用了不存在的变量，但有 fallback（不会坏，但可能是拼错）：\n`);
  for (const p of soft) {
    console.log(`  ${p.file}:${p.line}  ${p.name}   ${p.snippet}`);
  }
}

/* 猜一下是不是拼写错误：有相近的已定义变量就提示 */
const near = (name) => {
  const body = name.replace(/^--/, '');
  const cands = [...defined].filter((d) => {
    const b = d.replace(/^--/, '');
    /* 同后缀（fs-md vs font-md 的共同后缀是 -md）或编辑距离很小 */
    return b.endsWith(body.slice(body.lastIndexOf('-'))) && Math.abs(b.length - body.length) < 8;
  });
  return cands.slice(0, 3);
};

const hinted = [...hard, ...soft];
if (hinted.length > 0) {
  console.log('\n可能的正确写法：');
  const seen = new Set();
  for (const p of hinted) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    const c = near(p.name);
    if (c.length) console.log(`  ${p.name} → ${c.join(' 或 ')}`);
  }
}

process.exit(hard.length > 0 ? 1 : 0);

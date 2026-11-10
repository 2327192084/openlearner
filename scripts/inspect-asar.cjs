/**
 * 看 asar 里到底装了什么、各部分占多少（2026-11-10）。
 *
 * 为什么需要：打包产物 119MB，而 dist 只有 31MB。差的 88MB 需要解释清楚 ——
 * 用户明确要求「只提供软件本体，插件/模型走软件内下载」，
 * 所以必须先知道包里有哪些东西，才能判断哪些不该在。
 *
 * 用法：node scripts/inspect-asar.cjs [--asar release/win-unpacked/resources/app.asar]
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ASAR = path.resolve(ROOT, arg('asar', 'release/win-unpacked/resources/app.asar'));

if (!fs.existsSync(ASAR)) {
  console.error(`找不到 ${ASAR}`);
  process.exit(2);
}

/* asar list 只给路径，不给大小；用 extract 到临时目录再量 */
const TMP = path.join(ROOT, '.tmp', 'asar-inspect');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

console.log(`解包 ${path.relative(ROOT, ASAR)} …`);
execFileSync('npx', ['asar', 'extract', ASAR, TMP], {
  cwd: ROOT,
  stdio: 'ignore',
  shell: true,
});

/** 递归量目录体积 */
function dirSize(dir) {
  let total = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size;
          files++;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { total, files };
}

const fmt = (n) => {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
};

const whole = dirSize(TMP);
console.log(`\n总解包体积: ${fmt(whole.total)}  文件 ${whole.files} 个\n`);

/* 按顶层目录分组 */
const tops = fs
  .readdirSync(TMP, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => {
    const s = dirSize(path.join(TMP, e.name));
    return { name: e.name, ...s };
  })
  .sort((a, b) => b.total - a.total);

console.log('顶层目录占比:');
for (const t of tops) {
  const pct = ((t.total / whole.total) * 100).toFixed(1);
  console.log(`  ${t.name.padEnd(16)} ${fmt(t.total).padStart(10)}  ${pct.toString().padStart(5)}%  ${t.files} 文件`);
}

/* node_modules 里最占地方的包 */
const nm = path.join(TMP, 'node_modules');
if (fs.existsSync(nm)) {
  console.log('\nnode_modules 里最大的 15 个包:');
  const pkgs = fs
    .readdirSync(nm, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const s = dirSize(path.join(nm, e.name));
      return { name: e.name, ...s };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 15);
  for (const p of pkgs) {
    console.log(`  ${p.name.padEnd(34)} ${fmt(p.total).padStart(10)}`);
  }
}

/* dist 里最大的文件 */
const dist = path.join(TMP, 'dist');
if (fs.existsSync(dist)) {
  console.log('\ndist 里最大的 12 个文件:');
  const all = [];
  const stack = [dist];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          all.push({ p: path.relative(dist, p), size: fs.statSync(p).size });
        } catch {
          /* ignore */
        }
      }
    }
  }
  all.sort((a, b) => b.size - a.size);
  for (const f of all.slice(0, 12)) {
    console.log(`  ${fmt(f.size).padStart(10)}  dist/${f.p.replace(/\\/g, '/')}`);
  }
}

fs.rmSync(TMP, { recursive: true, force: true });

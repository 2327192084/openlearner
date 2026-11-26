#!/usr/bin/env node
/**
 * 版本号一致性检查（2026-11-26）。
 *
 * ## 为什么需要
 *
 * 版本号散在三处，都是人手改的：
 *   1. `package.json` 的 `version` —— electron-builder 拿它写 exe 资源版本、决定产物名
 *   2. `build/installer.iss` 的 `#define VERSION` —— 安装包显示版本
 *   3. `README.md` 首屏的「当前版本 X.Y.Z」与下载链接 —— 用户看到的就是它
 *
 * 2026-11-24 那次发版就是这样漏的：tag `v0.40` 打在 a8dbb2b（package.json 还是 `4.0.0`），
 * 版本号到下一个提交 f002e97 才落地，于是「标签上的版本」和「代码里的版本」对不上。
 * 事后靠人工发现、再挪 tag —— 这类事让机器查，一眼就能看出来。
 *
 * ## 用法
 *
 *   node scripts/check-version.cjs          # 打印三处版本，不一致就 exit 1
 *   node scripts/check-version.cjs 0.40.1   # 额外要求它们都等于这个值（发版脚本用）
 *
 * `scripts/build-innosetup.cjs` 在打包前会调它，所以版本不一致的包根本打不出来。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** 从三处读出「声称的版本」，缺一处就记成 null */
function readVersions() {
  const out = {};

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  out.packageJson = typeof pkg.version === 'string' ? pkg.version : null;

  const iss = fs.readFileSync(path.join(ROOT, 'build', 'installer.iss'), 'utf8');
  const mIss = iss.match(/^\s*#define\s+VERSION\s+"([^"]+)"/m);
  out.installerIss = mIss ? mIss[1] : null;

  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const mCurrent = readme.match(/\*\*当前版本\s+([0-9]+\.[0-9]+\.[0-9]+)\*\*/);
  out.readmeCurrent = mCurrent ? mCurrent[1] : null;

  // 下载链接里的 tag 与文件名（版本号提升后没回填链接的话，用户点过去还是旧包）
  const mLink = readme.match(/\/releases\/download\/v([0-9.]+)\/OpenLeaner-([0-9.]+)-setup\.exe/);
  out.readmeLink = mLink ? { tag: `v${mLink[1]}`, file: mLink[2] } : null;

  return out;
}

function main() {
  const expected = process.argv[2] || null;
  const v = readVersions();
  const problems = [];

  const label = {
    packageJson: 'package.json',
    installerIss: 'build/installer.iss',
    readmeCurrent: 'README.md（当前版本）',
  };

  console.log('版本号三处对照：\n');
  for (const key of Object.keys(label)) {
    const val = v[key];
    console.log(`  ${label[key].padEnd(24)} ${val === null ? '（没找到）' : val}`);
  }
  if (v.readmeLink) {
    console.log(`  README 下载链接            ${v.readmeLink.tag} / ${v.readmeLink.file}`);
  } else {
    console.log('  README 下载链接            （没找到）');
  }

  for (const key of Object.keys(label)) {
    if (!v[key]) problems.push(`${label[key]} 里没找到版本号`);
  }

  const set = new Set([v.packageJson, v.installerIss, v.readmeCurrent].filter(Boolean));
  if (set.size > 1) {
    problems.push(`三处版本号不一致：${[...set].join(' / ')}`);
  }
  if (expected && set.size && !set.has(expected)) {
    problems.push(`与期望的 ${expected} 不符`);
  }
  if (v.readmeLink && v.packageJson && v.readmeLink.file !== v.packageJson) {
    problems.push(
      `README 下载链接指向 ${v.readmeLink.file}，但当前版本是 ${v.packageJson}` +
        '（发版后要回填链接；还没发这个版本的包时可以先留着旧的，发完再改）',
    );
  }

  if (problems.length) {
    console.log('');
    for (const p of problems) console.log(`  ❌ ${p}`);
    process.exit(1);
  }
  console.log('\n  ✅ 一致');
}

main();

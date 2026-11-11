/**
 * 命令行入口：在普通 node 进程里跑 MinerU 安装 / 卸载引擎。
 *
 * ## 为什么需要这个入口
 *
 * 交接文档记过：本会话的 Electron 子进程对 AppData 写入有 EPERM 限制，
 * 而**普通 node 进程正常**。如果把安装逻辑只做成界面按钮，
 * 就会出现「按钮点了没反应」且我没法在本会话验证。
 *
 * 所以核心逻辑放在 `electron/mineru-install.cjs`（纯 node），
 * 这个脚本是它的命令行外壳 —— 界面和它调用的是同一份代码。
 *
 * ## 用法
 *
 *   # 看有哪些盘、各自剩多少
 *   node scripts/install-mineru.cjs --drives
 *
 *   # 看某个目录下的安装计划（哪些步骤已完成 = 断点续的依据）
 *   node scripts/install-mineru.cjs --plan --root D:\OpenLeaner\mineru
 *
 *   # 真装（会下载约 2.7GB）
 *   node scripts/install-mineru.cjs --install --root D:\OpenLeaner\mineru
 *
 *   # 只装到「程序能跑」，模型那 2GB 先跳过（快速验证链路）
 *   node scripts/install-mineru.cjs --install --skip-models --root .tmp\mt
 *
 *   # 卸载（有安全检查，不像 MinerU 的目录会被拒绝）
 *   node scripts/install-mineru.cjs --uninstall --root D:\OpenLeaner\mineru
 */

'use strict';

const path = require('node:path');
const engine = require('../electron/mineru-install.cjs');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) return true;
  return v;
}
const has = (name) => process.argv.includes(`--${name}`);

const fmt = (b) => `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;

(async () => {
  /* ---- 磁盘 ---- */
  if (has('drives')) {
    const drives = engine.listDrives();
    console.log('可用磁盘（装 MinerU 需要约 3 GB）：\n');
    for (const d of drives) {
      const mark = d.enough ? '  ✅ 可选' : '  ⛔ 空间不足（界面会置灰）';
      console.log(
        `${d.letter}:  剩余 ${fmt(d.freeBytes).padStart(9)} / 共 ${fmt(d.totalBytes)}${mark}`,
      );
    }
    return;
  }

  const root = arg('root', null);

  /* ---- 计划 ---- */
  if (has('plan')) {
    if (!root) { console.error('需要 --root <目录>'); process.exit(2); }
    console.log(`安装目录: ${root}\n`);
    const free = engine.freeBytesAt(path.dirname(path.resolve(root)));
    if (free !== null) console.log(`所在磁盘剩余: ${fmt(free)}\n`);
    for (const s of engine.planSteps(root)) {
      const done = s.done();
      console.log(`${done ? '✅' : '⬜'} ${s.title}  （${s.detail}）`);
    }
    return;
  }

  /* ---- 卸载 ---- */
  if (has('uninstall')) {
    if (!root) { console.error('需要 --root <目录>'); process.exit(2); }
    console.log(`卸载: ${root}`);
    const r = await engine.uninstall({ root });
    if (!r.ok) {
      console.error(`\n❌ ${r.error}`);
      if (r.hint) console.error(`   ${r.hint}`);
      process.exit(1);
    }
    console.log(`\n✅ 已删除 ${r.removed.length} 项`);
    for (const p of r.removed) console.log(`   ${p}`);
    return;
  }

  /* ---- 安装 ---- */
  if (has('install')) {
    if (!root) { console.error('需要 --root <目录>'); process.exit(2); }
    const abs = path.resolve(root);
    console.log(`安装到: ${abs}`);

    const free = engine.freeBytesAt(path.dirname(abs));
    if (free !== null) console.log(`磁盘剩余: ${fmt(free)}`);
    console.log('');

    const skipModels = has('skip-models');
    const started = Date.now();
    let lastStep = '';

    const r = await engine.install({
      root: abs,
      onStep: ({ id, state, error }) => {
        if (state === 'running') {
          lastStep = id;
          process.stdout.write(`\n[${id}] …\n`);
        } else if (state === 'done') {
          console.log(`[${id}] ✅ 完成`);
        } else if (state === 'failed') {
          console.log(`[${id}] ❌ 失败${error ? `: ${String(error).slice(-300)}` : ''}`);
        }
      },
      onLine: (line) => {
        /* 只打印有信息量的行，避免刷屏 */
        const t = line.trim();
        if (!t) return;
        if (/error|failed|失败|Traceback|No such|denied/i.test(t)) {
          console.log(`    ⚠ ${t.slice(0, 200)}`);
        } else if (/Downloading|Installing|Resolved|Prepared|Building|%"|已下载|download/i.test(t)) {
          console.log(`    ${t.slice(0, 160)}`);
        }
      },
      onProgress: ({ downloaded, total }) => {
        const mb = (downloaded / 1048576).toFixed(1);
        if (total) {
          const pct = ((downloaded / total) * 100).toFixed(0);
          const tmb = (total / 1048576).toFixed(0);
          process.stdout.write(`\r    ${mb}/${tmb} MB (${pct}%)   `);
        } else {
          process.stdout.write(`\r    ${mb} MB   `);
        }
      },
    });

    const secs = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`\n\n用时 ${secs} 秒`);
    if (!r.ok) {
      console.error(`\n❌ 失败于步骤「${r.failedStep}」`);
      console.error(`   ${r.error}`);
      if (r.hint) console.error(`   ${r.hint}`);
      process.exit(1);
    }

    console.log(`\n✅ 安装完成`);
    if (r.reused) {
      console.log(`\nℹ️  这台机器上已经有 MinerU 了，没有重复安装：`);
      console.log(`   ${r.message}`);
    }
    console.log(`   mineru: ${r.exePath}`);
    console.log(`   home:   ${r.home ?? '（未找到 config.yaml）'}`);

    if (skipModels) console.log('\n（本次跳过了模型下载）');
    return;
  }

  console.log(`MinerU 安装引擎命令行

  node scripts/install-mineru.cjs --drives
  node scripts/install-mineru.cjs --plan      --root <目录>
  node scripts/install-mineru.cjs --install   --root <目录> [--skip-models]
  node scripts/install-mineru.cjs --uninstall --root <目录>
`);
})().catch((e) => {
  console.error('崩了:', e && e.message);
  process.exit(1);
});

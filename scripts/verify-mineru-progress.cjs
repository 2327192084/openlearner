/**
 * 验证「MinerU 转换有进度」+「转换结果是 Markdown」。
 *
 * 用户第三点要求：转换时看不到进度，无法确定到哪一步。
 *
 * 这里跑一次真实转换，记录**实际收到的所有进度事件**，
 * 并检查结果里正文是否保留 Markdown 标题标记。
 */
const m = require('../electron/mineru.cjs');
const path = require('node:path');
const fs = require('node:fs');

(async () => {
  const d = m.detectMineru({});
  if (!d.available) {
    console.log('本机没有 MinerU，跳过');
    return;
  }

  const outDir = path.resolve('.tmp/md-progress');
  fs.rmSync(outDir, { recursive: true, force: true });

  const pdf = path.resolve('src/test/fixtures/large-50p.pdf');
  const events = [];
  const t0 = Date.now();

  console.log('转换 50 页 PDF（standard 档），记录真实进度…\n');
  const r = await m.runMineru(
    { filePath: pdf, outDir, tier: 'standard' },
    {
      exePath: d.exePath,
      onProgress: (p) => {
        events.push(p);
        const sec = String(Math.round((Date.now() - t0) / 1000)).padStart(3);
        const pct = p.ratio !== null ? ` ${Math.round(p.ratio * 100)}%` : '';
        console.log(`[${sec}s] ${p.phase}${p.detail ? ' · ' + p.detail : ''}${pct}`);
      },
    },
  );

  console.log('\n=== 结果 ===');
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };

  check('转换成功', r.ok === true, r.ok ? '' : r.message.slice(0, 200));
  check('收到了多个进度事件（不是只有一个「进行中」）', events.length >= 3, `${events.length} 个`);

  const withRatio = events.filter((e) => e.ratio !== null);
  check('有带真实百分比的进度', withRatio.length >= 2, `${withRatio.length} 个带百分比`);

  const withDetail = events.filter((e) => e.detail);
  check('进度里有 x/y 或剩余时间', withDetail.length >= 2, withDetail[0]?.detail ?? '');

  const phases = new Set(events.map((e) => e.phase));
  check('进度里有阶段名（能看出在做什么）', phases.size >= 1, [...phases].join(' → '));

  /*
   * 同一阶段内进度必须递增（不回头）。
   * 跨阶段重置是正常的：版面分析 100% → 文字检测 0% 是两条独立的进度条。
   */
  let monotonic = true;
  const lastByStage = new Map();
  for (const e of withRatio) {
    const stage = e.stage ?? e.phase;
    const prev = lastByStage.get(stage);
    if (prev !== undefined && e.ratio < prev - 0.01) monotonic = false;
    lastByStage.set(stage, e.ratio);
  }
  check('同一阶段内进度递增（不回头）', monotonic, `阶段: ${[...lastByStage.keys()].join(', ')}`);

  if (r.ok) {
    const md = r.result.markdown;
    check('输出是 Markdown 且有分页标记', /<!--\s*page\s+\d+\s+of\s+\d+\s*-->/.test(md), '');
    check('正文里保留了 Markdown 标题（#）', /^#{1,6}\s+\S/m.test(md), '');
    check('内容包含真实中文', /[\u4e00-\u9fa5]{4,}/.test(md), '');
  }

  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  const passed = results.filter((x) => x.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (passed !== results.length) process.exitCode = 1;
})();

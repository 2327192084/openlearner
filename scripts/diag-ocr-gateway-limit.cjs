/**
 * 测出 DeepSeek 前置 openresty 网关的请求体上限（2026-11-16）。
 *
 * ## 为什么这件事决定了「云端 OCR 能不能实现」
 *
 * 已确认（上一轮实测）：
 *  - 1 KiB → HTTP 401 JSON（链路通，认证在大小检查之前）
 *  - 55.07 MiB → HTTP 413 HTML + `server: openresty`
 *
 * 官方文档写的是应用层 100 MiB，但网关那道门更低。
 * **只要知道这道门在多少 MiB，就知道「一次能传多大」，也就能定分片大小。**
 *
 * ## 为什么上一轮没测准
 *
 * 上一轮单次探测，8/32/40/48 MiB 都是 ECONNRESET，16/24 是 HTTP 550 ——
 * 服务端当时不稳定。这次每个体积**重试 4 次**，取出现过的状态集合，
 * 并且按「401 = 过了网关」「413 = 被网关拒」来判读。
 *
 * ## 费用
 *
 * 全部用假 Key，必然被拒，不产生识别、不计费。
 *
 * 用法：
 *   node scripts/diag-ocr-gateway-limit.cjs [--max 48] [--min 1]
 */

const URL_OCR = 'https://api.deepseek.com/v1/tools/ocr';
const FAKE_KEY = 'sk-000000000000000000000000000000000000000000000000';

function arg(n, d) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
}

/** 造一个体积精确的假 PDF（服务端按内容判格式，但假 Key 会先被拒，格式无所谓） */
function fakePdf(size) {
  const head = Buffer.from('%PDF-1.4\n', 'latin1');
  const tail = Buffer.from('\n%%EOF\n', 'latin1');
  const body = Buffer.alloc(Math.max(0, size - head.length - tail.length), 0x20);
  return Buffer.concat([head, body, tail]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function once(bytes) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), 'probe.pdf');
  form.append('purpose', 'rich_layout_recognition');

  const t0 = Date.now();
  try {
    const res = await fetch(URL_OCR, {
      method: 'POST',
      headers: { Authorization: `Bearer ${FAKE_KEY}` },
      body: form,
    });
    const text = await res.text();
    return {
      status: res.status,
      openresty: text.indexOf('openresty') >= 0,
      ms: Date.now() - t0,
      snippet: text.replace(/\s+/g, ' ').slice(0, 80),
    };
  } catch (e) {
    return { status: 'ERR', code: e.cause?.code ?? e.message, ms: Date.now() - t0 };
  }
}

(async () => {
  const minMiB = Number(arg('min', '1'));
  const maxMiB = Number(arg('max', '48'));
  const ATTEMPTS = 4;

  console.log(`目标: ${URL_OCR}`);
  console.log('凭据: 假 Key（必然被拒，不计费）');
  console.log(`每个体积试 ${ATTEMPTS} 次\n`);
  console.log('体积      状态（4 次）                              判读');

  const sizes = [];
  for (let m = minMiB; m <= maxMiB; m *= 2) sizes.push(m);
  if (sizes[sizes.length - 1] !== maxMiB) sizes.push(maxMiB);

  const verdicts = [];
  for (const mib of sizes) {
    const bytes = fakePdf(Math.round(mib * 1024 * 1024));
    const seen = [];
    for (let i = 0; i < ATTEMPTS; i++) {
      const r = await once(bytes);
      const tag =
        r.status === 'ERR' ? `ERR(${r.code})` : `${r.status}${r.openresty ? '/or' : ''}`;
      seen.push(tag);
      await sleep(300);
    }
    const statuses = [...new Set(seen)];
    /*
     * 判读规则：
     *  - 出现 401 → 网关**放行**了（请求到达应用层）
     *  - 出现 413 → 网关**拒了**
     *  - 只有 ERR → 网络问题，这次不采信
     */
    let verdict = '不确定（全是网络错误）';
    if (statuses.some((s) => s.startsWith('401'))) verdict = '✅ 网关放行';
    else if (statuses.some((s) => s.startsWith('413'))) verdict = '❌ 网关拒绝';
    verdicts.push({ mib, verdict, statuses });
    console.log(
      `${String(mib).padStart(4)} MiB  ${seen.join(' ').padEnd(42)}  ${verdict}`,
    );
  }

  const okMax = Math.max(0, ...verdicts.filter((v) => v.verdict.startsWith('✅')).map((v) => v.mib));
  const badMin = Math.min(
    Infinity,
    ...verdicts.filter((v) => v.verdict.startsWith('❌')).map((v) => v.mib),
  );
  console.log(`\n结论：${okMax || '?'} MiB 能过，${Number.isFinite(badMin) ? badMin + ' MiB 被拒' : '未被拒'}`);
  if (okMax && Number.isFinite(badMin)) {
    console.log(`→ 分片大小应取 ${okMax} MiB 以下（建议留余量）`);
  }
})();
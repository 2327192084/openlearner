/**
 * 用 Node 的 fetch 复测网关上限（2026-11-16 第二次）。
 *
 * ## 为什么重测
 *
 * 上一轮（几小时前）Node fetch 的结果：1 KiB → 401，55.07 MiB → 413。
 * 刚才再测：1~32 MiB 全部 ECONNRESET。
 *
 * 而 curl 那边同时发现：**连 1 MiB 都在发出 ~220KB 后被 RST**，
 * 且 verbose 日志里 TLS 在反复 renegotiating —— 那是 schannel
 * （Windows 的 TLS 栈）与这门网关的兼容问题，**不是体积限制**。
 *
 * Node 用自己的 TLS（OpenSSL），不走 schannel，所以表现可能不同。
 * 这个脚本把「体积 → 状态」重新量一遍，**每次之间隔久一点**，
 * 避免被服务端的并发/限流干扰。
 *
 * 全部用假 Key，不计费。
 */

const URL_OCR = 'https://api.deepseek.com/v1/tools/ocr';
const FAKE_KEY = 'sk-000000000000000000000000000000000000000000000000';

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
      or: text.indexOf('openresty') >= 0,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { status: 'ERR', code: e.cause?.code ?? e.message, ms: Date.now() - t0 };
  }
}

(async () => {
  console.log(`目标: ${URL_OCR}`);
  console.log('凭据: 假 Key（不计费）');
  console.log('每次之间停 3 秒，避免限流干扰\n');
  console.log('体积       结果');

  for (const mib of [0.001, 1, 5, 10, 20, 30, 45, 55]) {
    const bytes = fakePdf(Math.max(64, Math.round(mib * 1024 * 1024)));
    const r = await once(bytes);
    const label = `${(bytes.length / 1048576).toFixed(2)} MiB`.padEnd(10);
    if (r.status === 'ERR') {
      console.log(`${label} ERR ${r.code}  (${r.ms}ms)`);
    } else {
      const kind = r.status === 401 ? '应用层（认证）' : r.or ? 'openresty 网关' : '其它';
      console.log(`${label} HTTP ${r.status}  ${kind}  (${r.ms}ms)`);
    }
    await sleep(3000);
  }
})();
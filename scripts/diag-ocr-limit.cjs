/**
 * 二分定位 openresty 网关的请求体上限（2026-11-16）。
 *
 * ## 已确认的事实
 *
 *  - 1 KiB  → HTTP 401（认证先执行，正常）
 *  - 55 MiB → HTTP 413，且响应体是 `openresty` 的 HTML 错误页
 *  - 101 MiB → 连接直接失败
 *
 * 413 来自 **openresty（Nginx）网关**，不是 DeepSeek 应用层的
 * 「文件超过 100 MiB」检查 —— 应用层的那个会返回 JSON 错误体。
 * 所以用户看到的「文件超过 100 MiB」是程序**自己编的**，服务端
 * 从没这么说过。
 *
 * ## 这个脚本做什么
 *
 * 用二分找出网关开始返回 413 的临界体积。只发假 Key 的请求，
 * 不产生识别、不计费。
 *
 * 用法：
 *   node scripts/diag-ocr-limit.cjs
 */

const URL_OCR = 'https://api.deepseek.com/v1/tools/ocr';
const FAKE_KEY = 'sk-000000000000000000000000000000000000000000000000';

function fakePdf(size) {
  const head = Buffer.from('%PDF-1.4\n', 'latin1');
  const tail = Buffer.from('\n%%EOF\n', 'latin1');
  const body = Buffer.alloc(Math.max(0, size - head.length - tail.length), 0x20);
  return Buffer.concat([head, body, tail]);
}

/** 返回状态码；网络层失败返回字符串 */
async function probeMiB(mib) {
  const bytes = fakePdf(Math.round(mib * 1024 * 1024));
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), 'p.pdf');
  form.append('purpose', 'rich_layout_recognition');
  try {
    const res = await fetch(URL_OCR, {
      method: 'POST',
      headers: { Authorization: `Bearer ${FAKE_KEY}` },
      body: form,
    });
    const text = await res.text();
    const isOpenresty = text.indexOf('openresty') >= 0;
    return { status: res.status, openresty: isOpenresty, len: bytes.length };
  } catch (e) {
    return { status: 'neterr', msg: e.message, len: bytes.length };
  }
}

(async () => {
  console.log(`目标: ${URL_OCR}`);
  console.log('凭据: 假 Key（必然被拒，不计费）\n');
  console.log('体积      状态      来源');

  /*
   * 不二分得太细：每次上传都要等满才被拒（55 MiB 花了 18 秒）。
   * 先粗扫几个关键点，把数量级定下来。
   */
  const sizes = [1, 4, 8, 16, 24, 32];
  for (const mib of sizes) {
    const r = await probeMiB(mib);
    const src =
      r.status === 401 ? '应用层（认证）' : r.openresty ? 'openresty 网关' : r.status === 'neterr' ? '网络层' : '?';
    console.log(`${String(mib).padStart(4)} MiB  ${String(r.status).padStart(8)}  ${src}`);
  }
})();
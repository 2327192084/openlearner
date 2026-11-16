/**
 * 诊断实验（2026-11-16）：413 到底是不是「文件大小」引起的？
 *
 * ## 要回答的问题
 *
 * 用户报云 OCR 说「文件超过 100 MiB」，但实测文件只有 55.07 MiB。
 * 代码里 413 分支**不读响应体**，直接写死那句中文 —— 所以那句话是
 * 程序自己编的，不能当作服务端的原意。
 *
 * ## 实验设计（不用真 Key、不花钱）
 *
 * 往 `https://api.deepseek.com/v1/tools/ocr` 发真实请求，但用**假 Key**。
 * 看服务端先校验哪一个：
 *
 *  - 返回 **413** → 大小检查在认证之前，且服务端认为 55 MiB 超限
 *                  → 那「超过 100 MiB」就是真的，得查为什么 55 被判超
 *  - 返回 **401/403** → 认证在大小检查之前，这个实验区分不了，换法子
 *  - 返回 **其它** → 按原样记录，那也是线索
 *
 * 同时对比几种体积，看 413 是否随大小出现：
 *   1 KiB / 10 MiB / 55 MiB / 101 MiB
 *
 * ## 为什么这不算「乱发请求」
 *
 * 假 Key 必然被拒，不会产生识别、不会计费（官方：识别失败不计费）。
 * 每次只发一次，不重试。
 *
 * 用法：
 *   node scripts/diag-ocr-413.cjs [--only 55]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function arg(n, d) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
}

const URL_OCR = 'https://api.deepseek.com/v1/tools/ocr';
const FAKE_KEY = 'sk-000000000000000000000000000000000000000000000000';
const REAL_PDF = 'C:/Users/ASUS/Desktop/高等数学 第7版 上 -- 同济大学数学系编 -- ( WeLib.gl ).pdf';

/** 造一个内容随机的 PDF 形状的字节串（服务端按内容判格式，随机字节会被判 400） */
function fakePdf(size) {
  const head = Buffer.from('%PDF-1.4\n', 'latin1');
  const tail = Buffer.from('\n%%EOF\n', 'latin1');
  const body = Buffer.alloc(Math.max(0, size - head.length - tail.length), 0x20);
  return Buffer.concat([head, body, tail]);
}

async function probe(label, bytes) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), 'probe.pdf');
  form.append('purpose', 'rich_layout_recognition');

  const t0 = Date.now();
  let res;
  let text = '';
  try {
    res = await fetch(URL_OCR, {
      method: 'POST',
      headers: { Authorization: `Bearer ${FAKE_KEY}` },
      body: form,
    });
    text = await res.text();
  } catch (e) {
    console.log(
      `${label.padEnd(10)} ${(bytes.length / 1024 / 1024).toFixed(2).padStart(7)} MiB  →  网络失败: ${e.message}`,
    );
    return;
  }
  const ms = Date.now() - t0;
  console.log(
    `${label.padEnd(10)} ${(bytes.length / 1024 / 1024).toFixed(2).padStart(7)} MiB  →  HTTP ${res.status}  (${ms}ms)`,
  );
  if (text) {
    const one = text.replace(/\s+/g, ' ').slice(0, 300);
    console.log(`${''.padEnd(12)}响应体: ${one}`);
  }
}

(async () => {
  const only = arg('only', '');

  const cases = [];
  if (!only || only === '1k') cases.push(['1 KiB', fakePdf(1024)]);
  if (!only || only === '10') cases.push(['10 MiB', fakePdf(10 * 1024 * 1024)]);
  if (!only || only === '55') {
    /* 真实那份 PDF：这是用户实际遇到的场景 */
    if (fs.existsSync(REAL_PDF)) {
      cases.push(['真实 55MiB', fs.readFileSync(REAL_PDF)]);
    } else {
      console.log('找不到真实 PDF，跳过 55 MiB 那组');
    }
  }
  if (!only || only === '101') cases.push(['101 MiB', fakePdf(101 * 1024 * 1024)]);

  console.log(`目标: ${URL_OCR}`);
  console.log('凭据: 假 Key（必然被拒，不会计费）\n');

  for (const [label, bytes] of cases) {
    await probe(label, bytes);
  }
  console.log('\n说明：若小体积返回 401/403 而大体积返回 413，');
  console.log('      说明「大小检查优先于认证」—— 那时 413 就真的是体积问题。');
  console.log('      若全部返回 401/403，说明认证在前，这个实验区分不出来。');
})();
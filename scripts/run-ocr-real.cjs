/**
 * 云 OCR 真实调用（2026-11-16）：用用户的 Key 与真实 PDF 打一次 API。
 *
 * ## 回答的问题
 *
 * 「云端 OCR 识别可以用了吗？」
 *
 * 上一轮修好了三条从未接通的链路（runner 建不起来、按钮文案写死、
 * 413 谎报原因），但**从没用真 Key 成功解析过一份真实文件**
 * （交接文档第七节第 3 条就写着这条）。
 *
 * ## 这次测什么
 *
 * 用 2.15 MiB / 36 页那份（`信号与系统`），避开已知的 50 MiB 网关上限，
 * 验证「功能本身通不通」：
 *  - 网络与认证是否正常
 *  - 返回的页数对不对（应为 36）
 *  - 每页是不是真的中文正文
 *
 * ## 费用
 *
 * 真实计费：1.5 元 / 1000 页 → 36 页约 **0.054 元**。只调一次，不重试。
 *
 * 用法：
 *   node scripts/run-ocr-real.cjs
 */

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.resolve('.tmp/ocr-real');
const URL_OCR = 'https://api.deepseek.com/v1/tools/ocr';

(async () => {
  const keyB64 = fs.readFileSync(path.join(OUT, 'key.b64'), 'utf8').trim();
  const apiKey = Buffer.from(keyB64, 'base64').toString('utf8').trim();
  const pdf = fs.readFileSync(path.join(OUT, 'doc.pdf'));
  const pick = JSON.parse(fs.readFileSync(path.join(OUT, 'pick.json'), 'utf8'));

  console.log(`文件 : ${pick.title}`);
  console.log(`大小 : ${(pdf.length / 1048576).toFixed(2)} MiB`);
  console.log(`页数 : ${pick.size ? '(由服务端返回)' : ''}`);
  console.log(`Key  : ${apiKey.slice(0, 6)}…${apiKey.slice(-4)}（${apiKey.length} 字符）`);
  console.log('\n调用中（约 0.05 元）…\n');

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'doc.pdf');
  form.append('purpose', 'rich_layout_recognition');

  const t0 = Date.now();
  let res;
  let text = '';
  try {
    res = await fetch(URL_OCR, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    text = await res.text();
  } catch (e) {
    console.log(`❌ 网络失败: ${e.message} / ${e.cause?.code ?? ''}`);
    process.exit(1);
  }
  const ms = Date.now() - t0;

  console.log(`HTTP ${res.status}  耗时 ${(ms / 1000).toFixed(1)} 秒`);

  if (res.status !== 200) {
    console.log('\n响应体前 400 字：');
    console.log(text.slice(0, 400));
    process.exit(1);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    console.log('❌ 返回的不是 JSON：', text.slice(0, 200));
    process.exit(1);
  }

  /* 200 也可能是错误对象（官方点名的坑） */
  if (body.error) {
    console.log('\n⚠️ HTTP 200 但含 error 字段（这正是文档说的坑）：');
    console.log(JSON.stringify(body.error, null, 2).slice(0, 400));
    process.exit(1);
  }

  const pages = Array.isArray(body.pages) ? body.pages : [];
  console.log(`\n✅ 成功`);
  console.log(`page_count : ${body.page_count}`);
  console.log(`pages 数组 : ${pages.length} 项`);
  console.log(`usage      : ${JSON.stringify(body.usage)}`);

  console.log('\n=== 前 3 页正文（各 200 字）===');
  for (const p of pages.slice(0, 3)) {
    const t = String(p.text || '').replace(/\s+/g, ' ').slice(0, 200);
    console.log(`\n[第 ${p.index + 1} 页] finish_reason=${p.finish_reason}`);
    console.log(t);
  }

  /* 简单质检：页数对不对、有没有中文 */
  const allText = pages.map((p) => String(p.text || '')).join('');
  const cjk = (allText.match(/[\u4e00-\u9fa5]/g) || []).length;
  console.log('\n=== 质检 ===');
  console.log(`总字符数   : ${allText.length}`);
  console.log(`其中汉字   : ${cjk}`);
  console.log(`页数与资料 : ${body.page_count === pages.length ? '一致' : `不一致（${body.page_count} vs ${pages.length}）`}`);
  console.log(cjk > 100 ? '\n✅ 返回的是真中文正文，云 OCR 可用' : '\n⚠️ 汉字太少，可能识别有问题');

  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(body, null, 2), 'utf8');
  console.log(`\n完整结果已存 ${path.relative(process.cwd(), path.join(OUT, 'result.json'))}`);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(2);
});
/**
 * B2 验证：知识点 → 阅读器，能否圈准那句话（2026-11-21）。
 *
 * ## 为什么值得单独验
 *
 * 用户库里 **104 条知识点**都带句子级锚点（44~144 字）与逐字 quotes。
 * 而 `KnowledgePage` 的「第 N 页」按钮传的是
 * `{sourceId, page, charStart, charEnd, quote}` —— 看起来该能圈准。
 *
 * 但这一轮已经多次证明「看起来对」不等于对：
 *  - 题目那条路也是这么传的，结果因为 `ReaderTarget` 缺 segmentId 而圈不中
 *  - 所以这里必须实测「点击后 mark 的文本 == 知识点的 quotes[0]」
 *
 * ## 判据
 *
 * 圈出来的 mark 文本应当（归一空白后）**等于该知识点的 quotes[0]**，
 * 而不是整段、也不是空。
 *
 * 用法：node scripts/verify-kp-anchor.cjs
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/kp-anchor-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/kp-anchor');
const PORT = Number(process.argv[2] || 9896);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x) => {
  console.log((ok ? '✅ ' : '❌ ') + n + (x ? ' :: ' + x : ''));
  ok ? pass++ : fail++;
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(APPDATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.cpSync(path.join(process.env.APPDATA, 'OpenLeaner/IndexedDB'), path.join(DATA, 'IndexedDB'), { recursive: true });
  console.log('已复制真实库副本');

  const exe = path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
  if (fs.existsSync(path.join(path.dirname(exe), 'openleaner-data'))) {
    console.error('❌ app 目录旁有 openleaner-data');
    process.exit(2);
  }

  const app = spawn(
    exe,
    [ROOT, '--user-data-dir=' + DATA, '--no-sandbox', '--remote-debugging-port=' + PORT, '--window-size=1440,1000'],
    { cwd: ROOT, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  app.stdout.on('data', (d) => (log += d.toString()));
  app.stderr.on('data', (d) => (log += d.toString()));

  let target = null;
  for (let i = 0; i < 240; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      target = l.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
      if (target) break;
    } catch {}
    await sleep(250);
  }
  if (!target) {
    console.error('起不来：' + log.slice(-1200));
    process.exit(2);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 1;
  const pending = new Map();
  const errs = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      errs.push((m.params.args || []).map((a) => a.value ?? '').join(' ').slice(0, 150));
    }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  const send = (me, pa) =>
    new Promise((res, rej) => {
      const n = id++;
      pending.set(n, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id: n, method: me, params: pa || {} }));
      setTimeout(() => {
        if (pending.has(n)) {
          pending.delete(n);
          rej(new Error('timeout'));
        }
      }, 120000);
    });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (n) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, n), Buffer.from(r.data, 'base64'));
  };
  const waitFor = async (expr, ms = 25000, label = '') => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await ev(expr).catch(() => null);
      if (v) return v;
      await sleep(300);
    }
    throw new Error('等待超时' + (label ? '（' + label + '）' : ''));
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(6000);

  /* 进知识库 */
  await ev(`(() => {
    for (const lb of document.querySelectorAll(".nav-group__label")) {
      const b = lb.closest("button");
      if (b && b.getAttribute("aria-expanded") !== "true") b.click();
    }
    return true;
  })()`);
  await sleep(700);
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
      .find((e) => (e.textContent || "").trim() === "知识库");
    if (el) { el.click(); return true; }
    return false;
  })()`);
  await waitFor(`document.querySelector(".kb-page") ? true : null`, 25000, '知识库页');
  await sleep(1200);
  await shot('01-knowledge-page.png');

  /* 找第一个可点的「第 N 页」链接 */
  const linkInfo = await ev(`(() => {
    const links = [...document.querySelectorAll(".kb-point__link")];
    if (!links.length) return { count: 0 };
    const btn = links[0];
    /*
     * 从同一条知识点里读出它的 quotes[0] —— 用于后面比较圈出来的文本。
     * DOM 结构：.kb-point 里 .kb-point__quote 是「…」包着的引文。
     */
    const li = btn.closest(".kb-point") || btn.closest("li");
    const quoteEl = li?.querySelector(".kb-point__quote");
    const rawQuote = (quoteEl?.textContent ?? "").trim();
    return {
      count: links.length,
      btnText: btn.textContent.trim(),
      quote: rawQuote.replace(/^「|」$/g, "").trim(),
      statement: (li?.querySelector(".kb-point__statement")?.textContent ?? "").trim().slice(0, 30),
    };
  })()`);
  console.log('知识点链接 =', JSON.stringify(linkInfo, null, 1));
  rec('知识库里有「第 N 页」定位链接', linkInfo.count > 0, '数量=' + linkInfo.count);

  /* 点它 */
  await ev(`(() => {
    const btn = document.querySelector(".kb-point__link");
    if (btn) { btn.click(); return true; }
    return false;
  })()`);
  await waitFor(`document.querySelector(".reader-page, .reader-split") ? true : null`, 25000, '阅读器');
  /* 高亮是第二步 effect 画的 */
  await waitFor(`document.querySelector("mark.reader-mark, .reader-jump") ? true : null`, 25000, '定位标记');
  await sleep(1000);
  await shot('02-jumped.png');

  const jumped = await ev(`(() => {
    const marks = [...document.querySelectorAll("mark.reader-mark")];
    const text = marks.map((m) => m.textContent || "").join("");
    const cs = marks[0] ? getComputedStyle(marks[0]) : null;
    return {
      inReader: !!document.querySelector(".reader-page, .reader-split"),
      markCount: marks.length,
      markedText: text,
      markedLen: text.length,
      isTransient: marks[0] ? /reader-mark--transient/.test(marks[0].className) : false,
      bg: cs ? cs.backgroundColor : null,
      page: (document.querySelector(".reader-nav input")?.value ?? "").trim(),
    };
  })()`);
  console.log('跳过去后 =', JSON.stringify(jumped, null, 1));

  rec('**进了阅读器**', jumped.inReader);
  rec('**圈出了内容**（不是空白）', jumped.markCount > 0 && jumped.markedLen > 0,
      'mark=' + jumped.markCount + ' 字数=' + jumped.markedLen);
  rec('用的是橙光（临时定位）', jumped.isTransient, jumped.bg ?? '');

  /*
   * 核心判据：圈出来的文本应等于知识点的 quotes[0]（归一空白后比较）。
   * 相等 = 精确定位到那一句；只是「有一段高亮」不够 ——
   * 那可能是整段、也可能是错的位置。
   */
  const norm = (s) => s.replace(/\s+/g, '').trim();
  const marked = norm(jumped.markedText);
  const quote = norm(linkInfo.quote ?? '');
  const exact = quote.length > 0 && marked === quote;
  const contained = quote.length > 0 && (marked.includes(quote) || quote.includes(marked));

  rec('**圈出的就是那句话**（归一空白后与 quotes[0] 相等）', exact,
      `圈出 ${marked.length} 字 / 引文 ${quote.length} 字`);
  if (!exact && contained) {
    console.log('  （不完全相等但互相包含 —— 可能是引文两端空白/标点差异）');
    console.log('  圈出:', JSON.stringify(marked.slice(0, 60)));
    console.log('  引文:', JSON.stringify(quote.slice(0, 60)));
  }
  rec('圈出的是短句（不是整段）', jumped.markedLen > 0 && jumped.markedLen <= 200,
      jumped.markedLen + ' 字');

  rec('没有控制台报错', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  console.log('  截图：' + SHOTS);
  if (fail > 0) process.exitCode = 1;

  ws.close();
  app.kill();
  await sleep(1200);
})();
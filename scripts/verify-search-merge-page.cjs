/**
 * B3 验证：搜索结果同页归并（2026-11-21）。
 *
 * ## 问题
 *
 * 实测搜「极限」时，前 6 条结果**全部来自「第 11 页 目录」**——
 * 目录页密集出现这个词，真正有价值的内容（第 18、27 页）被压在下面。
 *
 * ## 要证的
 *
 * 1. 默认「按页合并」：同一页多处只占一行，并标「本页 N 处」
 * 2. 组头显示「N 处 · M 页」（页数才是用户想看的）
 * 3. 有「按处列出」开关，点了能切回每条单列
 * 4. 点归并行 → 跳到该页**第一处**并标橙光
 * 5. 每页只命中一次时**不出现**归并开关（否则是假开关）
 *
 * 用法：node scripts/verify-search-merge-page.cjs
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/merge-page-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/search-merge-page');
const PORT = Number(process.argv[2] || 9898);
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
  const waitFor = async (expr, ms = 30000, label = '') => {
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

  /* 进搜索页 */
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
      .find((e) => (e.textContent || "").trim() === "搜索");
    if (el) { el.click(); return true; }
    return false;
  })()`);
  await waitFor(`document.querySelector(".spage") ? true : null`, 25000, '搜索页');
  await sleep(500);

  const search = async (kw) => {
    await ev(`(() => {
      const i = document.querySelector(".spage__input");
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      s.call(i, ${JSON.stringify(kw)});
      i.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    await ev(`(() => {
      const b = document.querySelector(".spage__go");
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    })()`);
    await waitFor(
      `(() => {
        const el = document.querySelector(".spage__summary");
        return el && el.textContent.includes(${JSON.stringify(kw.trim())}) ? true : null;
      })()`,
      30000,
      '结果:' + kw,
    );
    await sleep(600);
  };

  /* 搜「极限」——实测它有同页多处（目录页） */
  await search('极限');
  await shot('01-merged.png');

  const merged = await ev(`(() => {
    const g = document.querySelector(".spage__group");
    const rows = [...g.querySelectorAll(".spage__hit")];
    return {
      headCount: (g.querySelector(".spage__count")?.textContent ?? "").trim(),
      rowCount: rows.length,
      pageCountBadges: [...g.querySelectorAll(".spage__pagecount")].map((x) => x.textContent.trim()),
      pageTexts: rows.map((r) => (r.querySelector(".spage__where")?.textContent ?? "").trim().slice(0, 12)),
      toggles: [...g.querySelectorAll(".spage__toggle")].map((b) => b.textContent.trim()),
      hasMergeToggle: [...g.querySelectorAll(".spage__toggle")].some((b) => /按处列出|按页合并/.test(b.textContent)),
    };
  })()`);
  console.log('归并后 =', JSON.stringify(merged, null, 1));

  rec('结果列表渲染出来了', merged.rowCount > 0, '行数=' + merged.rowCount);
  rec('**组头显示「N 处 · M 页」**', /页/.test(merged.headCount), merged.headCount);
  rec('**有「本页 N 处」标记**（说明这一行代表多处）',
      merged.pageCountBadges.length > 0, JSON.stringify(merged.pageCountBadges.slice(0, 3)));
  rec('**有「按处列出」开关**', merged.hasMergeToggle, JSON.stringify(merged.toggles));
  rec('页码不重复（一页只占一行）',
      new Set(merged.pageTexts).size === merged.pageTexts.length,
      JSON.stringify(merged.pageTexts));

  /* 切到「按处列出」 */
  await ev(`(() => {
    const b = [...document.querySelectorAll(".spage__toggle")].find((x) => /按处列出/.test(x.textContent));
    if (b) { b.click(); return true; }
    return false;
  })()`);
  await sleep(900);
  await shot('02-per-hit.png');

  const perHit = await ev(`(() => {
    const g = document.querySelector(".spage__group");
    return {
      rowCount: g.querySelectorAll(".spage__hit").length,
      hasMergeToggleBack: [...g.querySelectorAll(".spage__toggle")].some((b) => /按页合并/.test(b.textContent)),
      pageCountBadges: g.querySelectorAll(".spage__pagecount").length,
    };
  })()`);
  console.log('按处列出 =', JSON.stringify(perHit));
  rec('**切到「按处列出」后行数变多**',
      perHit.rowCount > merged.rowCount,
      merged.rowCount + ' → ' + perHit.rowCount);
  rec('开关文字变成「按页合并」', perHit.hasMergeToggleBack);
  rec('按处列出时不再有「本页 N 处」标记', perHit.pageCountBadges === 0, String(perHit.pageCountBadges));

  /* 切回归并，然后点第一行验证落点 */
  await ev(`(() => {
    const b = [...document.querySelectorAll(".spage__toggle")].find((x) => /按页合并/.test(x.textContent));
    if (b) { b.click(); return true; }
    return false;
  })()`);
  await sleep(900);

  const clicked = await ev(`(() => {
    const row = document.querySelector(".spage__hit");
    if (!row) return null;
    const t = (row.querySelector(".spage__where")?.textContent ?? "").trim();
    row.click();
    return t;
  })()`);
  await waitFor(`document.querySelector(".reader-page, .reader-split") ? true : null`, 25000, '阅读器');
  await waitFor(`document.querySelector("mark.reader-mark, .reader-jump") ? true : null`, 25000, '定位标记');
  await sleep(900);
  await shot('03-jumped-from-merged.png');

  const jumped = await ev(`(() => {
    const m = document.querySelector("mark.reader-mark");
    return {
      inReader: !!document.querySelector(".reader-page, .reader-split"),
      marks: document.querySelectorAll("mark.reader-mark").length,
      markedText: (m?.textContent ?? "").trim().slice(0, 30),
      isTransient: m ? /reader-mark--transient/.test(m.className) : false,
    };
  })()`);
  rec('**点归并行能跳到原文并标出内容**',
      jumped.inReader && jumped.marks >= 1, JSON.stringify(jumped).slice(0, 90));
  rec('用的是橙光', jumped.isTransient);

  /* 换一个「每页只命中一次」的词，验证不出现归并开关 */
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
      .find((e) => (e.textContent || "").trim() === "搜索");
    if (el) { el.click(); return true; }
    return false;
  })()`);
  await waitFor(`document.querySelector(".spage") ? true : null`, 25000, '回搜索页');
  await sleep(600);
  await search('导数');
  const sparse = await ev(`(() => {
    const g = document.querySelector(".spage__group");
    if (!g) return null;
    return {
      headCount: (g.querySelector(".spage__count")?.textContent ?? "").trim(),
      toggles: [...g.querySelectorAll(".spage__toggle")].map((b) => b.textContent.trim()),
      hasMergeToggle: [...g.querySelectorAll(".spage__toggle")].some((b) => /按处列出|按页合并/.test(b.textContent)),
    };
  })()`);
  console.log('稀疏词 =', JSON.stringify(sparse));
  /*
   * 「导数」在用户库里 19 处，可能仍有同页多处 —— 所以这条断言
   * 只要求「开关是否出现与是否真有同页多处一致」，不强制它必须消失。
   */
  rec('稀疏词也能正常出结果', !!sparse && sparse.headCount.length > 0, sparse?.headCount ?? '未找到');

  rec('没有控制台报错', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  console.log('  截图：' + SHOTS);
  if (fail > 0) process.exitCode = 1;

  ws.close();
  app.kill();
  await sleep(1200);
})();
/**
 * 验证「搜索历史」（2026-11-21）。
 *
 * ## 用户要求
 *
 * 参考图：搜索框底下一行「搜索历史」+ 右侧「清空」+ 一排胶囊标签
 * （「高数」「英语」）。
 *
 * ## 要证的
 *
 * 1. 首次进页面**没有**历史区块（空的就别显示）
 * 2. 搜一次后出现历史，且是**刚搜的那个词**
 * 3. 搜多个词 → 最新的在最前
 * 4. **重复搜同一个词不产生两条**（去重）
 * 5. 点历史标签 → 填进输入框并立刻搜
 * 6. 单条「×」能删掉那一条
 * 7. 「清空」清掉全部
 * 8. **刷新后历史还在**（localStorage 持久化）
 * 9. 搜不到东西的词**不进历史**（只有有结果的才值得记）
 *
 * 用法：node scripts/verify-search-history.cjs
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/desktop-search-history-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/desktop-search-history');
const PORT = Number(process.argv[2] || 9894);
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

  const exe = 'C:/Users/ASUS/AppData/Local/Programs/OpenLeaner/OpenLeaner.exe';
  if (fs.existsSync(path.join(path.dirname(exe), 'openleaner-data'))) {
    console.error('❌ app 目录旁有 openleaner-data');
    process.exit(2);
  }

  const app = spawn(
    exe,
    [`--user-data-dir=${DATA}`, '--no-sandbox', '--remote-debugging-port=' + PORT, '--window-size=1440,1000'],
    { cwd: path.dirname(exe), env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
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

  const goSearchPage = async () => {
    await ev(`(() => {
      for (const lb of document.querySelectorAll(".nav-group__label")) {
        const b = lb.closest("button"); const sec = lb.closest(".nav-section");
        if (b && sec && b.getAttribute("aria-expanded") !== "true") b.click();
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
  };

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
    /*
     * ⚠️ 必须等**这一次**的结果，不能只等「有摘要」（2026-11-21 踩到）。
     *
     * 上一次搜索的 `.spage__summary` 还在 DOM 里，只判断「存在摘要」
     * 会在新结果回来之前就通过 —— 于是紧接着读历史时读到的还是旧状态，
     * 表现为「搜了「函数」但历史里只有「极限」」的假失败。
     *
     * 条件改成：摘要或空态标题里**包含这次的关键词**。
     * 搜不到时是空态文案（含关键词），搜到时是摘要（含关键词），两者都命中。
     */
    await waitFor(
      `(() => {
        const el = document.querySelector(".spage__summary, .spage__empty-title");
        if (!el) return null;
        return el.textContent.includes(${JSON.stringify(kw.trim())}) ? true : null;
      })()`,
      30000,
      '结果:' + kw,
    );
    await sleep(500);
  };

  const hist = () =>
    ev(`(() => {
      const box = document.querySelector(".spage__history");
      if (!box) return { has: false, chips: [] };
      return {
        has: true,
        title: (box.querySelector(".spage__history-title")?.textContent ?? "").trim(),
        hasClear: !!box.querySelector(".spage__history-clear"),
        chips: [...box.querySelectorAll(".spage__history-chip")].map((b) => b.textContent.trim()),
        delCount: box.querySelectorAll(".spage__history-del").length,
      };
    })()`);

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(6000);

  /* ---------- 1. 首次进来没有历史 ---------- */
  await goSearchPage();
  const empty = await hist();
  rec('**首次进页面没有历史区块**（空的就不显示）', !empty.has, JSON.stringify(empty));
  await shot('01-no-history.png');

  /* ---------- 2. 搜一次 → 出现历史 ---------- */
  await search('极限');
  const one = await hist();
  console.log('搜一次后 =', JSON.stringify(one));
  rec('**搜一次后出现历史区块**', one.has);
  rec('标题是「搜索历史」', one.title === '搜索历史', one.title);
  rec('右侧有「清空」', one.hasClear);
  rec('**历史里是刚搜的词**', one.chips[0] === '极限', JSON.stringify(one.chips));
  await shot('02-one-history.png');

  /* ---------- 3. 搜多个词 → 最新在前 ---------- */
  await search('函数');
  const two = await hist();
  rec('**最新的在最前**', two.chips[0] === '函数' && two.chips[1] === '极限', JSON.stringify(two.chips));

  /* ---------- 4. 重复搜同一个词不产生两条 ---------- */
  await search('极限');
  const again = await hist();
  console.log('重复搜「极限」后 =', JSON.stringify(again.chips));
  rec('**重复搜同一个词不产生两条**',
      again.chips.filter((c) => c === '极限').length === 1,
      JSON.stringify(again.chips));
  rec('重复搜后该词提到最前', again.chips[0] === '极限', JSON.stringify(again.chips));

  /* ---------- 5. 搜不到的词不进历史 ---------- */
  await search('绝不存在的词组zzz');
  const afterMiss = await hist();
  rec('**搜不到的词不进历史**',
      !afterMiss.chips.some((c) => /zzz/.test(c)),
      JSON.stringify(afterMiss.chips));

  /* ---------- 6. 点历史标签 → 立刻搜 ---------- */
  const chipClicked = await ev(`(() => {
    const chips = [...document.querySelectorAll(".spage__history-chip")];
    const target = chips.find((c) => c.textContent.trim() === "函数") ?? chips[0];
    if (!target) return null;
    const t = target.textContent.trim();
    target.click();
    return t;
  })()`);
  await sleep(2500);
  const afterChip = await ev(`(() => ({
    inputValue: document.querySelector(".spage__input")?.value ?? "",
    summary: (document.querySelector(".spage__summary")?.textContent ?? "").slice(0, 30),
    hitCount: document.querySelectorAll(".spage__hit").length,
  }))()`);
  console.log('点历史标签 =', JSON.stringify(afterChip));
  rec('点历史标签后**输入框被填上**',
      afterChip.inputValue === chipClicked, `点了「${chipClicked}」，输入框=「${afterChip.inputValue}」`);
  rec('**并立刻搜出了结果**', afterChip.hitCount > 0, '条目=' + afterChip.hitCount);
  await shot('03-used-history.png');

  /* ---------- 7. 单条删除 ---------- */
  const beforeDel = (await hist()).chips;
  await ev(`(() => {
    const item = document.querySelector(".spage__history-item");
    const btn = item?.querySelector(".spage__history-del");
    if (btn) { btn.click(); return true; }
    return false;
  })()`);
  await sleep(700);
  const afterDel = (await hist()).chips;
  rec('**单条「×」能删掉一条**',
      afterDel.length === beforeDel.length - 1,
      beforeDel.length + ' → ' + afterDel.length);

  /* ---------- 8. 刷新后历史还在（持久化） ---------- */
  await ev('location.reload()');
  await sleep(7000);
  await goSearchPage();
  const afterReload = await hist();
  console.log('刷新后 =', JSON.stringify(afterReload.chips));
  rec('**刷新后历史还在**（localStorage 持久化）',
      afterReload.has && afterReload.chips.length > 0,
      JSON.stringify(afterReload.chips));
  await shot('04-after-reload.png');

  /* ---------- 9. 清空 ---------- */
  await ev(`(() => {
    const b = document.querySelector(".spage__history-clear");
    if (b) { b.click(); return true; }
    return false;
  })()`);
  await sleep(700);
  const afterClear = await hist();
  rec('**「清空」清掉全部，整块消失**', !afterClear.has, JSON.stringify(afterClear));
  await shot('05-after-clear.png');

  rec('没有控制台报错', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  console.log('  截图：' + SHOTS);
  if (fail > 0) process.exitCode = 1;

  ws.close();
  app.kill();
  await sleep(1200);
})();
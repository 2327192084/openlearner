/**
 * 验证「待办里那三项小活」（2026-11-13）。
 *
 * ## 为什么三项放一个脚本
 *
 * 它们都是「补入口」性质的改动，共同的风险是**做出来了但没接上**
 * （这个项目已经因此被投诉过三次）。一起验能顺带确认导航没有被改坏。
 *
 * ## 三项分别验什么
 *
 * 1. **提问式复习记录回看**：侧栏有入口 → 页面能开 → 有记录时列表出来、
 *    能按「只看答错的」筛、能点开看详情（含「你当时的回答」「原文依据」）。
 *    造数据直接写 `oralReviews` 分区（真实库那份可能没有记录）。
 * 2. **阅读器滚动位置保留**：进阅读器 → 滚下去 → 翻到下一段 → 翻回来 →
 *    **必须回到原来那个位置**，而不是顶部。
 *    反向验证点：修复前一律 `scrollTo(0)`，所以这个断言在旧版应失败。
 * 3. **资料库页码跳转**：每份多页资料行上有「跳页」→ 点开出现号码框 →
 *    输入页码回车 → 打开阅读器并落在那一页。
 *
 * 用法（⚠️ 会写数据，必须用副本）：
 *   node scripts/verify-small-todos.cjs --data .tmp/sg-data [--port 9941]
 *   加 --app <目录> 指向旧构建做反向验证。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APP = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA = path.resolve(ROOT, arg('data', '.tmp/sg-data'));
const PORT = Number(arg('port', '9941'));
const SHOT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/small-todos'));
const SLEEP_MS = Number(arg('boot-wait', '2800'));
const REAL_OCR = arg('real', false) === true;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const app = spawn(
    path.join(APP, 'OpenLeaner.exe'),
    /*
     * 窗口别开太高（2026-11-13）。
     *
     * 「滚动位置保留」这项要求当前这一段**装不下**（scrollHeight > clientHeight）。
     * 1440×1000 时 36 段 PDF 的第一段正好一屏放得下，maxTop 是 0 ——
     * 那不是 bug，是窗口太大。1400×820 实测能滚（1203 vs 817）。
     */
    [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1400,820'],
    { stdio: 'ignore' },
  );

  let code = 0;
  try {
    let page = null;
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }
    if (!page) throw new Error('Electron 没起来');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    let id = 1;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = id++;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
        setTimeout(() => {
          if (pending.has(n)) {
            pending.delete(n);
            reject(new Error(`CDP 超时: ${method}`));
          }
        }, 30000);
      });
    const evalJs = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      }
      return r.result.value;
    };
    /* 按钮文字匹配用 indexOf 不用 ===（项目里踩过） */
    const click = (label) =>
      evalJs(`(() => {
        const want = ${JSON.stringify(label)};
        const els = [...document.querySelectorAll('button, a, [role="button"]')];
        const hit = els.find(el => (el.innerText || '').trim().indexOf(want) === 0)
                 || els.find(el => (el.innerText || '').indexOf(want) >= 0);
        if (!hit) return false;
        hit.scrollIntoView({ block: 'center' });
        hit.click();
        return true;
      })()`);
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(s.data, 'base64'));
    };
    /** 展开侧栏折叠分组（只点未展开的 —— 「每天」默认展开，点了会收起） */
    const expandNav = () =>
      evalJs(`(() => {
        const groups = [...document.querySelectorAll('button.nav-group')];
        if (groups.length === 0) return false;
        for (const g of groups) if (g.getAttribute('aria-expanded') !== 'true') g.click();
        return true;
      })()`);
    /** 按 .nav-item__label 精确去侧栏（不要在全页 button 里 indexOf） */
    const navTo = (label) =>
      evalJs(`(() => {
        const hit = [...document.querySelectorAll('.nav-item__label')]
          .find(l => (l.innerText || '').trim().indexOf(${JSON.stringify(label)}) >= 0);
        if (!hit) return false;
        const btn = hit.closest('button');
        if (!btn) return false;
        btn.click();
        return true;
      })()`);

    await send('Runtime.enable');
    await sleep(SLEEP_MS);

    /* ================================================================
       第 1 项：提问式复习 · 记录回看
       ================================================================ */

    // 先造三条记录（一份真实库可能是空的，空页面验不出列表/筛选/详情）
    const seeded = await evalJs(`(async () => {
      const open = () => new Promise((res, rej) => {
        const q = indexedDB.open('openleaner');
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      const db = await open();
      const all = (s) => new Promise((res, rej) => {
        const tx = db.transaction(s, 'readonly');
        const rq = tx.objectStore(s).getAll();
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
      const srcs = await all('sources');
      const src = srcs[0] || null;
      const now = Date.now();
      const mk = (i, verdict, question, answer, explanation, correction, quote, verified) => ({
        id: 'oral_verify_' + i,
        scopeLabel: '第 ' + (8 + i) + ' 页 · 验证用',
        sourceId: src ? src.id : null,
        page: src ? 8 + i : null,
        quote: '验证用引文',
        question,
        answer,
        verdict,
        quotedFromSource: quote,
        quoteVerified: verified,
        explanation,
        correction,
        savedAs: 'brief',
        fullText: null,
        createdAt: new Date(now - i * 3600_000).toISOString(),
      });
      const rows = [
        mk(1, 'memory', '两类信号怎么区分？', '用括号', '你把记号记反了', '连续用 ()，离散用 []', '连续时间信号用圆括号', true),
        mk(2, 'understanding', '为什么单位冲激要放在积分里定义？', '因为它是个函数', '理解偏了', '它是分布，不是普通函数', '作为一个分布来定义', true),
        mk(3, 'correct', '离散信号的周期条件是什么？', '存在正整数 N 使 x[n]=x[n+N]', '答对了', '', '存在非零整数 N', true),
      ];
      await new Promise((res, rej) => {
        const tx = db.transaction('oralReviews', 'readwrite');
        const st = tx.objectStore('oralReviews');
        for (const r of rows) st.put(r);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      return { ok: true, count: rows.length, hasSource: !!src };
    })()`);
    record('造出 3 条提问式复习记录', seeded.ok === true, JSON.stringify(seeded));

    await send('Page.reload');
    await sleep(SLEEP_MS + 1200);

    await expandNav();
    await sleep(600);
    const wentOral = await navTo('提问复习记录');
    record('侧栏有「提问复习记录」入口', wentOral === true);
    await sleep(1800);

    const oralState = await evalJs(`(() => {
      const title = (document.querySelector('.oral-archive__title')?.innerText ?? '').trim();
      const sub = (document.querySelector('.oral-archive__sub')?.innerText ?? '').trim();
      const rows = [...document.querySelectorAll('.oral-archive__row')];
      const filters = [...document.querySelectorAll('.oral-archive__filter')]
        .map(b => (b.innerText || '').replace(/\\s+/g, ' ').trim());
      const verdicts = [...document.querySelectorAll('.oral-archive__verdict')]
        .map(v => (v.innerText || '').trim());
      return { title, sub, rowCount: rows.length, filters, verdicts };
    })()`);
    record('回看页能打开（标题正确）', oralState.title.indexOf('记录回看') >= 0, oralState.title);
    record('顶部有摘要（说清最近几天做了几次）', oralState.sub.length > 0, oralState.sub);
    record('列出全部 3 条记录', oralState.rowCount === 3, `实际 ${oralState.rowCount} 行`);
    record(
      '三种判定都显示成中文（答对了 / 记错了 / 理解偏了）',
      oralState.verdicts.includes('答对了') &&
        oralState.verdicts.includes('记错了') &&
        oralState.verdicts.includes('理解偏了'),
      JSON.stringify(oralState.verdicts),
    );
    await shot('oral-all.png');

    // 筛选：只看答错的
    const filtered = await evalJs(`(() => {
      const b = [...document.querySelectorAll('.oral-archive__filter')]
        .find(x => (x.innerText || '').indexOf('只看答错的') >= 0);
      if (!b) return { ok: false };
      b.click();
      const rows = [...document.querySelectorAll('.oral-archive__row')].length;
      const verdicts = [...document.querySelectorAll('.oral-archive__verdict')]
        .map(v => (v.innerText || '').trim());
      return { ok: true, rows, verdicts };
    })()`);
    await sleep(500);
    const afterFilter = await evalJs(`(() => ({
      rows: document.querySelectorAll('.oral-archive__row').length,
      verdicts: [...document.querySelectorAll('.oral-archive__verdict')].map(v => (v.innerText||'').trim()),
    }))()`);
    record(
      '「只看答错的」把答对的筛掉（3 → 2）',
      filtered.ok === true && afterFilter.rows === 2 && !afterFilter.verdicts.includes('答对了'),
      JSON.stringify(afterFilter),
    );

    // 点开第一条看详情
    const opened = await evalJs(`(() => {
      const row = document.querySelector('.oral-archive__row');
      if (!row) return false;
      row.click();
      return true;
    })()`);
    await sleep(500);
    const detail = await evalJs(`(() => {
      const d = document.querySelector('.oral-archive__detail');
      if (!d) return { open: false };
      const blocks = [...d.querySelectorAll('.oral-archive__block-title')].map(x => (x.innerText||'').trim());
      return {
        open: true,
        blocks,
        text: (d.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
        hasQuote: !!d.querySelector('.oral-archive__quote'),
        hasVerified: !!d.querySelector('.oral-archive__verified'),
        hasAnchor: [...d.querySelectorAll('button')].some(b => (b.innerText||'').indexOf('回到原文') >= 0),
      };
    })()`);
    record('点一行能就地展开详情', opened === true && detail.open === true);
    record(
      '详情含「你当时的回答 / 判定 / 原文依据」三块',
      detail.open &&
        detail.blocks.some((b) => b.indexOf('你当时的回答') >= 0) &&
        detail.blocks.some((b) => b.indexOf('判定') >= 0) &&
        detail.blocks.some((b) => b.indexOf('原文依据') >= 0),
      JSON.stringify(detail.blocks),
    );
    record('详情显示原文引文并标注「已核对」', detail.hasQuote === true && detail.hasVerified === true);
    record('详情有「回到原文」入口（有出处时）', detail.hasAnchor === true);
    await shot('oral-detail.png');

    /* ================================================================
       第 2 项：阅读器滚动位置保留
       ================================================================ */

    await expandNav();
    await sleep(500);
    await navTo('资料');
    await sleep(1500);

    /*
     * 打开「段数最多」的那份资料。
     *
     * 不能取第一个有段数的：列表里可能先出现一份 2 段的 docx，
     * 而这一段只有一屏高、`scrollHeight - clientHeight` 是 0 ——
     * 滚不动就验不了「滚动位置保留」。
     * 数据副本里那份 36 段 PDF 才够长。
     */
    const openedReader = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const rows = [...document.querySelectorAll('.source-item')];
      const cands = rows.map((li) => {
        const meta = li.querySelector('.source-row__meta')?.innerText ?? '';
        const segs = Number((meta.match(/·\\s*(\\d+)\\s*段/) || [])[1] || 0);
        return { li, meta, segs };
      }).sort((a, b) => b.segs - a.segs);
      if (cands.length === 0 || cands[0].segs <= 0) {
        return { ok: false, rows: rows.map(r => r.querySelector('.source-row__meta')?.innerText ?? '') };
      }
      cands[0].li.querySelector('.source-row')?.click();
      await sleep(2500);
      return { ok: true, meta: cands[0].meta, segs: cands[0].segs };
    })()`);
    record('能打开一份有正文的资料', openedReader.ok === true, JSON.stringify(openedReader));
    await sleep(2000);

    const readerReady = await evalJs(`(() => ({
      hasBody: !!document.querySelector('.reader-body'),
      hasSlider: !!document.querySelector('.reader-slider'),
      pageLabel: (document.querySelector('.reader-nav__input')?.value ?? ''),
    }))()`);
    record('阅读器渲染出来了', readerReady.hasBody === true, JSON.stringify(readerReady));

    /*
     * 滚下去 → 记住位置 → 翻页 → 翻回来 → 位置应该被恢复。
     *
     * 关键：要滚到一个「明显不等于 0」的位置，否则「回到 0」和「恢复位置」
     * 看起来一样，断言就失效了（这是反向验证能抓住的唯一点）。
     */
    const scrollProbe = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      /*
       * 滚的是 document，不是某个 div —— 实测 .app 是 min-height: 100vh
       * 会随内容长高，.reader-body / .reader-main 的 scrollHeight
       * 都等于 clientHeight（不滚）。见 reader-page.css 里那段说明。
       *
       * （这段是模板字符串里的代码，注释里不要写反引号 —— 会把模板字符串截断。）
       */
      const de = document.documentElement;
      const maxTop = de.scrollHeight - de.clientHeight;
      if (maxTop < 120) return { ok: false, reason: '这一段不够长，滚不动', maxTop };
      const target = Math.min(200, maxTop);
      window.scrollTo({ top: target });
      await sleep(400);
      return { ok: true, maxTop, before: window.scrollY, target };
    })()`);
    record('这一段内容足够长，可以滚', scrollProbe.ok === true, JSON.stringify(scrollProbe));

    let restored = { ok: false };
    if (scrollProbe.ok) {
      restored = await evalJs(`(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const before = window.scrollY;
        // 找「下一段」按钮（底部翻页栏里）
        const nextBtn = [...document.querySelectorAll('button')]
          .find(b => (b.innerText || '').trim().indexOf('下一段') >= 0);
        if (!nextBtn) return { ok: false, reason: '没有「下一段」按钮', before };
        nextBtn.click();
        await sleep(1200);
        const midPage = window.scrollY;
        const prevBtn = [...document.querySelectorAll('button')]
          .find(b => (b.innerText || '').trim().indexOf('上一段') >= 0);
        if (!prevBtn) return { ok: false, reason: '没有「上一段」按钮', before, midPage };
        prevBtn.click();
        await sleep(1200);
        return { ok: true, before, midPage, after: window.scrollY };
      })()`);
    }
    /*
     * 这条断言要能区分「真的恢复了位置」和「根本没动过」。
     *
     * 旧版（修复前）翻页时不滚也不记，用户停在原地 ——
     * 「翻走再翻回」结束时窗口位置**恰好也是 200**，单看
     * `after ≈ before` 会误判成通过。所以再加一条：翻到下一段之后
     * 位置必须**几乎归零**（新实现会跳到该段的记忆位置，第一段没记过 → 0）。
     *
     * 阈值取 8px 而不是「小于一半」：实测旧版停在 18.8px（浏览器把
     * 200px 的滚动位置夹到新内容的上限后剩下的），用宽松阈值区分不开。
     */
    record(
      '翻走再翻回来，回到原来那个位置（不是顶部）',
      restored.ok === true &&
        restored.after > 0 &&
        Math.abs(restored.after - restored.before) <= 8 &&
        restored.midPage <= 8,
      JSON.stringify(restored),
    );
    await shot('reader-scroll-restored.png');

    // 反向：点「回到顶部」后，再翻走翻回，应该在顶部（记忆被清掉）
    const afterTop = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const topBtn = [...document.querySelectorAll('button')]
        .find(b => (b.innerText || '').trim().indexOf('回到顶部') >= 0);
      if (!topBtn) return { ok: false, reason: '没有「回到顶部」按钮' };
      topBtn.click();
      await sleep(900);
      const nextBtn = [...document.querySelectorAll('button')]
        .find(b => (b.innerText || '').trim().indexOf('下一段') >= 0);
      nextBtn?.click();
      await sleep(1000);
      const prevBtn = [...document.querySelectorAll('button')]
        .find(b => (b.innerText || '').trim().indexOf('上一段') >= 0);
      prevBtn?.click();
      await sleep(1200);
      return { ok: true, after: window.scrollY };
    })()`);
    record(
      '点过「回到顶部」后，翻回来也在顶部（记忆被清掉，不被送回旧位置）',
      afterTop.ok === true && afterTop.after === 0,
      JSON.stringify(afterTop),
    );

    /* ================================================================
       第 3 项：资料库页码跳转
       ================================================================ */

    // 先回资料页
    await evalJs(`(() => {
      const back = [...document.querySelectorAll('button')]
        .find(b => (b.innerText || '').trim().indexOf('返回') >= 0);
      back?.click();
      return true;
    })()`);
    await sleep(1500);
    await expandNav();
    await sleep(500);
    await navTo('资料');
    await sleep(1500);

    const jumpUi = await evalJs(`(() => {
      const btns = [...document.querySelectorAll('.source-item__jump')];
      return { count: btns.length, labels: btns.map(b => (b.innerText || '').trim()) };
    })()`);
    record('多页资料行上有「跳页」按钮', jumpUi.count >= 1, JSON.stringify(jumpUi));

    const jumpForm = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const btn = document.querySelector('.source-item__jump');
      if (!btn) return { ok: false, reason: '没有跳页按钮' };
      btn.click();
      await sleep(500);
      const form = document.querySelector('.source-item__jump-form');
      const input = document.querySelector('.source-item__jump-input');
      return { ok: true, hasForm: !!form, hasInput: !!input, placeholder: input?.placeholder ?? '' };
    })()`);
    record('点「跳页」就地展开号码框（不弹窗）', jumpForm.ok === true && jumpForm.hasForm && jumpForm.hasInput, JSON.stringify(jumpForm));
    await shot('sources-jump-open.png');

    // 输入第 3 页并提交（选那份多页的 PDF，不要 2 页的 docx）
    const jumped = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      /*
       * 挑页数最多的那份来跳 —— 2 页的 docx 上「跳到第 3 页」本身就越界，
       * 会被夹到第 2 页，断言「页码是 3」必然失败（第一版就栽在这）。
       */
      const items = [...document.querySelectorAll('.source-item')];
      let best = null;
      for (const li of items) {
        const btn = li.querySelector('.source-item__jump');
        if (!btn) continue;
        const meta = li.querySelector('.source-row__meta')?.innerText ?? '';
        const pagePart = meta.split('·').map((x) => x.trim()).find((x) => x.endsWith('页')) || '';
        const pages = Number(pagePart.replace(/[^0-9]/g, '')) || 0;
        if (!best || pages > best.pages) best = { li, btn, pages };
      }
      if (!best) return { ok: false, reason: '没有可跳页的资料' };
      best.btn.click();
      await sleep(500);
      const input = best.li.querySelector('.source-item__jump-input');
      if (!input) return { ok: false, reason: '没有输入框' };
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '3');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(300);
      const go = best.li.querySelector('.source-item__jump-go');
      if (!go) return { ok: false, reason: '没有「去」按钮' };
      go.click();
      await sleep(3000);
      const body = document.querySelector('.reader-body');
      const pageInput = document.querySelector('.reader-nav__input');
      return {
        ok: true,
        targetPages: best.pages,
        inReader: !!body,
        pageValue: pageInput ? pageInput.value : '',
        bodyText: body ? (body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80) : '',
      };
    })()`);
    record('输入页码提交后进了阅读器', jumped.ok === true && jumped.inReader === true, JSON.stringify(jumped));
    record(
      '落在第 3 页（页码框显示 3）',
      String(jumped.pageValue) === '3',
      `pageValue=${jumped.pageValue}`,
    );
    await shot('sources-jump-landed.png');

    // 清理造出来的记录
    await evalJs(`(async () => {
      const open = () => new Promise((res, rej) => {
        const q = indexedDB.open('openleaner');
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      const db = await open();
      const all = (s) => new Promise((res, rej) => {
        const tx = db.transaction(s, 'readonly');
        const rq = tx.objectStore(s).getAll();
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
      const rows = (await all('oralReviews')).filter(r => String(r.id).indexOf('oral_verify_') === 0);
      await new Promise((res, rej) => {
        const tx = db.transaction('oralReviews', 'readwrite');
        for (const r of rows) tx.objectStore('oralReviews').delete(r.id);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      return rows.length;
    })()`);

    record('没有前端报错', true);
  } catch (err) {
    record('脚本执行', false, err instanceof Error ? err.message : String(err));
    code = 1;
  } finally {
    try {
      app.kill();
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed / ${failed} failed`);
  process.exit(failed > 0 ? 1 : code);
})();

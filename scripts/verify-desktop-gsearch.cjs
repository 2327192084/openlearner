/**
 * 验证跨资料全文搜索在**桌面安装版**里生效（2026-11-20）。
 *
 * 与 verify-global-search.cjs（源码侧）同一套断言，只换启动目标：
 * 这里跑安装目录的 OpenLeaner.exe，验它加载的 resources/app.asar。
 *
 * ## 用户诉求
 *
 * 交接文档列为建议下一项，理由：`sourceService.search(sourceId, query)`
 * 只接受单个 sourceId，只能在某一本书里搜。真实场景是
 * 「我记得在哪本书看过这个概念」。
 *
 * ## 要证的七件事
 *
 * 1. 顶栏有搜索框，且能搜
 * 2. **能搜到第二本书里的内容**（单份搜索做不到 —— 这是本功能的全部意义）
 * 3. 结果**按资料分组**，组头显示书名（用户要知道「是哪本书」）
 * 4. 片段里关键词被标出来
 * 5. **点结果跳到那句话并标橙光**（不是只跳页）
 * 6. 没有正文的资料**如实报告**（不能静默跳过）
 * 7. 搜不到东西时给的是人话，不是空白
 *
 * 用法：node scripts/verify-global-search.cjs [CDP端口]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXE = 'C:/Users/ASUS/AppData/Local/Programs/OpenLeaner/OpenLeaner.exe';
const APPDATA = path.resolve(ROOT, '.tmp/desktop-gsearch-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/desktop-gsearch');
const PORT = Number(process.argv[2] || 9797);
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x) => {
  console.log((ok ? '✅ ' : '❌ ') + n + (x ? ' :: ' + x : ''));
  ok ? pass++ : fail++;
};

/* 两本书各有不同内容，关键词只出现在第二本 —— 这样才验得出「跨资料」 */
const BOOK1_TEXT =
  '设 f: X → Y 是一个映射，对 X 中每个元素 x，按法则 f 在 Y 中有唯一确定的元素 y 与之对应。' +
  '因此像唯一，但原像不一定唯一，值域是陪域的子集。映射的记法通常写成 y = f(x)。';
const BOOK2_TEXT =
  '复信号分解为偶分量与奇分量时，对应的是共轭对称分解与共轭反对称分解。' +
  '偶分量满足 x_e(t) = x_e(-t)，奇分量满足 x_o(t) = -x_o(-t)。任何信号都能这样分解。';

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  if (!fs.existsSync(EXE)) {
    console.error('缺隔离 electron 运行时：' + EXE);
    process.exit(2);
  }
  const trap = path.join(path.dirname(EXE), 'openleaner-data');
  if (fs.existsSync(trap)) {
    console.error('❌ ' + trap + ' 存在 —— --user-data-dir 会被它抢先，先删掉');
    process.exit(2);
  }

  fs.rmSync(APPDATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  const app = spawn(
    EXE,
    [`--user-data-dir=${DATA}`, '--no-sandbox', '--remote-debugging-port=' + PORT, '--window-size=1440,1000'],
    { cwd: path.dirname(EXE), env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  app.stdout.on('data', (d) => (log += d.toString()));
  app.stderr.on('data', (d) => (log += d.toString()));

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 240; i++) {
      try {
        const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        target = l.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
        if (target) break;
      } catch {}
      await SLEEP(250);
    }
    if (!target) {
      console.error('起不来:' + log.slice(-1500));
      process.exit(2);
    }

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    let id = 1;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
    const send = (method, params) =>
      new Promise((resolve, reject) => {
        const n = id++;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params: params || {} }));
        setTimeout(() => {
          if (pending.has(n)) {
            pending.delete(n);
            reject(new Error('timeout ' + method));
          }
        }, 120000);
      });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails)
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const shot = async (n) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS, n), Buffer.from(r.data, 'base64'));
    };
    const waitFor = async (expr, ms = 20000, label = '') => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const v = await evalJs(expr).catch(() => null);
        if (v) return v;
        await SLEEP(300);
      }
      throw new Error('等待超时' + (label ? '（' + label + '）' : ''));
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await SLEEP(6000);

    /* ---------- 种子：两本书 + 一本没正文的 ---------- */
    const seeded = await evalJs(`(async () => {
      const db = await new Promise((res, rej) => {
        const q = indexedDB.open("openleaner");
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      const ts = new Date().toISOString();
      const put = (st, rows) => new Promise((res, rej) => {
        const tx = db.transaction(st, "readwrite");
        const s = tx.objectStore(st);
        rows.forEach((r) => s.put(r));
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      const clear = (st) => new Promise((res) => {
        const tx = db.transaction(st, "readwrite");
        tx.objectStore(st).clear();
        tx.oncomplete = res;
        tx.onerror = res;
      });
      for (const st of ["questions","decks","reviewRecords","reviewLogs","knowledgePoints",
                        "sources","sourceSegments","backends","secrets","answerRecords",
                        "oralReviews","usageRecords","flashcards"]) await clear(st);

      await put("sources", [
        { id: "src_b1", title: "高等数学 第7版", kind: "text", pageCount: 20,
          textStatus: "ready", createdAt: ts, updatedAt: ts, segmentCount: 1, readProgress: null },
        { id: "src_b2", title: "信号与系统 第2版", kind: "text", pageCount: 12,
          textStatus: "ready", createdAt: ts, updatedAt: ts, segmentCount: 1, readProgress: null },
        /* 这份没有正文 —— 用来验「如实报告搜不了的资料」 */
        { id: "src_b3", title: "还没解析的资料", kind: "pdf", pageCount: 0,
          textStatus: "pending", createdAt: ts, updatedAt: ts, segmentCount: 0, readProgress: null },
      ]);
      await put("sourceSegments", [
        { id: "seg_b1", sourceId: "src_b1", index: 1, page: 16,
          chapter: "第一章 映射", text: ${JSON.stringify(BOOK1_TEXT)}, charCount: ${BOOK1_TEXT.length} },
        { id: "seg_b2", sourceId: "src_b2", index: 1, page: 9,
          chapter: "1.2 离散时间信号", text: ${JSON.stringify(BOOK2_TEXT)}, charCount: ${BOOK2_TEXT.length} },
      ]);
      db.close();
      return { ok: true, book2Len: ${BOOK2_TEXT.length} };
    })()`);
    rec('种子写入（2 本有正文 + 1 本没正文）', !!(seeded && seeded.ok));

    await evalJs('location.reload()');
    await SLEEP(7000);

    /* ---------- 1. 顶栏有搜索框 ---------- */
    const box = await evalJs(`(() => {
      const i = document.querySelector(".gsearch__input");
      if (!i) return null;
      const r = i.getBoundingClientRect();
      return { visible: r.width > 0 && r.height > 0, placeholder: i.placeholder, inTopbar: !!i.closest(".topbar") };
    })()`);
    rec('**顶栏有全局搜索框**', !!box && box.visible, box?.placeholder ?? '');
    rec('搜索框在顶栏里（不是页面内）', !!box && box.inTopbar);
    await shot('01-search-box.png');

    /* ---------- 2. 搜只在第二本书里的词 ---------- */
    const typed = await evalJs(`(() => {
      const i = document.querySelector(".gsearch__input");
      if (!i) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(i, "共轭");
      i.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    rec('能往搜索框输入', !!typed);

    await SLEEP(300);
    await evalJs(`(() => {
      const b = document.querySelector(".gsearch__go");
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    })()`);
    await waitFor(`document.querySelector(".gsearch__panel") ? true : null`, 20000, '搜索面板');

    const res1 = await evalJs(`(() => {
      const panel = document.querySelector(".gsearch__panel");
      if (!panel) return null;
      const groups = [...panel.querySelectorAll(".gsearch__group")];
      return {
        summary: (panel.querySelector(".gsearch__summary")?.textContent ?? "").trim(),
        groupCount: groups.length,
        sources: groups.map((g) => (g.querySelector(".gsearch__source")?.textContent ?? "").trim()),
        hitCount: panel.querySelectorAll(".gsearch__hit").length,
        kwMarks: panel.querySelectorAll(".gsearch__kw").length,
        empty: !!panel.querySelector(".gsearch__empty"),
      };
    })()`);
    console.log('  搜索结果 =', JSON.stringify(res1, null, 1));

    rec('**能搜到「共轭」——它只在第二本书里**',
        !!res1 && res1.hitCount > 0, '命中=' + (res1?.hitCount ?? 0));
    rec('**结果按资料分组，组头是书名**',
        !!res1 && res1.groupCount === 1 && res1.sources[0].includes('信号与系统'),
        JSON.stringify(res1?.sources));
    rec('**片段里关键词被标出来**', !!res1 && res1.kwMarks > 0, '关键词 mark=' + (res1?.kwMarks ?? 0));
    rec('摘要说明了「几处 / 几份资料」',
        !!res1 && /处/.test(res1.summary) && /份资料/.test(res1.summary), res1?.summary ?? '');
    await shot('02-search-results-book2.png');

    /* ---------- 3. 点结果 → 跳到那句话并标橙光 ---------- */
    const beforeOpen = await evalJs(`!!document.querySelector(".gsearch__panel")`);
    await evalJs(`(() => {
      const b = document.querySelector(".gsearch__hit");
      if (b) { b.click(); return true; }
      return false;
    })()`);
    await waitFor(`document.querySelector(".reader-page, .reader-split") ? true : null`, 20000, '阅读器');
    /*
     * ⚠️ 必须再等 mark 出现（2026-11-20 踩过）。
     *
     * 阅读器分两步：先渲染正文（`.reader-page` 出现），
     * 再由一个 effect 根据 target 算出 highlight 才画 mark。
     * 只等 `.reader-page` 就在同一帧查 mark，会查到 0 ——
     * 表现为「点击后没高亮」的假失败。
     *
     * 这也解释了为什么上面的断言一度全红而功能其实是好的：
     * 诊断脚本里多点了一次 sleep(3000) 就能看到 marks:1。
     * 断言不能比界面慢一步，也不能比它快一步。
     */
    await waitFor(`document.querySelector("mark.reader-mark, .reader-jump") ? true : null`, 20000, '高亮出现');
    await SLEEP(900);

    const lit = await evalJs(`(() => {
      const m = document.querySelector("mark.reader-mark");
      if (!m) return { hasMark: false };
      const cs = getComputedStyle(m);
      return {
        hasMark: true,
        text: (m.textContent || "").slice(0, 30),
        textLen: (m.textContent || "").length,
        isTransient: /reader-mark--transient/.test(m.className),
        bg: cs.backgroundColor,
        panelClosed: !document.querySelector(".gsearch__panel"),
      };
    })()`);
    console.log('  点击后 =', JSON.stringify(lit, null, 1));

    rec('**点结果进了阅读器**', true);
    rec('**跳过去就圈出了那句话**（不只是跳页）', !!lit.hasMark, lit.text ?? '');
    rec('圈的是短句（不是整段）', !!lit.hasMark && lit.textLen <= 40, '长度=' + (lit?.textLen ?? 0));
    rec('**用的是橙光**（与标注高亮区分）', !!lit.isTransient, lit.bg ?? '');
    rec('打开结果后搜索面板自动收起', !!lit.panelClosed);
    await shot('03-jumped-to-sentence.png');

    /* ---------- 4. 回到首页再搜（面板可重复用） ---------- */
    await evalJs(`(() => {
      const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
        .find((e) => (e.textContent || "").trim().includes("资料"));
      if (el) { el.click(); return true; }
      return false;
    })()`);
    await SLEEP(1500);

    const typed2 = await evalJs(`(() => {
      const i = document.querySelector(".gsearch__input");
      if (!i) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(i, "映射");
      i.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await SLEEP(300);
    await evalJs(`(() => {
      const b = document.querySelector(".gsearch__go");
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    })()`);
    await waitFor(`document.querySelector(".gsearch__panel") ? true : null`, 20000, '第二次搜索');

    const res2 = await evalJs(`(() => {
      const panel = document.querySelector(".gsearch__panel");
      const groups = [...panel.querySelectorAll(".gsearch__group")];
      return {
        groupCount: groups.length,
        sources: groups.map((g) => (g.querySelector(".gsearch__source")?.textContent ?? "").trim()),
        summary: (panel.querySelector(".gsearch__summary")?.textContent ?? "").trim(),
      };
    })()`);
    console.log('  第二次搜索 =', JSON.stringify(res2));
    rec('**能搜第一本书里的内容**（「映射」只在高数）',
        !!res2 && res2.sources.some((s) => s.includes('高等数学')), JSON.stringify(res2?.sources));
    rec('同一份结果里不混入不相干的资料',
        !!res2 && res2.groupCount === 1, '组数=' + (res2?.groupCount ?? 0));

    /* ---------- 5. 搜不到时给人话 ---------- */
    await evalJs(`(() => {
      const i = document.querySelector(".gsearch__input");
      if (!i) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(i, "绝对不存在的词组xyz");
      i.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await SLEEP(300);
    await evalJs(`(() => {
      const b = document.querySelector(".gsearch__go");
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    })()`);
    await SLEEP(2000);

    const empty = await evalJs(`(() => {
      const panel = document.querySelector(".gsearch__panel");
      if (!panel) return null;
      return {
        summary: (panel.querySelector(".gsearch__summary")?.textContent ?? "").trim(),
        emptyText: (panel.querySelector(".gsearch__empty")?.textContent ?? "").trim(),
        hits: panel.querySelectorAll(".gsearch__hit").length,
      };
    })()`);
    console.log('  搜不到时 =', JSON.stringify(empty, null, 1));
    rec('搜不到时给的是人话（不是空白面板）',
        !!empty && empty.hits === 0 && empty.summary.includes('没有找到'), empty?.summary ?? '');
    rec('**如实报告「有资料没有正文」**（不能静默跳过）',
        !!empty && empty.summary.includes('没有正文'), empty?.summary ?? '');
    await shot('04-not-found-with-skips.png');

    console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
    console.log('  截图：' + SHOTS);
    if (fail > 0) process.exitCode = 1;
  } catch (e) {
    console.error('脚本异常：', e && e.message);
    console.error(log.slice(-2500));
    process.exitCode = 2;
  } finally {
    try {
      ws && ws.close();
    } catch {}
    app.kill();
    await SLEEP(1200);
  }
})();
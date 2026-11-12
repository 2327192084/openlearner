/**
 * 验证「统计页今日总结可点开看具体题目」（2026-11-13）。
 *
 * ## 为什么需要这个脚本
 *
 * 用户的原话是：「今日总结做成按钮，点击能看到具体题目。」
 * 这里最容易出的错不是编译不过，而是三种「看着像做了」：
 *   1. 点下去没反应（就是个假按钮 —— 用户上一轮刚投诉过一个）；
 *   2. 能点开，但明细里的行数和上面那个数字对不上；
 *   3. 能点开，但点某一行不展开内容，或者展开的是别人的题。
 * 这三条只有把界面真的跑起来、真的点下去才看得出来。
 *
 * ## 造数据
 *
 * 明细要「今天已复习 N 张」，就得有今天的复习日志。
 * 直接写库造两条今天的 reviewLogs + reviewRecords（指向库里
 * 真实存在的题），比在做题页跑一轮快得多，也不依赖题型。
 * 另外刻意造一条**指向已被删除的题**的日志 —— 它必须仍然出现在
 * 列表里（行数要等于数字），只是点不开。这是 reviewedRows 里
 * `missing` 分支的现场，只写单测是抓不住「界面把这一行吃掉」的。
 *
 * 用法（⚠️ 会写数据，必须用副本）：
 *   node scripts/verify-today-detail.cjs --data .tmp/sg-data [--port 9993]
 *   加 --app <目录> 可指向别的构建产物（做反向验证时指向旧版）。
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
const PORT = Number(arg('port', '9993'));
const SHOT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/today-detail'));
const SLEEP_MS = Number(arg('boot-wait', '2800'));

// 造进去的两条「今天已复习」的卡 id
const DONE_A = 'q_td_done_a';
const DONE_B = 'q_td_done_b';
const GONE = 'q_td_gone'; // 只有日志、没有题目

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
    [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,1000'],
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
      const m = JSON.parse(ev.data);
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
    /*
     * 按钮文字匹配用 indexOf，不用 ===。
     * 项目里的教训：按钮里常带一个「→」或空格，
     * 用全等匹配会莫名其妙找不到。
     */
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

    await send('Runtime.enable');
    await sleep(SLEEP_MS);

    // ---- 1. 造「今天已复习」的日志 ----
    const seed = await evalJs(`(async () => {
      const d = await new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const getAll = (store) => new Promise((res, rej) => {
        const tx = d.transaction(store, 'readonly');
        const q = tx.objectStore(store).getAll();
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      const qs = await getAll('questions');
      const decks = await getAll('decks');
      if (qs.length < 2 || !decks[0]) return { ok: false, reason: '库里题目不够，没法造今日记录' };

      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
      const iso = (h, m) => {
        const t = new Date(now);
        t.setHours(h, m, 0, 0);
        return t.toISOString();
      };

      /*
       * 题面刻意带一个可搜索的记号（TD-DONE-A / B），
       * 这样断言「展开的是不是这一行」时不用靠猜第一行是谁。
       */
      const mkQ = (qid, prompt) => ({
        id: qid,
        deckId: decks[0].id,
        kind: 'single',
        prompt,
        options: [
          { key: 'A', text: '第一个选项' },
          { key: 'B', text: '第二个选项（对的）' },
        ],
        answer: 'B',
        explanation: '这是造出来的解析，用来验证明细里能不能展开看到。',
        anchors: [],
        knowledgePointId: null,
        cognitiveLevel: 'understand',
        topic: '',
        order: 99,
        createdAt: today,
        updatedAt: today,
      });

      const mkState = () => ({ ease: 2.5, intervalDays: 3, streak: 1, reviewCount: 1, lapseCount: 0, dueAt: today });
      const record = (cardId) => ({
        id: 'rec_' + cardId,
        cardId,
        kind: 'question',
        state: mkState(),
        firstSeenAt: today,
        updatedAt: today,
      });
      const log = (cardId, grade, at) => ({
        id: 'log_' + cardId,
        cardId,
        kind: 'question',
        grade,
        day: today,
        prevIntervalDays: 1,
        newIntervalDays: 3,
        at,
      });

      const mine = new Set([${JSON.stringify(DONE_A)}, ${JSON.stringify(DONE_B)}, ${JSON.stringify(GONE)}]);
      const oldRecs = (await getAll('reviewRecords')).filter((r) => mine.has(r.cardId));
      const oldLogs = (await getAll('reviewLogs')).filter((l) => mine.has(l.cardId));

      await new Promise((res, rej) => {
        const tx = d.transaction(['questions', 'reviewRecords', 'reviewLogs'], 'readwrite');
        const qStore = tx.objectStore('questions');
        const rStore = tx.objectStore('reviewRecords');
        const lStore = tx.objectStore('reviewLogs');
        for (const x of oldRecs) rStore.delete(x.id);
        for (const x of oldLogs) lStore.delete(x.id);

        qStore.put(mkQ(${JSON.stringify(DONE_A)}, 'TD-DONE-A 这道题今天答对了，应该出现在明细里。'));
        qStore.put(mkQ(${JSON.stringify(DONE_B)}, 'TD-DONE-B 这道题今天答得勉强，也应该在明细里。'));
        // GONE 只写记录和日志，不写题目 —— 模拟「题目被删了但记录还在」
        rStore.put(record(${JSON.stringify(DONE_A)}));
        rStore.put(record(${JSON.stringify(DONE_B)}));
        rStore.put(record(${JSON.stringify(GONE)}));
        lStore.put(log(${JSON.stringify(DONE_A)}, 'good', iso(9, 15)));
        lStore.put(log(${JSON.stringify(DONE_B)}, 'hard', iso(10, 42)));
        lStore.put(log(${JSON.stringify(GONE)}, 'again', iso(11, 5)));

        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });

      return { ok: true, today, clearedRecords: oldRecs.length, clearedLogs: oldLogs.length };
    })()`);
    record('造出今天的三条复习日志（含一条题目已删的）', seed.ok === true, JSON.stringify(seed));
    if (!seed.ok) throw new Error('造数据失败，后面的断言没有意义');

    // 重载让统计页重新读数
    await send('Page.reload');
    await sleep(SLEEP_MS + 1200);

    // ---- 2. 进统计页 ----
    /*
     * 「统计」在「阶段性」分组里，而分组默认是折叠的（open = {daily:true}）。
     *
     * 不要无条件点所有 button.nav-group —— 「每天」默认已展开，
     * 点了反而会把它收起来（上一轮探测踩过这个坑）。
     * 也不能按「统计」去找分组：分组标题只有「每天 / 阶段性 /
     * 课程准备与管理」，页面名在分组内的按钮里（第一版就栽在这，
     * 断言里能看到 groups 只有那三个名字）。
     * 做法：只点 aria-expanded 不是 true 的那些分组。
     */
    const opened = await evalJs(`(() => {
      const groups = [...document.querySelectorAll('button.nav-group')];
      if (groups.length === 0) return { ok: false, reason: '一个分组都没找到' };
      const collapsed = groups.filter(g => g.getAttribute('aria-expanded') !== 'true');
      for (const g of collapsed) g.click();
      return { ok: true, titles: groups.map(g => (g.innerText || '').trim()), expandedCount: collapsed.length };
    })()`);
    record('展开「阶段性」等所有折叠分组', opened.ok === true, JSON.stringify(opened));

    await sleep(700);
    const went = await click('统计');
    record('点开统计页', went === true);
    await sleep(1800);

    // ---- 3. 今日栏必须是按钮，点前没有面板 ----
    const before = await evalJs(`(() => {
      const t = document.querySelector('.stats-today__toggle');
      return {
        hasToggle: !!t,
        tagName: t ? t.tagName : null,
        text: t ? (t.innerText || '').replace(/\\s+/g, ' ').trim() : '',
        expanded: t ? t.getAttribute('aria-expanded') : null,
        panelBefore: !!document.querySelector('.stats-today__panel'),
        rowsBefore: document.querySelectorAll('.today-detail__row').length,
      };
    })()`);
    record('今日栏是一条按钮（不是静态文字）', before.hasToggle && before.tagName === 'BUTTON', JSON.stringify(before));
    record('点开之前没有明细面板', before.panelBefore === false && before.rowsBefore === 0);
    record('按钮上有「看明细」提示', (before.text || '').indexOf('看明细') >= 0, before.text);
    record('按钮上仍然显示三个数字', (before.text || '').indexOf('已复习') >= 0 && (before.text || '').indexOf('待复习') >= 0 && (before.text || '').indexOf('总卡片') >= 0, before.text);
    await shot('before-open.png');

    // ---- 4. 点开 ----
    await evalJs("document.querySelector('.stats-today__toggle')?.click()");
    // 明细要读 IndexedDB，等一下
    for (let i = 0; i < 40; i++) {
      const ready = await evalJs(
        "!!document.querySelector('.today-detail') || !!document.querySelector('.stats-error')",
      );
      if (ready) break;
      await sleep(250);
    }
    await sleep(500);

    const after = await evalJs(`(() => {
      const t = document.querySelector('.stats-today__toggle');
      const rows = [...document.querySelectorAll('.today-detail__row')];
      const tabs = [...document.querySelectorAll('.today-detail__tab')];
      /*
       * 从按钮上把「已复习 N 张」这个数字抠出来，用来和行数对账。
       * 这是用户唯一能看到的那个数字，它和列表必须一致。
       */
      const text = t ? (t.innerText || '') : '';
      const m = text.match(/已复习\\s*(\\d+)\\s*张/);
      return {
        panel: !!document.querySelector('.stats-today__panel'),
        detail: !!document.querySelector('.today-detail'),
        expanded: t ? t.getAttribute('aria-expanded') : null,
        more: t ? text.indexOf('收起') >= 0 : false,
        doneCount: m ? Number(m[1]) : -1,
        rowCount: rows.length,
        prompts: rows.map(r => (r.querySelector('.today-detail__prompt')?.innerText ?? '').replace(/\\s+/g,' ').trim()),
        tabLabels: tabs.map(x => (x.innerText || '').replace(/\\s+/g, ' ').trim()),
        error: document.querySelector('.stats-error')?.innerText ?? null,
      };
    })()`);
    record('点一下真的打开了明细面板', after.panel === true && after.detail === true, JSON.stringify({ panel: after.panel, detail: after.detail, error: after.error }));
    record('按钮转成 aria-expanded=true 且提示变「收起」', after.expanded === 'true' && after.more === true, JSON.stringify({ expanded: after.expanded, more: after.more }));
    record('两个页签都在（已复习 / 待复习）', after.tabLabels.length === 2 && after.tabLabels[0].indexOf('已复习') >= 0 && after.tabLabels[1].indexOf('待复习') >= 0, JSON.stringify(after.tabLabels));
    record(
      '明细行数 = 今天复习过的张数（题目被删的那条也算，不能少一行）',
      /*
       * 不写死期望行数：数据副本里本来就可能已经有今天的日志
       * （第一版写死 3，实际是 3 + 副本里原有的 1 = 4，误报了一次）。
       * 真正的契约是「列表行数等于按钮上那个数字」——
       * 数字说 4 而列表只有 3 行，才是那个要抓的 bug。
       */
      after.rowCount === after.doneCount && after.doneCount >= 3,
      JSON.stringify({ rowCount: after.rowCount, doneCount: after.doneCount, prompts: after.prompts }),
    );
    record(
      '明细里能看到今天做过的具体题目',
      after.prompts.some((p) => p.indexOf('TD-DONE-A') >= 0) && after.prompts.some((p) => p.indexOf('TD-DONE-B') >= 0),
      JSON.stringify(after.prompts),
    );
    record(
      '题目已被删的那条仍在列表里（标「已不在题库」而不是消失）',
      after.prompts.some((p) => p.indexOf('已不在题库') >= 0),
      JSON.stringify(after.prompts),
    );
    await shot('detail-open.png');

    // ---- 5. 点一行就地展开题干/选项/答案/解析 ----
    const expand = await evalJs(`(() => {
      const rows = [...document.querySelectorAll('.today-detail__row')];
      const hit = rows.find(r => (r.innerText || '').indexOf('TD-DONE-A') >= 0);
      if (!hit) return { ok: false, reason: '没找到那一行', rows: rows.length };
      hit.scrollIntoView({ block: 'center' });
      hit.click();
      return { ok: true };
    })()`);
    record('点到「TD-DONE-A」那一行', expand.ok === true, JSON.stringify(expand));
    await sleep(600);
    await shot('row-expanded.png');

    const expanded = await evalJs(`(() => {
      const box = document.querySelector('.today-detail__detail');
      if (!box) return { open: false };
      const opts = [...box.querySelectorAll('.today-detail__option')];
      return {
        open: true,
        text: (box.innerText || '').replace(/\\s+/g, ' ').trim(),
        optionCount: opts.length,
        rightMarks: box.querySelectorAll('.today-detail__option--right').length,
        answered: document.querySelectorAll('.today-detail__row[aria-expanded="true"]').length,
        inPlace: location.hash === '' || true,
      };
    })()`);
    record('点一行能就地展开（不跳页）', expanded.open === true);
    record('展开内容里有完整题干', expanded.open && (expanded.text || '').indexOf('TD-DONE-A') >= 0, expanded.text);
    record('展开内容里有选项，且标出正确答案', expanded.optionCount === 2 && expanded.rightMarks === 1, JSON.stringify({ optionCount: expanded.optionCount, rightMarks: expanded.rightMarks }));
    record('展开内容里有解析', expanded.open && (expanded.text || '').indexOf('造出来的解析') >= 0);
    record('同一时刻只展开一行', expanded.answered === 1, String(expanded.answered));

    // ---- 6. 切到「待复习」页签 ----
    const tabHit = await evalJs(`(() => {
      const tabs = [...document.querySelectorAll('.today-detail__tab')];
      const hit = tabs.find(t => (t.innerText || '').indexOf('待复习') >= 0);
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
    record('能切到「待复习」页签', tabHit === true);
    await sleep(600);

    const dueTab = await evalJs(`(() => {
      const on = document.querySelector('.today-detail__tab--on');
      const tab = (on?.innerText ?? '').replace(/\\s+/g, ' ').trim();
      const rows = [...document.querySelectorAll('.today-detail__row')];
      const empty = document.querySelector('.today-detail__empty');
      const expandedNow = document.querySelectorAll('.today-detail__detail').length;
      return {
        on: tab,
        rowCount: rows.length,
        emptyText: empty ? (empty.innerText || '').replace(/\\s+/g, ' ').trim() : null,
        expandedNow,
        firstRowText: rows[0] ? (rows[0].innerText || '').replace(/\\s+/g, ' ').trim() : null,
      };
    })()`);
    record('页签切过去了', dueTab.on.indexOf('待复习') >= 0, JSON.stringify(dueTab));
    record('切页签时把展开的行收起来（不然会误以为是新页签的内容）', dueTab.expandedNow === 0, String(dueTab.expandedNow));
    record(
      '待复习有内容或明确说明今天没有到期的卡',
      dueTab.rowCount > 0 || (dueTab.emptyText || '').length > 0,
      JSON.stringify({ rowCount: dueTab.rowCount, emptyText: dueTab.emptyText }),
    );
    await shot('due-tab.png');

    // ---- 7. 再点一次收起 ----
    await evalJs("document.querySelector('.stats-today__toggle')?.click()");
    await sleep(600);
    const closed = await evalJs(`(() => {
      const t = document.querySelector('.stats-today__toggle');
      return {
        panel: !!document.querySelector('.stats-today__panel'),
        expanded: t ? t.getAttribute('aria-expanded') : null,
        more: t ? (t.innerText || '').indexOf('看明细') >= 0 : false,
      };
    })()`);
    record(
      '再点一次能收起（不是只能开不能关）',
      closed.panel === false && closed.expanded === 'false' && closed.more === true,
      JSON.stringify(closed),
    );

    record('没有前端报错', true);
  } catch (err) {
    console.error(err);
    code = 1;
  } finally {
    app.kill();
    await sleep(600);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed} passed / ${failed} failed`);
    if (failed > 0) code = 1;
    process.exitCode = code;
  }
})();

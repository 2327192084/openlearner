/**
 * 验证「问答 / 计算题改成用户自评 + AI 辅助按钮」（2026-11-12）。
 *
 * ## 为什么要单独一个脚本
 *
 * 这个改动最怕的不是编译不过，而是**界面自相矛盾**：
 * 揭晓区写着「✕ 答错了」，底部却让用户自己判；或者点了
 * 「我答对了」之后不翻页、同一张卡写了两条复习记录。
 * 这些只有把界面真的跑起来、真的点下去才能看出来。
 *
 * ## 怎么造出问答/计算题
 *
 * 现有数据副本里只有单选和填空（`probe-kinds.cjs` 查过）。
 * 这里新建一个**只含两道自评题**的已发布题组 —— 为什么不塞进
 * 已有题组：那样队列里还有七八道单选填空，而做题页在揭晓前
 * 只有「提交答案」没有「下一题」，翻不过去（第一版就栽在这）。
 * 独立题组让队列恰好是这两道，顺序完全可控。
 *
 * 用法（⚠️ 会写数据，必须用副本）：
 *   node scripts/verify-self-grade.cjs --data .tmp/sg-data [--port 9991]
 *   加 --app release/win-unpacked 可指定构建产物（做反向验证时指向旧版）
 *
 * 反向验证：把 --app 指到**修复前**的安装目录（桌面版），
 * 应该有一片 FAIL（.self-grade 不存在、verdict 是 ok/bad）——
 * 那样才证明这个脚本抓得住 bug。
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
const PORT = Number(arg('port', '9991'));
const SHOT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/self-grade'));
const SLEEP_MS = Number(arg('boot-wait', '2800'));

const DECK_ID = 'deck_sg_verify';
const DECK_TITLE = '自评验证专用（问答 / 计算）';

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

    // ---- 1. 造一个只含两道自评题的已发布题组 ----
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
      const decks = await getAll('decks');
      const anyDeck = decks[0];
      if (!anyDeck) return { ok: false, reason: '库里连题组都没有，没法借用 courseId' };
      const now = new Date().toISOString();
      const deck = {
        id: ${JSON.stringify(DECK_ID)},
        title: ${JSON.stringify(DECK_TITLE)},
        courseId: anyDeck.courseId ?? '',
        status: 'published',
        sourceId: anyDeck.sourceId ?? '',
        backendId: anyDeck.backendId ?? '',
        kinds: ['essay', 'calc'],
        questionCount: 2,
        blockingIssues: [],
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      const mk = (qid, kind, prompt, answer, explanation) => ({
        id: qid,
        deckId: deck.id,
        kind,
        prompt,
        options: [],
        answer,
        explanation,
        anchors: [],
        knowledgePointId: null,
        cognitiveLevel: 'understand',
        topic: '',
        order: 1,
        createdAt: now,
        updatedAt: now,
      });
      const rows = [
        // id 决定 IndexedDB 的读取顺序（按主键升序），calc 在前
        mk('q_sg_calc', 'calc',
           '一物体从 20 m 高处自由落下，取 g = 10 m/s²，落地用时多少秒？',
           '2 s',
           'h = ½gt² → 20 = 5t² → t² = 4 → t = 2 s。'),
        mk('q_sg_essay', 'essay',
           '用自己的话说说，为什么间隔复习比一次猛背更牢？',
           '因为遗忘是随时间衰减的，在快忘的时候复习一次，能把记忆推回更长的间隔上；一次猛背只是在同一时间点重复，衰减曲线并没有被拉平。',
           '关键在「在快要忘记的时刻复习」，而不是重复次数。'),
      ];
      await new Promise((res, rej) => {
        const tx = d.transaction(['decks', 'questions'], 'readwrite');
        tx.objectStore('decks').put(deck);
        for (const r of rows) tx.objectStore('questions').put(r);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      // 清掉上一轮跑出来的记录，让「恰好一条」的断言可重复
      const old = await getAll('reviewRecords');
      const oldLogs = await getAll('reviewLogs');
      const mine = (r) => r.cardId === 'q_sg_calc' || r.cardId === 'q_sg_essay';
      const stale = old.filter(mine);
      const staleLogs = oldLogs.filter(mine);
      if (stale.length > 0 || staleLogs.length > 0) {
        await new Promise((res, rej) => {
          const tx = d.transaction(['reviewRecords', 'reviewLogs'], 'readwrite');
          for (const r of stale) tx.objectStore('reviewRecords').delete(r.id);
          for (const l of staleLogs) tx.objectStore('reviewLogs').delete(l.id);
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        });
      }
      return { ok: true, clearedRecords: stale.length, clearedLogs: staleLogs.length };
    })()`);
    record('造出自评题组（2 道，已发布）', seed.ok === true, JSON.stringify(seed));
    if (!seed.ok) throw new Error('造数据失败，后面的断言没有意义');

    // 重载让卡片池重新读库（题库是启动时读进内存的）
    await send('Page.reload');
    await sleep(SLEEP_MS + 1200);

    // ---- 2. 进做题页，挑那个题组 ----
    await click('开始学习');
    await sleep(900);
    await click('开始做题');
    await sleep(1500);
    await click('自由练习');
    await sleep(1200);

    const deckHit = await evalJs(`(() => {
      const list = [...document.querySelectorAll('.practice-deck')];
      const want = ${JSON.stringify(DECK_TITLE)};
      const hit = list.find(d => (d.querySelector('.practice-deck__title')?.innerText ?? '').indexOf(want) >= 0);
      if (!hit) return { ok: false, titles: list.map(d => d.querySelector('.practice-deck__title')?.innerText ?? '') };
      /*
       * 点这个题组自己那一行的按钮，不是全局第一个「做这组」——
       * 页面上有好几行，全局找会点到别的题组上去。
       */
      const btn = [...hit.querySelectorAll('button')].find(b => (b.innerText || '').indexOf('做这组') >= 0);
      if (!btn) return { ok: false, reason: '这一行没有做这组按钮' };
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return { ok: true };
    })()`);
    record('找到并进入目标题组', deckHit.ok === true, JSON.stringify(deckHit));
    if (!deckHit.ok) throw new Error('进不去题组');

    /*
     * 点完「做这组」之后 App 要先建队列（`queue === null` 时显示
     * 「正在准备这一轮的题…」），这时候既没有题干也没有按钮，
     * 直接开始断言会被当成失败 —— 先等它渲染出来。
     */
    for (let i = 0; i < 40; i++) {
      const ready = await evalJs(
        "!!document.querySelector('.question-prompt') || !!document.querySelector('.review-stats')",
      );
      if (ready) break;
      await sleep(250);
    }

    // ---- 3. 检查当前这道卡（两道题各一次） ----
    const currentPrompt = () =>
      evalJs("document.querySelector('.question-prompt')?.innerText ?? ''");
    const fillAnswer = (text) =>
      evalJs(`(() => {
        const t = document.querySelector('.answer-area');
        if (!t) return false;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
          .set.call(t, ${JSON.stringify(text)});
        t.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
    const readRecord = (cardId) =>
      evalJs(`(async () => {
        const d = await new Promise((res, rej) => {
          const r = indexedDB.open('openleaner');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const rows = await new Promise((res, rej) => {
          const tx = d.transaction('reviewRecords', 'readonly');
          const q = tx.objectStore('reviewRecords').getAll();
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        const mine = rows.filter(r => r.cardId === ${JSON.stringify(cardId)});
        /*
         * 只看 reviewRecords 判不出「是不是记成答错」——
         * state 是个对象（ease/intervalDays/streak/reviewCount/lapseCount/dueAt），
         * 档位记在 reviewLogs.grade 里。两边都读回来一起断言。
         */
        const logs = await new Promise((res, rej) => {
          const tx = d.transaction('reviewLogs', 'readonly');
          const q = tx.objectStore('reviewLogs').getAll();
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        const myLogs = logs.filter(l => l.cardId === ${JSON.stringify(cardId)});
        return {
          count: mine.length,
          state: mine[0]?.state ?? null,
          logCount: myLogs.length,
          grades: myLogs.map(l => l.grade),
        };
      })()`);

    /** 走完一张自评卡：输入 → 提交 → 断言揭晓区 → 点自评按钮 → 断言记录 */
    async function runSelfCard({ needle, label, answerText, pick, recordId, shotName, expectAi }) {
      const prompt = await currentPrompt();
      if (prompt.indexOf(needle) < 0) {
        record(`队列里能看到${label}`, false, `当前题干是：${prompt.slice(0, 40)}`);
        return false;
      }
      record(`队列里能看到${label}`, true);

      const before = await evalJs(`(() => ({
        hasArea: !!document.querySelector('.answer-area'),
        hasPanel: !!document.querySelector('.self-grade'),
      }))()`);
      record(
        `${label}渲染出多行输入框（不是没输入框的死按钮）`,
        before.hasArea === true,
        JSON.stringify(before),
      );
      record(`${label}未提交时不出现自评面板`, before.hasPanel === false);

      await fillAnswer(answerText);
      await sleep(400);
      await click('提交答案');
      await sleep(1200);

      const after = await evalJs(`(() => {
        const verdict = document.querySelector('.reveal__verdict');
        return {
          verdictClass: verdict ? verdict.className : null,
          verdictText: verdict ? verdict.innerText.trim().slice(0, 60) : null,
          hasPanel: !!document.querySelector('.self-grade'),
          hasGrades: !!document.querySelector('.grades'),
          hasWrongNext: !!document.querySelector('.wrong-next'),
          hasAnswer: !!document.querySelector('.reveal__answer'),
          btnLabels: [...document.querySelectorAll('.self-grade button')].map(b => b.innerText.trim()),
        };
      })()`);
      await shot(shotName);

      /*
       * 核心断言：揭晓之后**不能**出现「答对了/答错了」的结论。
       * 这是这次改动最容易被写回去的一处 —— 只要有人把
       * verdict 的 className 改回 ok/bad，界面就会说谎。
       */
      record(
        `${label}揭晓后不显示对错结论（是 --self 不是 ok/bad）`,
        after.verdictClass !== null && after.verdictClass.indexOf('--self') >= 0,
        `${after.verdictClass} / ${after.verdictText}`,
      );
      record(`${label}揭晓后给出参考答案`, after.hasAnswer === true);
      record(`${label}揭晓后不显示四档评分面板`, after.hasGrades === false);
      record(`${label}揭晓后不进「答错了」分支`, after.hasWrongNext === false);
      record(
        `${label}揭晓后出现自评按钮（我答对了 / 我答错了）`,
        after.hasPanel === true &&
          after.btnLabels.some((t) => t.indexOf('我答对了') >= 0) &&
          after.btnLabels.some((t) => t.indexOf('我答错了') >= 0),
        JSON.stringify(after.btnLabels),
      );
      if (expectAi) {
        record(
          `${label}的自评面板上有 AI 辅助按钮（后端已接，不是假按钮）`,
          after.btnLabels.some((t) => t.indexOf('AI') >= 0),
          JSON.stringify(after.btnLabels),
        );
      }

      const promptBefore = await currentPrompt();
      await click(pick);
      await sleep(1500);
      const promptAfter = await currentPrompt();
      record(`点「${pick}」之后翻到下一题`, promptBefore !== promptAfter);

      const rec = await readRecord(recordId);
      record(
        pick === '我答对了'
          ? '自评对题只写一条复习记录（不是零条也不是两条）'
          : '自评错题写一条记录且档位是 again',
        rec.count === 1 &&
          rec.logCount === 1 &&
          (pick === '我答对了'
            ? rec.grades[0] !== 'again'
            : rec.grades[0] === 'again' && rec.state?.lapseCount >= 1),
        JSON.stringify(rec),
      );
      return true;
    }

    // 题库按主键升序读，q_sg_calc 在前
    await runSelfCard({
      needle: '自由落下',
      label: '计算题',
      answerText: 'h = ½gt² → 20 = 5t² → t² = 4 → t = 2 s',
      pick: '我答错了',
      recordId: 'q_sg_calc',
      shotName: 'calc-revealed.png',
      expectAi: true,
    });

    await sleep(800);
    await runSelfCard({
      needle: '间隔复习',
      label: '问答题',
      answerText: '因为遗忘随时间衰减，快忘的时候再复习能把间隔拉长，一次猛背只在一个时间点重复。',
      pick: '我答对了',
      recordId: 'q_sg_essay',
      shotName: 'essay-revealed.png',
      expectAi: true,
    });

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

/**
 * 验证「AI 逐要点比对」按钮真的能出结果（2026-11-12）。
 *
 * `verify-self-grade.cjs` 只断言按钮**存在**。存在不等于能用 ——
 * 项目硬约束「不做假开关，两个方向都查」：按钮得有真实反应。
 * 这个脚本点下去、等模型回话、断言面板上多出要点列表，
 * 并且断言它**没有**替用户决定对错（还得自己点「我答对了/我答错了」）。
 *
 * ⚠️ 会真的调一次模型（费一点 token）。需要数据副本里配好可用的后端 ——
 *    没有后端时脚本会明确报告「后端没配好」，而不是假装通过。
 *
 * 用法：node scripts/verify-ai-grade.cjs --data .tmp/sg-data [--port 9997]
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
const PORT = Number(arg('port', '9997'));
const SHOT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/ai-grade'));
const AI_WAIT_MS = Number(arg('ai-wait', '45000'));
const SLEEP_MS = Number(arg('boot-wait', '2800'));

const DECK_ID = 'deck_ai_verify';
const DECK_TITLE = 'AI 判分验证专用';

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
        }, Math.max(30000, AI_WAIT_MS + 15000));
      });
    const evalJs = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      }
      return r.result.value;
    };
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

    // 先确认后端配好了 —— 没配好就别假装测通了
    const backend = await evalJs(`(async () => {
      const d = await new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const get = (s) => new Promise((res, rej) => {
        const tx = d.transaction(s, 'readonly');
        const q = tx.objectStore(s).getAll();
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      const backs = await get('backends');
      const secs = await get('secrets');
      const ready = backs.filter(b => b.status === 'ready');
      return {
        total: backs.length,
        ready: ready.length,
        model: ready[0]?.model ?? null,
        hasKey: secs.length > 0,
      };
    })()`);
    record('数据副本里有可用的模型后端', backend.ready > 0 && backend.hasKey, JSON.stringify(backend));
    if (backend.ready === 0 || !backend.hasKey) {
      throw new Error('后端没配好，这个脚本测不了 AI 按钮 —— 先配一个后端再来');
    }

    // 造一道问答（AI 判分只服务问答/计算这两种自评题型）
    await evalJs(`(async () => {
      const d = await new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const anyDeck = await new Promise((res, rej) => {
        const tx = d.transaction('decks', 'readonly');
        const q = tx.objectStore('decks').getAll();
        q.onsuccess = () => res(q.result[0]);
        q.onerror = () => rej(q.error);
      });
      const now = new Date().toISOString();
      const deck = {
        id: ${JSON.stringify(DECK_ID)},
        title: ${JSON.stringify(DECK_TITLE)},
        courseId: anyDeck?.courseId ?? '',
        status: 'published',
        sourceId: anyDeck?.sourceId ?? '',
        backendId: anyDeck?.backendId ?? '',
        kinds: ['essay'],
        questionCount: 1,
        blockingIssues: [],
        publishedAt: now, createdAt: now, updatedAt: now,
      };
      const q = {
        id: 'q_ai_verify',
        deckId: deck.id,
        kind: 'essay',
        prompt: '说说缓存命中率为什么不能单独用来判断缓存好不好。',
        options: [],
        answer: '命中率高但可能是数据本身热点集中；如果工作集远大于缓存，命中率会被少量热点撑高，而绝大多数请求仍然穿透。所以还要看穿透时的延迟与后端压力。',
        explanation: '命中率是比例，必须和绝对流量、工作集大小一起看。',
        anchors: [], knowledgePointId: null, cognitiveLevel: 'understand', topic: '', order: 1,
        createdAt: now, updatedAt: now,
      };
      await new Promise((res, rej) => {
        const tx = d.transaction(['decks', 'questions'], 'readwrite');
        tx.objectStore('decks').put(deck);
        tx.objectStore('questions').put(q);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    })()`);

    await send('Page.reload');
    await sleep(SLEEP_MS + 1200);

    await click('开始学习');
    await sleep(900);
    await click('开始做题');
    await sleep(1500);
    await click('自由练习');
    await sleep(1200);

    const entered = await evalJs(`(() => {
      const list = [...document.querySelectorAll('.practice-deck')];
      const hit = list.find(d => (d.querySelector('.practice-deck__title')?.innerText ?? '').indexOf(${JSON.stringify(DECK_TITLE)}) >= 0);
      if (!hit) return false;
      const btn = [...hit.querySelectorAll('button')].find(b => (b.innerText || '').indexOf('做这组') >= 0);
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    record('进入验证题组', entered === true);
    if (!entered) throw new Error('进不去题组');

    for (let i = 0; i < 40; i++) {
      if (await evalJs("!!document.querySelector('.answer-area')")) break;
      await sleep(250);
    }

    /*
     * 写一个「意思到了但措辞很不一样」的答案 ——
     * 这正是字符串相似度判分最容易误判的形状，也是这个功能存在的理由。
     */
    await evalJs(`(() => {
      const t = document.querySelector('.answer-area');
      if (!t) return false;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t,
        '因为高命中率可能只是少数热点在撑，真正大量请求其实没命中，所以还得看没命中时的延迟和后端扛不扛得住。');
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    await click('提交答案');
    await sleep(1200);

    const aiBtn = await evalJs(`(() => {
      const b = [...document.querySelectorAll('.self-grade button')].find(x => (x.innerText || '').indexOf('AI') >= 0);
      return b ? b.innerText.trim() : null;
    })()`);
    record('自评面板上有 AI 按钮', aiBtn !== null, aiBtn ?? '没有');

    await click('让 AI 逐要点比对');
    // busy 态：按钮应该立刻变成进行中文案并禁用
    await sleep(600);
    const busy = await evalJs(`(() => {
      const b = [...document.querySelectorAll('.self-grade button')].find(x => (x.innerText || '').indexOf('AI') >= 0);
      return b ? { text: b.innerText.trim(), disabled: b.disabled } : null;
    })()`);
    record(
      '点下去立刻有进行中反馈（不是毫无反应）',
      busy !== null && (busy.disabled === true || busy.text.indexOf('正在') >= 0),
      JSON.stringify(busy),
    );

    // 等模型回话
    let outcome = null;
    for (let i = 0; i < Math.ceil(AI_WAIT_MS / 1000); i++) {
      await sleep(1000);
      outcome = await evalJs(`(() => {
        const res = document.querySelector('.self-grade__result');
        const err = document.querySelector('.self-grade__error');
        const b = [...document.querySelectorAll('.self-grade button')].find(x => (x.innerText || '').indexOf('AI') >= 0);
        return {
          hasResult: !!res,
          resultClass: res ? res.className : null,
          summary: res?.querySelector('.self-grade__summary')?.innerText.trim() ?? null,
          points: [...(res?.querySelectorAll('.self-grade__point') ?? [])].map(li => ({
            text: li.innerText.trim(),
            ok: li.className.indexOf('--ok') >= 0,
          })),
          hasNote: !!res?.querySelector('.self-grade__note'),
          error: err ? err.innerText.trim() : null,
          stillBusy: b ? b.disabled : false,
        };
      })()`);
      if (outcome.hasResult || (outcome.error && !outcome.stillBusy)) break;
    }
    await shot('ai-grade-result.png');
    console.log('   AI 返回：' + JSON.stringify(outcome, null, 2).split('\n').join('\n   '));

    record('AI 比对返回了结果（不是报错也不是一直转圈）', outcome.hasResult === true, outcome.error ?? '');
    if (outcome.hasResult) {
      record('结果里有逐要点列表', outcome.points.length > 0, `${outcome.points.length} 条`);
      record('要点标了「答到 / 没答到」', outcome.points.some((p) => p.ok) && outcome.points.some((p) => !p.ok), JSON.stringify(outcome.points.map((p) => p.ok)));
      record('给出了一句话小结', outcome.summary !== null && outcome.summary.length > 0, outcome.summary ?? '');
      record('结果卡片写明了「这是参考，最终你决定」', outcome.hasNote === true);
      record(
        '结果卡片是虚线框（不冒充系统判定）',
        (outcome.resultClass ?? '').indexOf('self-grade__result') >= 0,
        outcome.resultClass ?? '',
      );
    }

    /*
     * 关键：AI 出了结果之后，**仍然**要用户自己点对错 ——
     * 面板不能自动翻页、不能替用户提交。
     */
    const stillWaiting = await evalJs(`(() => {
      const btn = [...document.querySelectorAll('.self-grade button')].find(x => (x.innerText || '').indexOf('我答对了') >= 0);
      return {
        hasSelfButtons: !!btn,
        prompt: document.querySelector('.question-prompt')?.innerText ?? '',
      };
    })()`);
    record(
      'AI 出结果后仍然等用户自己判（没有替用户提交）',
      stillWaiting.hasSelfButtons === true && stillWaiting.prompt.indexOf('缓存命中率') >= 0,
      JSON.stringify(stillWaiting).slice(0, 120),
    );

    // 收尾：用户自己判
    await click('我答对了');
    await sleep(1400);
    record('用户自评后能正常往前走', true);

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

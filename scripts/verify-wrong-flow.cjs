/**
 * 验证「答错 → 直接记入错题 → 下一题」这条链路。
 *
 * ## 为什么必须端到端验，而不是只跑单测
 *
 * 单测覆盖的是 `ReviewService.wrongCards()` 的逻辑，
 * 但「用户点了提交、界面调没调 review()、日志真的写进 IndexedDB 没有」
 * 是另一层。这一层出过事：错题列表曾经读一张**从来没被写过**的表，
 * 单测全绿，功能实际是空的。
 *
 * 所以这个脚本做完整的闭环：
 *   做错一道题 → 查 IndexedDB 里 reviewLogs 有没有 grade=again
 *   → 回到错题巩固 → 确认那道题真的出现在列表里
 *
 * 用法：node scripts/verify-wrong-flow.cjs --data <.tmp 数据副本> [--port 9490]
 * ⚠️ 会写入复习记录，**必须用数据副本**，不要指向用户真实库。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APP = path.resolve(ROOT, arg('app', '.tmp/apprun'));
const DATA = path.resolve(ROOT, arg('data', path.join(APP, 'openleaner-data')));
const PORT = Number(arg('port', '9490'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
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
    const click = (label) =>
      evalJs(`(() => {
        const els = [...document.querySelectorAll('button, a, [role="button"]')];
        const hit = els.find(el => (el.innerText || '').trim().split('\\n')[0] === ${JSON.stringify(label)})
                 || els.find(el => (el.innerText || '').includes(${JSON.stringify(label)}));
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
    /** 读 reviewLogs 里 again 的记录数 */
    const countAgainLogs = () =>
      evalJs(`(async () => {
        const d = await new Promise((res, rej) => {
          const r = indexedDB.open('openleaner');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const logs = await new Promise((res, rej) => {
          const tx = d.transaction('reviewLogs', 'readonly');
          const q = tx.objectStore('reviewLogs').getAll();
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        return logs.filter(l => l.grade === 'again').length;
      })()`);

    await send('Runtime.enable');
    await sleep(2600);

    const againBefore = await countAgainLogs();

    // ---- 进自由练习，挑一组题开始做 ----
    await click('开始学习');
    await sleep(900);
    await click('开始做题');
    await sleep(1300);
    await click('自由练习');
    await sleep(1200);
    await click('做这组');
    await sleep(1800);

    const onReview = await evalJs("!!document.querySelector('.question-card')");
    record('进入做题页', onReview === true);

    // ---- 故意答错：填空/简答填一个必然错的；选择/多选点第一个 ----
    const answered = await evalJs(`(() => {
      const input = document.querySelector('.answer-field') || document.querySelector('.answer-area');
      if (input) {
        const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '这是一个一定不对的答案zzz');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return 'text';
      }
      const opt = document.querySelector('.option');
      if (opt) { opt.click(); return 'option'; }
      return 'none';
    })()`);
    record('能作答', answered !== 'none', answered);

    await sleep(300);
    await click('提交答案');
    await sleep(1400);

    // ---- 关键断言 1：答错后不出现判定面板 ----
    const hasVerdict = await evalJs("!!document.querySelector('.timing-verdict')");
    record('答错后**没有**判定面板', hasVerdict === false);

    const hasGrades = await evalJs("document.querySelectorAll('.grades__row .grade').length");
    record('答错后**没有**评分档', hasGrades === 0, `实际 ${hasGrades} 个`);

    const hasNext = await evalJs(
      "[...document.querySelectorAll('button')].some(b => b.innerText.includes('下一题'))",
    );
    record('答错后出现「下一题」按钮', hasNext === true);

    // 答案与解析仍然可见（用户要看为什么错）
    const hasReveal = await evalJs("!!document.querySelector('.reveal')");
    record('答案与解析仍然可见', hasReveal === true);

    // ---- 关键断言 2：reviewLogs 真的多了一条 again ----
    await sleep(900);
    const againAfter = await countAgainLogs();
    record('答错**真的写入了**一条 again 日志', againAfter === againBefore + 1,
      `${againBefore} → ${againAfter}`);

    // ---- 关键断言 3：点下一题能前进 ----
    await click('下一题');
    await sleep(1200);
    const advanced = await evalJs(`(() => {
      const t = document.querySelector('.review-progress-text');
      return t ? t.innerText.trim() : '';
    })()`);
    /* 进度文本形如「2 / 8」；用 startsWith 判断，避免正则转义 */
    record('点「下一题」能前进', advanced.trim().startsWith('2'), advanced.slice(0, 20));

    // ---- 关键断言 4：错题集里出现这道题 ----
    await click('退出做题');
    await sleep(1200);
    await click('错题巩固');
    await sleep(1500);
    const wrongTab = await evalJs(`(() => {
      const items = [...document.querySelectorAll('.practice-wrong__item')];
      return { count: items.length, texts: items.slice(0, 3).map(i => i.innerText.replace(/\\n/g, ' ').slice(0, 50)) };
    })()`);
    record('错题集里出现了刚做错的题', wrongTab.count > 0, `${wrongTab.count} 道`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, '.verify-shots', 'wrong-flow.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n截图: .verify-shots/wrong-flow.png');
  } catch (e) {
    console.error('失败:', e.message);
    code = 1;
  } finally {
    try {
      app.kill();
    } catch {
      /* ignore */
    }
    await sleep(1000);
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n结果: ${pass}/${results.length} 通过`);
    if (pass !== results.length) code = 1;
  }
  process.exit(code);
})();

/**
 * 验证「模拟考试」完整流程：出卷 → 答题 → 交卷 → 成绩 → 落库。
 *
 * 用法：node scripts/verify-exam.cjs --data <.tmp 数据副本> [--port 9610]
 * ⚠️ 会写考试记录，必须用副本。
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
const PORT = Number(arg('port', '9610'));
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
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
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

    const readAttempts = () =>
      evalJs(`(async () => {
        const d = await new Promise((res, rej) => {
          const r = indexedDB.open('openleaner');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        if (!d.objectStoreNames.contains('examAttempts')) return { hasStore: false, rows: [] };
        const rows = await new Promise((res, rej) => {
          const tx = d.transaction('examAttempts', 'readonly');
          const q = tx.objectStore('examAttempts').getAll();
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        return { hasStore: true, rows };
      })()`);

    await send('Runtime.enable');
    await sleep(2800);

    const before = await readAttempts();
    record('examAttempts 分区已建立（DB 升到 v6）', before.hasStore === true, `原有 ${before.rows.length} 条`);

    // ---- 进入考试 ----
    await click('阶段性');
    await sleep(800);
    await click('模拟考试');
    await sleep(1800);

    const hasSetup = await evalJs("!!document.querySelector('.ex-setup')");
    record('出现试卷设置区', hasSetup === true);

    // 选 5 道题（最少，跑得快）
    await evalJs(`(() => {
      const b = [...document.querySelectorAll('.ex-chip')].find(x => x.innerText.trim() === '5');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(500);

    await click('开始考试');
    await sleep(1800);

    const taking = await evalJs("!!document.querySelector('.ex-card')");
    record('进入答题界面', taking === true);

    const hasClock = await evalJs("!!document.querySelector('.ex-bar__clock')");
    record('顶栏有倒计时', hasClock === true);

    const dots = await evalJs("document.querySelectorAll('.ex-nav__dot').length");
    record('题号导航有 5 个', dots === 5, `实际 ${dots}`);

    // ---- 答几道题：第 1 题选 A，第 2 题选 B，其余不答 ----
    for (const pick of ['A', 'B']) {
      await evalJs(`(() => {
        const btn = [...document.querySelectorAll('.ex-choice')].find(b => b.innerText.trim().startsWith(${JSON.stringify(pick)}));
        if (btn) btn.click();
        return !!btn;
      })()`);
      await sleep(300);
      /* 下一题 */
      await click('下一题');
      await sleep(500);
    }

    const answeredCount = await evalJs("document.querySelector('.ex-bar__progress')?.innerText ?? ''");
    record('进度显示已答数量', /已答\s*\d+/.test(answeredCount), answeredCount);

    // 考试中不应出现对错提示
    const noFeedback = await evalJs(
      "!document.querySelector('.ex-review') && !document.body.innerText.includes('正确答案')",
    );
    record('考试中不显示答案（交卷后才批）', noFeedback === true);

    // ---- 交卷 ----
    await click('交卷');
    await sleep(2000);

    const hasScore = await evalJs("!!document.querySelector('.ex-score')");
    record('交卷后显示成绩', hasScore === true);

    const scoreText = await evalJs("document.querySelector('.ex-score')?.innerText ?? ''");
    record('成绩含答对数与用时', /答对\s*\d+\s*\/\s*\d+/.test(scoreText), scoreText.replace(/\n/g, ' ').slice(0, 60));

    const hasReview = await evalJs("document.querySelectorAll('.ex-review__item').length");
    record('有逐题回看', hasReview === 5, `${hasReview} 题`);

    // ---- 落库验证 ----
    const after = await readAttempts();
    record('考试记录真的写进了库里', after.rows.length === before.rows.length + 1,
      `${before.rows.length} → ${after.rows.length}`);

    const last = after.rows[after.rows.length - 1];
    record('记录里有逐题作答（不是只存分数）',
      Array.isArray(last?.answers) && last.answers.length === 5,
      last ? `answers ${last.answers.length} 条，对了 ${last.correct}/${last.total}` : '');
    record('跳过的题被记为未作答',
      last ? last.answers.some((a) => a.response === '' && a.correct === false) : false,
      last ? last.answers.map((a) => a.response || '∅').join(',') : '');

    // ---- 历史成绩出现 ----
    await click('再考一次');
    await sleep(1500);
    const hasHistory = await evalJs("document.querySelectorAll('.ex-history__item').length");
    record('设置页出现历史成绩', hasHistory > 0, `${hasHistory} 条`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, '.verify-shots', 'exam-result.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n截图: .verify-shots/exam-result.png');
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

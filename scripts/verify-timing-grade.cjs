/**
 * 验证「做题计时」真在跑、评分真按耗时判。
 *
 * 为什么单独写一个脚本而不是随手 node -e：
 *   - 内联脚本里的正则和引号在 Windows shell 里反复被吃掉，
 *     已经踩过两次（missing /、转义丢失）；
 *   - 这个验证要跑好几轮、每次都要看读数与最终写入的中断，
 *     值得固定下来复用。
 *
 * 用法：
 *   node scripts/verify-timing-grade.cjs --data .tmp/apprun/openleaner-data [--port 9430]
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
const EXE = path.join(APP, 'OpenLeaner.exe');
const DATA = path.resolve(ROOT, arg('data', path.join(APP, 'openleaner-data')));
const PORT = Number(arg('port', '9430'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function findPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return null;
}

(async () => {
  const app = spawn(
    EXE,
    [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`],
    { stdio: 'ignore' },
  );

  let code = 0;
  try {
    const page = await findPage();
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
        const want = ${JSON.stringify(label)};
        const els = [...document.querySelectorAll('button, a, [role="button"]')];
        const hit = els.find(el => (el.innerText || '').trim().split('\\n')[0] === want)
                 || els.find(el => (el.innerText || '').includes(want));
        if (!hit) return false;
        hit.click();
        return true;
      })()`);

    await send('Runtime.enable');
    await sleep(2600);

    // ---- 1. 进入做题 ----
    await click('开始学习');
    await sleep(900);
    await click('开始做题');
    await sleep(1800);

    const timerText = () =>
      evalJs(`(() => {
        const el = document.querySelector('.q-timer');
        return el ? el.innerText.split('\\n').join(' ') : '';
      })()`);

    const t0 = await timerText();
    record('做题页出现计时器', t0.length > 0, t0);

    // ---- 2. 计时确实在走 ----
    await sleep(1600);
    const t1 = await timerText();
    const num = (s) => {
      const m = s.match(/([\d.]+)\s*(秒|分钟)?/);
      if (!m) return null;
      const v = Number(m[1]);
      return m[2] === '分钟' ? v * 60 : v;
    };
    const n0 = num(t0);
    const n1 = num(t1);
    record('计时读数在增长', n0 !== null && n1 !== null && n1 > n0, `${n0} → ${n1}`);

    // ---- 3. 页面上不出现「建议时长」 ----
    const body = await evalJs('document.body.innerText');
    const hasSuggestion = /通常约|通常要|约需|典型用时|建议时长/.test(body);
    record('页面没有「建议时长」字样', !hasSuggestion, hasSuggestion ? '仍出现' : '');

    // ---- 4. 提交答案后出现「用时」与判定 ----
    const filled = await evalJs(`(() => {
      const input = document.querySelector('.answer-field') || document.querySelector('.answer-area');
      if (!input) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(
        input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value',
      ).set;
      setter.call(input, '这是一个答案');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'filled';
    })()`);
    record('能填入答案', filled === 'filled', filled);

    await sleep(300);
    await click('提交答案');
    await sleep(1200);

    const verdict = await evalJs(`(() => {
      const el = document.querySelector('.timing-verdict');
      return el ? el.innerText.split('\\n').join(' | ') : '';
    })()`);
    record('提交后出现计时判定', verdict.length > 0, verdict.slice(0, 120));

    const hasElapsed = /用时/.test(verdict);
    record('判定里写明「用时」', hasElapsed, '');

    const stillNoSuggestion = !/约需|通常要|通常约/.test(verdict);
    record('判定里没有「这类题约需」', stillNoSuggestion, '');

    // ---- 5. 自动评分按钮存在且可用 ----
    const autoBtn = await evalJs(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.innerText.includes('采用这个判定'));
      return b ? { found: true, disabled: b.disabled, text: b.innerText.trim() } : { found: false };
    })()`);
    record('「采用这个判定」按钮存在', autoBtn.found === true, autoBtn.text || '');

    // ---- 6. 手动 0–5 评分档仍在（用户要求保留） ----
    const gradeCount = await evalJs("document.querySelectorAll('.grades__row .grade').length");
    record('0–5 手动评分档仍保留（6 档）', gradeCount === 6, `实际 ${gradeCount} 档`);

    // ---- 7. 点「采用这个判定」后真的写入了复习记录 ----
    await click('采用这个判定');
    await sleep(1500);
    const recAfter = await evalJs(`(async () => {
      const d = await new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const all = await new Promise((res, rej) => {
        const tx = d.transaction('reviewRecords', 'readonly');
        const q = tx.objectStore('reviewRecords').getAll();
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      return { count: all.length, lastDue: all.length ? all[all.length - 1].state.dueAt : null };
    })()`);
    record('采用判定后写入复习记录', recAfter.count > 0, `记录 ${recAfter.count} 条`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, '.verify-shots', 'timing-verify.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n截图: .verify-shots/timing-verify.png');
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

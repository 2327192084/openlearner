/**
 * 截「答错瞬间」的图 —— 确认判定面板确实没了、只剩「下一题」。
 *
 * 用法：node scripts/shot-wrong-answer.cjs [--port 9495]
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
const PORT = Number(arg('port', '9495'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const app = spawn(
    path.join(APP, 'OpenLeaner.exe'),
    [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,1000'],
    { stdio: 'ignore' },
  );
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
            reject(new Error('CDP 超时'));
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

    await send('Runtime.enable');
    await sleep(2600);
    await click('开始学习');
    await sleep(900);
    await click('开始做题');
    await sleep(1300);
    await click('自由练习');
    await sleep(1100);
    await click('做这组');
    await sleep(1800);

    await evalJs(`(() => {
      const input = document.querySelector('.answer-field') || document.querySelector('.answer-area');
      if (input) {
        const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '故意写错 zzz');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      const opt = document.querySelector('.option');
      if (opt) opt.click();
    })()`);
    await sleep(300);
    await click('提交答案');
    await sleep(1500);
    await evalJs("document.querySelector('.review-foot')?.scrollIntoView({ block: 'center' })");
    await sleep(500);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, '.verify-shots', 'wrong-answer-state.png'), Buffer.from(shot.data, 'base64'));
    console.log('已截图: .verify-shots/wrong-answer-state.png');
  } catch (e) {
    console.error('失败:', e.message);
  } finally {
    try {
      app.kill();
    } catch {
      /* ignore */
    }
    await sleep(800);
  }
})();

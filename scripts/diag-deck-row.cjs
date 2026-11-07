/**
 * 检查「自由练习」题组行的实际布局，找出左侧那个深色竖块是什么。
 *
 * 用法：node scripts/diag-deck-row.cjs [--port 9450]
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APP = path.resolve(ROOT, arg('app', '.tmp/apprun'));
const DATA = path.resolve(ROOT, arg('data', path.join(APP, 'openleaner-data')));
const PORT = Number(arg('port', '9450'));
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
        const hit = els.find(el => (el.innerText || '').includes(${JSON.stringify(label)}));
        if (!hit) return false;
        hit.click();
        return true;
      })()`);

    await send('Runtime.enable');
    await sleep(2600);
    await click('开始学习');
    await sleep(800);
    await click('开始做题');
    await sleep(1200);
    await click('自由练习');
    await sleep(1000);

    const info = await evalJs(`(() => {
      const ul = document.querySelector('.practice-decks');
      const li = document.querySelector('.practice-deck');
      if (!ul || !li) return { error: 'no element' };
      const cs = (el) => {
        const s = getComputedStyle(el);
        return {
          display: s.display,
          listStyle: s.listStyleType,
          padding: s.padding,
          margin: s.margin,
          background: s.backgroundColor,
          width: Math.round(el.getBoundingClientRect().width),
          left: Math.round(el.getBoundingClientRect().left),
        };
      };
      // 逐个子元素看谁在最左边
      const children = [...li.children].map(c => ({
        cls: c.className,
        left: Math.round(c.getBoundingClientRect().left),
        width: Math.round(c.getBoundingClientRect().width),
      }));
      return { ul: cs(ul), li: cs(li), children, liHTML: li.outerHTML.slice(0, 400) };
    })()`);
    console.log(JSON.stringify(info, null, 2));
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

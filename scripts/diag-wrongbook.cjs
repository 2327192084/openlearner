/**
 * 诊断「错题与待巩固」页的布局：为什么列表项被压成竖条。
 *
 * 用法：node scripts/diag-wrongbook.cjs [--port 9515]
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
const PORT = Number(arg('port', '9515'));
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
    await sleep(2800);
    await click('错题与待巩固');
    await sleep(2000);

    const info = await evalJs(`(() => {
      const page = document.querySelector('.wrongbook-page');
      const list = document.querySelector('.wb-list');
      const item = document.querySelector('.wb-item');
      const head = document.querySelector('.wb-item__head');
      const prompt = document.querySelector('.wb-item__prompt');
      if (!page || !item) return { error: 'element missing' };
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left),
          display: cs.display, flexDirection: cs.flexDirection,
          minWidth: cs.minWidth, width: cs.width, maxWidth: cs.maxWidth,
        };
      };
      return {
        page: box(page),
        list: box(list),
        item: box(item),
        head: box(head),
        prompt: box(prompt),
        // 父链上谁可能是 flex 容器
        itemParentDisplay: item.parentElement ? getComputedStyle(item.parentElement).display : null,
        itemParentFlexDir: item.parentElement ? getComputedStyle(item.parentElement).flexDirection : null,
      };
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

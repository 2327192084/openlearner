/**
 * 量「空态卡顶部朱砂线」的真实几何（2026-11-10）。
 *
 * 为什么单独量：截图上看不见那条线，但 CSS 规则确实在产物里。
 * 不能靠猜 —— 要么伪元素没渲染，要么被遮挡，要么颜色/高度不对。
 * 直接把 computed style 与几何都取出来看。
 *
 * 用法：node scripts/probe-accent-line.cjs --app release/win-unpacked --data .tmp/<副本>
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_URL_PREFIX = 'file://';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APP_DIR = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA_DIR = path.resolve(ROOT, arg('data', '.tmp/probe-data'));
const PORT = Number(arg('port', '9990'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let app = null;
  try {
    app = spawn(
      path.join(APP_DIR, 'OpenLeaner.exe'),
      [
        `--user-data-dir=${DATA_DIR}`,
        '--no-sandbox',
        `--remote-debugging-port=${PORT}`,
        '--window-size=1440,900',
      ],
      { stdio: 'ignore' },
    );

    let page = null;
    for (let i = 0; i < 120; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find(
          (t) => t.type === 'page' && t.webSocketDebuggerUrl && String(t.url).indexOf(APP_URL_PREFIX) === 0,
        );
        if (page) break;
      } catch {
        /* wait */
      }
      await sleep(250);
    }
    if (!page) throw new Error('应用没起来');

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
            reject(new Error('timeout ' + method));
          }
        }, 20000);
      });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(4000);

    /* 进学习笔记（空态） */
    await evalJs(`(() => {
      const labels = [...document.querySelectorAll('.nav-item__label')];
      const hit = labels.find(el => el.innerText.trim() === '学习笔记');
      if (hit) hit.closest('button').click();
      return !!hit;
    })()`);
    await sleep(2000);

    const info = await evalJs(`(() => {
      const card = document.querySelector('.empty-card');
      if (!card) return { found: false };
      const cs = getComputedStyle(card, '::before');
      const r = card.getBoundingClientRect();
      return {
        found: true,
        cardRect: { x: r.x, y: r.y, w: r.width, h: r.height },
        before: {
          content: cs.content,
          position: cs.position,
          top: cs.top,
          left: cs.left,
          right: cs.right,
          height: cs.height,
          background: cs.backgroundColor,
          display: cs.display,
          zIndex: cs.zIndex,
        },
        /* 卡片自身的 computed，确认 overflow 等 */
        cardStyle: {
          overflow: cs.overflow,
          position: getComputedStyle(card).position,
          background: getComputedStyle(card).backgroundColor,
        },
        /* 变量值 */
        accent: getComputedStyle(card).getPropertyValue('--accent').trim(),
        paper: getComputedStyle(card).getPropertyValue('--paper').trim(),
      };
    })()`);

    console.log('=== 空态卡 ::before 实测 ===');
    console.log(JSON.stringify(info, null, 2));

    /* 再截一张只含卡顶部的特写，确认肉眼效果 */
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: (() => {
        if (!info.found) return undefined;
        return {
          x: Math.max(0, info.cardRect.x - 10),
          y: Math.max(0, info.cardRect.y - 10),
          width: Math.min(600, info.cardRect.w + 20),
          height: 70,
          scale: 3,
        };
      })(),
    });
    const out = path.join(ROOT, '.verify-shots', 'crops', 'accent-probe.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('\n特写截图:', path.relative(ROOT, out));
  } catch (e) {
    console.error('探针失败:', e.message);
    process.exitCode = 1;
  } finally {
    try {
      app && app.kill();
    } catch {
      /* ignore */
    }
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/F', '/IM', 'OpenLeaner.exe'], { stdio: 'ignore' });
      } catch {
        /* ignore */
      }
    }
    await sleep(500);
  }
})();

/**
 * 用真实 Electron 应用 + CDP 截图，并可选点击某个导航项。
 *
 * 这是「改界面必须肉眼复核」的执行工具：
 *   - 用**真实打包产物**（release/win-unpacked），不是 vite preview，
 *     才能看到用户实际会看到的界面；
 *   - 数据目录用副本，避免把测试点击写进用户真实库。
 *
 * 用法：
 *   node scripts/shot-app.cjs --data <.tmp 下的副本目录> --out .verify-shots/xxx.png
 *        [--port 9391] [--click 知识库] [--wait 1200]
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'OpenLeaner.exe');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DATA_DIR = path.resolve(ROOT, arg('data', ''));
const OUT = path.resolve(ROOT, arg('out', '.verify-shots/shot.png'));
const PORT = Number(arg('port', '9391'));
const CLICK = arg('click', '');
const WAIT = Number(arg('wait', '1400'));
const WIDTH = Number(arg('width', '1440'));
const HEIGHT = Number(arg('height', '900'));

if (!DATA_DIR || !fs.existsSync(DATA_DIR)) {
  console.error('用法: node scripts/shot-app.cjs --data <.tmp 数据副本> --out <png> [--click 页面名]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const app = spawn(
    EXE,
    [
      `--user-data-dir=${DATA_DIR}`,
      '--no-sandbox',
      `--remote-debugging-port=${PORT}`,
      `--window-size=${WIDTH},${HEIGHT}`,
    ],
    { stdio: 'ignore' },
  );

  let code = 0;
  try {
    const page = await findPage();
    if (!page) throw new Error('Electron 没起来（CDP 连不上）');
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

    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(WAIT);

    if (CLICK) {
      /* 按可见文字点导航项；找不到就如实报错，不静默跳过 */
      const clicked = await evalJs(`(() => {
        const want = ${JSON.stringify(CLICK)};
        const all = [...document.querySelectorAll('button, a, [role="button"]')];
        const hit = all.find(el => (el.innerText || '').trim().split('\\n')[0] === want)
                 || all.find(el => (el.innerText || '').includes(want));
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
      if (!clicked) throw new Error(`界面上找不到「${CLICK}」`);
      await sleep(900);
    }

    /* 报一下当前标题，方便断言点对了地方 */
    const heading = await evalJs(`(() => {
      const h = document.querySelector('h1, h2, .page-title, header h1');
      return (h && h.innerText.trim()) || (document.title || '');
    })()`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
    console.log(`已截图: ${path.relative(ROOT, OUT)}  (${kb} KB)  页面标题: ${heading}`);
    code = 0;
  } catch (e) {
    console.error('截图失败:', e.message);
    code = 1;
  } finally {
    try {
      app.kill();
    } catch {
      /* ignore */
    }
    await sleep(900);
  }
  process.exit(code);
})();

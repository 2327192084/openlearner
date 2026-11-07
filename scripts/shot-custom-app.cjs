/**
 * 用**指定的 app 目录**启动 Electron 并截图。
 *
 * 和 shot-app.cjs 的区别：那个固定用 release/win-unpacked，
 * 这个允许指向 .tmp 下的副本 —— 改了代码之后想在
 * 「真实打包产物 + 真实数据」上验证，又不想污染用户安装目录时用。
 *
 * 用法：
 *   node scripts/shot-custom-app.cjs --app .tmp/apprun --data .tmp/apprun/openleaner-data
 *        --out .verify-shots/x.png [--port 9401] [--click 设置] [--click2 做题评分]
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function argAll(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
  }
  return out;
}

const APP_DIR = path.resolve(ROOT, arg('app', '.tmp/apprun'));
const EXE = path.join(APP_DIR, 'OpenLeaner.exe');
const DATA_DIR = path.resolve(ROOT, arg('data', path.join(APP_DIR, 'openleaner-data')));
const OUT = path.resolve(ROOT, arg('out', '.verify-shots/custom.png'));
const PORT = Number(arg('port', '9401'));
const CLICKS = argAll('click');
const WAIT = Number(arg('wait', '2000'));
const WIDTH = Number(arg('width', '1440'));
const HEIGHT = Number(arg('height', '960'));

if (!fs.existsSync(EXE)) {
  console.error(`找不到 ${EXE}`);
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

    for (const label of CLICKS) {
      const ok = await evalJs(`(() => {
        const want = ${JSON.stringify(label)};
        const els = [...document.querySelectorAll('button, a, [role="button"]')];
        const hit = els.find(el => (el.innerText || '').trim().split('\\n')[0] === want)
                 || els.find(el => (el.innerText || '').includes(want));
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
      if (!ok) throw new Error(`界面上找不到「${label}」`);
      await sleep(1100);
    }

    const heading = await evalJs(`(() => {
      const h = document.querySelector('h1, h2');
      return (h && h.innerText.trim()) || '';
    })()`);
    const text = await evalJs(`(() => document.body.innerText.slice(0, 1600))()`);

    /* 可选滚动：验证长页面下半部分（表格、下拉框常在这里溢出） */
    const scrollTo = arg('scroll', '');
    if (scrollTo) {
      const y = scrollTo === 'bottom' ? 100000 : Number(scrollTo);
      /*
       * 三种可能都要试：内容区可能是 window 滚动、也可能是内部某个
       * overflow 容器。只试一种会在换布局后静默失败 ——
       * 截出来的还是顶上那张图，看着像「滚动没生效」，
       * 实际是「滚的不是这个元素」。
       */
      const moved = await evalJs(`(() => {
        const target = ${Number.isFinite(y) ? y : 100000};
        let done = 0;
        // 1) window
        window.scrollTo(0, target);
        if (window.scrollY > 0) done++;
        // 2) 任何可滚动的祖先/内容区
        for (const el of document.querySelectorAll('.settings-panel, .main, .content, main, .app')) {
          if (el.scrollHeight > el.clientHeight + 4) {
            el.scrollTop = target;
            if (el.scrollTop > 0) done++;
          }
        }
        return done;
      })()`);
      console.log(`滚动容器命中数: ${moved}`);
      await sleep(700);
    }

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log(`已截图: ${path.relative(ROOT, OUT)}  标题: ${heading}`);
    console.log('--- 页面文字（前 900 字）---');
    console.log(text.slice(0, 900));
    code = 0;
  } catch (e) {
    console.error('失败:', e.message);
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

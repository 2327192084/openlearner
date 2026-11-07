/**
 * 验证「右侧白边」已修复。
 *
 * ## 怎么验
 *
 * 白边的成因是：页面底色（body）用的是 v1 浅色 #f7f8fa，
 * 而应用是深色。只要出现任何没被 .app 盖住的区域，就露出浅色。
 *
 * 所以这个脚本直接**读像素**：把窗口调窄、让内容可能溢出，
 * 然后截图并检查最右一列像素是不是深色。
 * 只要出现接近白色（RGB 都 > 200）的像素，就说明还有白边。
 *
 * 用法：node scripts/verify-white-edge.cjs [--port 9520]
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
const PORT = Number(arg('port', '9520'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  const app = spawn(
    path.join(APP, 'OpenLeaner.exe'),
    [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1100,800'],
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

    // ---- 1. 底色检查：body 必须是深色 ----
    const bodyBg = await evalJs('getComputedStyle(document.body).backgroundColor');
    const m = bodyBg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    const isDark = m ? Number(m[1]) < 60 && Number(m[2]) < 60 && Number(m[3]) < 60 : false;
    record('页面底色是深色（不是浅色 #f7f8fa）', isDark, bodyBg);

    // ---- 2. 横向溢出检查：不应有横向滚动条 ----
    const overflow = await evalJs(`(() => ({
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      bodyScrollW: document.body.scrollWidth,
    }))()`);
    const noHScroll = overflow.scrollW <= overflow.clientW + 1;
    record(
      '没有横向溢出（不会露出边缘底色）',
      noHScroll,
      `scrollWidth=${overflow.scrollW} clientWidth=${overflow.clientW}`,
    );

    // ---- 3. 逐页截图 + 检查最右一列像素 ----
    const pagesToCheck = ['学习库', '错题与待巩固', '资料'];
    for (const p of pagesToCheck) {
      await click(p);
      await sleep(1200);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const buf = Buffer.from(shot.data, 'base64');
      const file = path.join(ROOT, '.verify-shots', `edge-${encodeURIComponent(p)}.png`);
      fs.writeFileSync(file, buf);

      /* 用 CDP 的 DOM.getBoxModel 拿不到像素，所以把图交给 canvas 在页面里读 */
      const b64 = shot.data;
      const edge = await evalJs(`(async () => {
        const img = new Image();
        img.src = 'data:image/png;base64,${b64}';
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        /* 取最右 3 列，找最亮的像素 */
        let maxLum = 0;
        let sample = null;
        for (let x = img.width - 3; x < img.width; x++) {
          for (let y = 0; y < img.height; y += 7) {
            const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            if (lum > maxLum) { maxLum = lum; sample = [r, g, b]; }
          }
        }
        return { maxLum: Math.round(maxLum), sample, w: img.width, h: img.height };
      })()`);

      const whiteEdge = edge.maxLum > 200;
      record(
        `「${p}」右侧没有白边`,
        !whiteEdge,
        `最亮像素亮度 ${edge.maxLum} rgb(${edge.sample?.join(',')})`,
      );
    }
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
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n结果: ${pass}/${results.length} 通过`);
    if (pass !== results.length) code = 1;
  }
  process.exit(code);
})();

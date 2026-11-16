/**
 * 单点诊断：切到云 OCR 之后，按钮文案到底是什么？
 *
 * 上一步验证里 `radioState.kind === 'ok'`（radio 确实 checked 了），
 * 但面板上的按钮仍写「用本机 MinerU 转成正文」—— 而云 OCR 那条路的
 * 按钮文案按代码应该是「解析这几页」。要么是界面没跟上（真 bug），
 * 要么是我脚本取错了节点。
 *
 * 这个脚本只把相关 DOM 全 dump 出来，不下结论。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

function arg(n, d) {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
}
const APP_DIR = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA = path.resolve(ROOT, arg('data', ''));
const PORT = Number(arg('port', '9760'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const app = spawn(
    path.join(APP_DIR, 'OpenLeaner.exe'),
    [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,900'],
    { stdio: 'ignore' },
  );

  let target = null;
  for (let i = 0; i < 160; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
      if (target) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  if (!target) {
    app.kill();
    throw new Error('应用没起来');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
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
          reject(new Error(`timeout ${method}`));
        }
      }, 60000);
    });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(4000);

  /* 进解析页 */
  await evalJs(`(() => {
    for (const g of [...document.querySelectorAll('.nav-group')]) {
      if (g.getAttribute('aria-expanded') !== 'true') g.click();
    }
    return true;
  })()`);
  await sleep(1200);
  await evalJs(`(() => {
    for (const b of [...document.querySelectorAll('.nav-item')]) {
      const l = b.querySelector('.nav-item__label');
      if (l && l.innerText.trim() === '文档解析') { b.click(); return true; }
    }
    return false;
  })()`);
  await sleep(2500);

  const before = await evalJs(`(() => {
    const btns = [...document.querySelectorAll('.convert-panel button')].map(b => b.innerText.trim());
    return {
      radios: [...document.querySelectorAll('input[name="parse-engine"]')].map(r => ({v:r.value, checked:r.checked, disabled:r.disabled})),
      buttons: btns,
    };
  })()`);
  console.log('=== 切换前 ===');
  console.log(JSON.stringify(before, null, 2));

  /* 切云 OCR */
  const clip = await evalJs(`(() => {
    const r = document.querySelector('input[name="parse-engine"][value="deepseek"]');
    if (!r) return 'no-radio';
    r.click();
    return 'clicked';
  })()`);
  console.log('\nclick:', clip);
  await sleep(3000);

  const after = await evalJs(`(() => {
    const btns = [...document.querySelectorAll('.convert-panel button')].map(b => ({t:b.innerText.trim(), disabled:b.disabled}));
    return {
      radios: [...document.querySelectorAll('input[name="parse-engine"]')].map(r => ({v:r.value, checked:r.checked})),
      engineOn: [...document.querySelectorAll('.engine-opt')].map(e => ({cls:e.className, txt:e.innerText.slice(0,30).replace(/\\s+/g,' ')})),
      buttons: btns,
      panelText: (document.querySelector('.convert-panel')||{}).innerText||'',
    };
  })()`);
  console.log('\n=== 切换后 ===');
  console.log(JSON.stringify(after, null, 2));

  const r = await send('Page.captureScreenshot', { format: 'png' });
  const out = path.join(ROOT, '.verify-shots/ocr-fix-20261116/diag-engine-switch.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log('\n截图:', out);

  app.kill();
  try {
    spawn('taskkill', ['/F', '/IM', 'OpenLeaner.exe'], { stdio: 'ignore' });
  } catch {
    /* 忽略 */
  }
  await sleep(600);
  process.exit(0);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(2);
});
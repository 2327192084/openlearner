/**
 * 单点诊断：切到云 OCR 后，cloudRunner 到底建起来没有？
 *
 * 现象：按钮文案已经是「用 DeepSeek 云 OCR 识别」（说明 engine prop 传对了），
 * 但点下去界面说「正在启动 MinerU…」—— 说明 ConvertPanel 收到的 runner
 * 仍然是本地的，也就是 ParsePage 里 `cloudRunner` 还是 null。
 *
 * 这个脚本把「点了之后实际走哪条路」的判据打出来：
 *  - .convert-panel 里显示的阶段文案
 *  - window.fetch 有没有被调用
 *  - 有没有出现 cloudErr（建 runner 失败会写它）
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
const PORT = Number(arg('port', '9770'));
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

  /* 拦截器：记录所有 fetch 调用 */
  await evalJs(`(() => {
    window.__fetches = [];
    const orig = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      window.__fetches.push(url);
      if (url.indexOf('/v1/tools/ocr') >= 0) {
        return Promise.resolve(new Response(
          '<html><head><title>413 Request Entity Too Large</title></head><body><center><h1>413</h1></center><hr><center>openresty</center></body></html>',
          { status: 413, headers: { 'content-type': 'text/html', server: 'openresty' } },
        ));
      }
      return orig(input, init);
    };
    return 'ok';
  })()`);

  /* 进页 + 切云 */
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
  await evalJs(`(() => {
    const r = document.querySelector('input[name="parse-engine"][value="deepseek"]');
    if (r) r.click();
    return !!r;
  })()`);
  await sleep(4000);

  /* 看有没有 cloudErr 之类的提示 */
  const state = await evalJs(`(() => {
    const page = document.querySelector('.parse-page') || document.body;
    return {
      ppNoteBad: [...document.querySelectorAll('.pp-note--bad')].map(e => e.innerText.trim()),
      buttons: [...document.querySelectorAll('.convert-panel button')].map(b => b.innerText.trim()),
      panelText: (document.querySelector('.convert-panel') || {}).innerText || '',
      fetches: window.__fetches || [],
    };
  })()`);
  console.log('=== 切云之后（未点击）===');
  console.log('pp-note--bad :', JSON.stringify(state.ppNoteBad));
  console.log('按钮         :', JSON.stringify(state.buttons));
  console.log('fetch 记录   :', JSON.stringify(state.fetches));

  /* 点击 */
  const clicked = await evalJs(`(() => {
    const panel = document.querySelector('.convert-panel');
    for (const b of [...(panel||document).querySelectorAll('button')]) {
      const t = b.innerText.trim();
      if (!b.disabled && (t.indexOf('识别') >= 0 || t.indexOf('解析') >= 0 || t.indexOf('转成正文') >= 0)) {
        b.click(); return t;
      }
    }
    return '(none)';
  })()`);
  console.log('\n点了:', clicked);
  await sleep(8000);

  const after = await evalJs(`(() => ({
    panelText: (document.querySelector('.convert-panel') || {}).innerText || '',
    fetches: window.__fetches || [],
  }))()`);
  console.log('\n=== 点击之后 ===');
  console.log('fetch 记录 :', JSON.stringify(after.fetches));
  console.log('面板文案   :');
  console.log(after.panelText.split('\n').filter(l=>l.trim()).slice(0,12).map(l=>'  | '+l).join('\n'));

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
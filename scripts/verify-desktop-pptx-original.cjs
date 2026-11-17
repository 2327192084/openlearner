/**
 * 桌面安装版验证：PPT 看原图功能已随新版 exe+asar 生效（2026-11-17）。
 *
 * 直接启动安装目录 OpenLeaner.exe（无项目根参数 → 加载 resources/app.asar），
 * 若 asar integrity 与 exe 不匹配会起不来/白屏，本脚本能抓到。
 * 隔离：--user-data-dir 指隔离副本 + APPDATA 环境变量，不碰真实库。
 * 导入独特 marker 的中文 PPT → 看原图 → 断言 pptx-wasm 渲染出 PNG。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const INSTALL_EXE = 'C:/Users/ASUS/AppData/Local/Programs/OpenLeaner/OpenLeaner.exe';
const INSTALL_DIR = path.dirname(INSTALL_EXE);
const APPDATA = path.resolve(ROOT, '.tmp/cloud-fullonly-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const PPT = path.resolve(ROOT, '.tmp/PPTORIGINAL-verify-20261117.pptx');
const MARKER = 'PPTORIGINAL-verify-20261117';
const PORT = Number(process.argv[2] || 9797);
const OUT = path.resolve(ROOT, '.verify-shots/desktop-pptx-original');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function rec(name, pass, detail = '') {
  results.push({ name, pass: pass === true, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(INSTALL_EXE) || !fs.existsSync(DATA) || !fs.existsSync(PPT)) {
    console.error('缺少安装 exe / 隔离数据 / 测试 PPT');
    process.exit(2);
  }

  const app = spawn(
    INSTALL_EXE,
    [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,900'],
    { cwd: INSTALL_DIR, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let appLog = '';
  app.stdout.on('data', (d) => { appLog += d.toString(); });
  app.stderr.on('data', (d) => { appLog += d.toString(); });

  let webSocket = null;
  try {
    let target = null;
    for (let i = 0; i < 180; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
        if (target) break;
      } catch { /* 还没起来 */ }
      await sleep(250);
    }
    if (!target) {
      console.error('桌面应用没起来（asar integrity 不匹配？）日志尾部：\n' + appLog.slice(-3000));
      throw new Error('桌面应用没起来');
    }
    rec('桌面安装版正常启动（asar integrity 配套）', true, target.url);
    rec('加载的是安装目录 asar', String(target.url).indexOf('/Resources/') >= 0 || String(target.url).indexOf('/resources/') >= 0 || String(target.url).indexOf('app.asar') >= 0, target.url);

    webSocket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      webSocket.addEventListener('open', res, { once: true });
      webSocket.addEventListener('error', rej, { once: true });
    });
    let id = 1;
    const pending = new Map();
    webSocket.addEventListener('message', (ev) => {
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
        webSocket.send(JSON.stringify({ id: n, method, params }));
        setTimeout(() => {
          if (pending.has(n)) { pending.delete(n); reject(new Error(`timeout ${method}`)); }
        }, 60000);
      });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const shot = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(3500);

    // 进资料页
    await evalJs(`(() => {
      for (const g of [...document.querySelectorAll('.nav-group')]) {
        if (g.getAttribute('aria-expanded') !== 'true') g.click();
      }
      return true;
    })()`);
    await sleep(1000);
    const navOk = await evalJs(`(() => {
      for (const b of [...document.querySelectorAll('.nav-item .nav-item__label')]) {
        if (b.innerText.trim() === '资料') { b.click(); return true; }
      }
      return false;
    })()`);
    rec('进入资料页', navOk === true);
    await sleep(2500);

    // 用 CDP 塞入独特 marker 的中文 PPT
    const inputNode = await send('DOM.getDocument', { depth: -1 });
    const inputResult = await send('DOM.querySelector', {
      nodeId: inputNode.root.nodeId,
      selector: 'input[type="file"][accept*=".pptx"]',
    });
    if (!inputResult.nodeId) throw new Error('找不到文件输入');
    await send('DOM.setFileInputFiles', { files: [PPT], nodeId: inputResult.nodeId });
    await sleep(6000);

    const imported = await evalJs(`(() => {
      const titles = [...document.querySelectorAll('.source-row__title')].map(x => x.innerText);
      return { ok: titles.some(t => t.indexOf(${JSON.stringify(MARKER)}) >= 0), titles };
    })()`);
    rec('桌面版导入中文 PPT 成功', imported.ok === true, JSON.stringify(imported.titles));

    const opened = await evalJs(`(() => {
      for (const r of document.querySelectorAll('.source-row')) {
        if ((r.innerText || '').indexOf(${JSON.stringify(MARKER)}) >= 0) { r.click(); return true; }
      }
      return false;
    })()`);
    rec('打开 PPT 进入阅读器', opened === true);
    await sleep(3000);

    const canOriginal = await evalJs(`(() => [...document.querySelectorAll('button')].some(b => (b.innerText || '').trim() === '看原图'))()`);
    rec('桌面版显示「看原图」按钮', canOriginal === true);

    const clicked = await evalJs(`(() => {
      for (const b of document.querySelectorAll('button')) {
        if ((b.innerText || '').trim() === '看原图') { b.click(); return true; }
      }
      return false;
    })()`);
    rec('点击「看原图」', clicked === true);
    await sleep(4000);

    const img = await evalJs(`(() => {
      const el = document.querySelector('.reader-original__img');
      if (!el) return { ok:false, reason:'no img' };
      const src = el.getAttribute('src') || '';
      return { ok: src.startsWith('data:image/png;base64,') && src.length > 2000,
               len: src.length, w: el.naturalWidth, h: el.naturalHeight };
    })()`);
    rec('桌面版 PPT 原图渲染出有效 PNG', img.ok === true, JSON.stringify(img));
    await shot('desktop-pptx-original');

    const pass = results.filter((r) => r.pass).length;
    console.log(`\n===== ${pass}/${results.length} PASS =====`);
    if (pass !== results.length) process.exitCode = 1;
  } catch (e) {
    console.error('验证异常：', e.stack || e.message);
    console.error('应用日志尾部：\n' + appLog.slice(-2000));
    process.exitCode = 1;
  } finally {
    if (webSocket) webSocket.close();
    try { app.kill(); } catch { /* 已退出 */ }
  }
})();

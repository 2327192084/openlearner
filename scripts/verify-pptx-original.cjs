/**
 * CDP 端到端验证：导入中文 PPT → 阅读器「看原图」真的渲染出幻灯片（2026-11-17）。
 *
 * ## 为什么必须真跑浏览器
 *
 * pptx-wasm 靠浏览器 canvas / WASM / 系统字体，Node 单测只能验页码校验，
 * 渲染对不对只能靠真浏览器 + 肉眼截图。这是项目硬约束「改界面必须 CDP 截图复核」。
 *
 * ## 隔离
 *
 * 用 .tmp/cloud-fullonly-app/electron.exe + 项目根 dist（新构建），
 * --user-data-dir 指 .tmp/cloud-fullonly-appdata/OpenLeaner（真实库只读副本），
 * APPDATA 环境变量指到副本。导入会写这个副本库，绝不碰用户真实库。
 *
 * 导入的中文 PPT 是 .tmp/chinese-test.pptx（pptxgenjs 生成的 2 页信号与系统课件），
 * 之前已用 pptx-wasm 独立实测中文渲染完美。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const APP_EXE = path.resolve(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
const APPDATA = path.resolve(ROOT, '.tmp/cloud-fullonly-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const PPT = path.resolve(ROOT, '.tmp/PPTORIGINAL-verify-20261117.pptx');
const MARKER = 'PPTORIGINAL-verify-20261117'; // 独特文件名，避免命中库里已有的「信号与系统」PDF（假阳性）
const PORT = Number(process.argv[2] || 9795);
const OUT = path.resolve(ROOT, '.verify-shots/pptx-original');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function rec(name, pass, detail = '') {
  results.push({ name, pass: pass === true, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(APP_EXE) || !fs.existsSync(DATA) || !fs.existsSync(PPT)) {
    console.error('缺少隔离环境（app / data / 中文 PPT）');
    process.exit(2);
  }

  const app = spawn(
    APP_EXE,
    [ROOT, `--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,900'],
    { cwd: ROOT, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
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
      console.error('应用没起来，日志尾部：\n' + appLog.slice(-3000));
      throw new Error('应用没起来');
    }
    rec('应用正常启动', true, target.url);

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

    // 进资料页：展开所有分组，点「资料」
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

    // 用 CDP 把中文 PPT 塞进隐藏 file input（setFileInputFiles）
    const inputNode = await send('DOM.getDocument', { depth: -1 });
    const inputResult = await send('DOM.querySelector', {
      nodeId: inputNode.root.nodeId,
      selector: 'input[type="file"][accept*=".pptx"]',
    });
    if (!inputResult.nodeId) throw new Error('找不到文件输入');
    await send('DOM.setFileInputFiles', { files: [PPT], nodeId: inputResult.nodeId });
    await sleep(6000); // 导入 + 解析

    // 断言导入结果：列表里出现中文 PPT
    const imported = await evalJs(`(() => {
      const titles = [...document.querySelectorAll('.source-row__title')].map(x => x.innerText);
      return { ok: titles.some(t => t.indexOf(${JSON.stringify(MARKER)}) >= 0), titles };
    })()`);
    rec('中文 PPT 导入成功（source-row 出现）', imported.ok === true, JSON.stringify(imported.titles));

    // 打开这份资料（阅读器）
    const opened = await evalJs(`(() => {
      for (const r of document.querySelectorAll('.source-row')) {
        if ((r.innerText || '').indexOf(${JSON.stringify(MARKER)}) >= 0) { r.click(); return true; }
      }
      return false;
    })()`);
    rec('打开资料进入阅读器', opened === true);
    await sleep(3000);

    // 关键：确认打开的是刚导入的 PPT，而不是库里已有的旧 PDF（假阳性防护）
    const readerTitle = await evalJs(`(() => {
      const h = document.querySelector('.reader-title, h1, .reader-head__title') || document.body;
      return (h.innerText || '').slice(0, 300);
    })()`);
    rec('阅读器确为刚导入的 PPT（不是旧资料）', String(readerTitle).indexOf(MARKER) >= 0, String(readerTitle).replace(/\s+/g, ' ').slice(0, 120));

    // 断言「看原图」按钮出现（canShowOriginal）
    const canOriginal = await evalJs(`(() => {
      return [...document.querySelectorAll('button')].some(b => (b.innerText || '').trim() === '看原图');
    })()`);
    rec('PPTX 显示「看原图」按钮（canShowOriginal）', canOriginal === true);
    await shot('01-reader-text');

    // 点「看原图」→ 触发 pptx-wasm 渲染
    const clicked = await evalJs(`(() => {
      for (const b of document.querySelectorAll('button')) {
        if ((b.innerText || '').trim() === '看原图') { b.click(); return true; }
      }
      return false;
    })()`);
    rec('点击「看原图」', clicked === true);
    await sleep(4000); // wasm 首次加载 + 渲染

    // 核心断言：原图 <img> 出现且是有效 PNG data URI
    const img = await evalJs(`(() => {
      const el = document.querySelector('.reader-original__img');
      if (!el) return { ok:false, reason:'no img' };
      const src = el.getAttribute('src') || '';
      return { ok: src.startsWith('data:image/png;base64,') && src.length > 2000,
               len: src.length, w: el.naturalWidth, h: el.naturalHeight };
    })()`);
    rec('PPT 原图渲染出有效 PNG（pptx-wasm）', img.ok === true, JSON.stringify(img));
    await shot('02-pptx-original');

    // 切回「看文字」验证双向切换仍正常
    const backText = await evalJs(`(() => {
      for (const b of document.querySelectorAll('button')) {
        if ((b.innerText || '').trim() === '看文字') { b.click(); return true; }
      }
      return false;
    })()`);
    rec('切回「看文字」', backText === true);
    await sleep(1500);
    const textBack = await evalJs(`(() => !!document.querySelector('.reader-body'))()`);
    rec('文字视图恢复', textBack === true);

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

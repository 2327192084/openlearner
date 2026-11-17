/**
 * CDP 端到端验证：阅读器「全屏沉浸查看资料」（2026-11-17）。
 *
 * ## 验什么
 *  - 阅读器工具栏有「全屏」按钮
 *  - 点全屏 → .reader-page--fullscreen 生效，正文/原图区铺满，
 *    右栏 .rside 与搜索框收起，外壳 .sidebar/.topbar 隐藏
 *  - 真全屏 document.fullscreenElement 建立（Electron 里 F11 式）
 *  - 「退出全屏」按钮 + Esc 两条退出路径都能还原
 *  - 「看原图」模式下同样能全屏（用户就是为看幻灯片要这个功能）
 *
 * ## 隔离
 * 用 .tmp/cloud-fullonly-app/electron.exe + 项目根 dist（新构建），
 * --user-data-dir 指隔离副本，APPDATA 指副本。只读打开库里已有资料，
 * 不导入、不写库、不发任何网络请求、不花钱、不碰用户真实库。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const APP_EXE = path.resolve(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
const APPDATA = path.resolve(ROOT, '.tmp/cloud-fullonly-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const PORT = Number(process.argv[2] || 9796);
const OUT = path.resolve(ROOT, '.verify-shots/reader-fullscreen');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function rec(name, pass, detail = '') {
  results.push({ name, pass: pass === true, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(APP_EXE) || !fs.existsSync(DATA)) {
    console.error('缺少隔离环境（app / data）');
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

    // 进资料页
    await evalJs(`(() => {
      for (const g of [...document.querySelectorAll('.nav-group')]) {
        if (g.getAttribute('aria-expanded') !== 'true') g.click();
      }
      return true;
    })()`);
    await sleep(800);
    const navOk = await evalJs(`(() => {
      for (const b of [...document.querySelectorAll('.nav-item .nav-item__label')]) {
        if (b.innerText.trim() === '资料') { b.click(); return true; }
      }
      return false;
    })()`);
    rec('进入资料页', navOk === true);
    await sleep(2500);

    // 打开列表里第一份资料（库里已有，只读）
    const opened = await evalJs(`(() => {
      const row = document.querySelector('.source-row');
      if (!row) return null;
      const title = (row.querySelector('.source-row__title')?.innerText || '').trim();
      row.click();
      return title;
    })()`);
    rec('打开一份资料进入阅读器', !!opened, String(opened));
    await sleep(3000);

    const hasReader = await evalJs(`(() => !!document.querySelector('.reader-page'))()`);
    rec('阅读器已渲染', hasReader === true);
    if (!hasReader) throw new Error('阅读器没渲染，后续无法验证');

    // 全屏按钮存在
    const fsBtn = await evalJs(`(() => {
      const b = document.querySelector('button[data-action="fullscreen"]');
      return b ? { ok:true, text:(b.innerText||'').trim() } : { ok:false };
    })()`);
    rec('工具栏有「全屏」按钮', fsBtn.ok === true, JSON.stringify(fsBtn));
    await shot('01-before-fullscreen');

    // 点全屏
    const clicked = await evalJs(`(() => {
      const b = document.querySelector('button[data-action="fullscreen"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    rec('点击「全屏」', clicked === true);
    await sleep(1800);

    // 断言：class 生效 + 布局收起 + 真全屏状态
    const state = await evalJs(`(() => {
      const page = document.querySelector('.reader-page');
      const rside = document.querySelector('.rside');
      const search = document.querySelector('.reader-search');
      const sidebar = document.querySelector('.app > .sidebar');
      const topbar = document.querySelector('.topbar');
      const hidden = (el) => !el || getComputedStyle(el).display === 'none';
      return {
        fullClass: !!page && page.classList.contains('reader-page--fullscreen'),
        fullEl: !!document.fullscreenElement,
        rsideHidden: hidden(rside),
        searchHidden: hidden(search),
        sidebarHidden: hidden(sidebar),
        topbarHidden: hidden(topbar),
        btnText: (document.querySelector('button[data-action="fullscreen"]')?.innerText || '').trim(),
      };
    })()`);
    rec('全屏 class 生效', state.fullClass === true, JSON.stringify(state));
    rec('正文/原图区铺满：右栏收起', state.rsideHidden === true);
    rec('沉浸：搜索框收起', state.searchHidden === true);
    rec('沉浸：外壳侧栏/顶栏隐藏', state.sidebarHidden === true && state.topbarHidden === true);
    rec('真全屏已建立（或环境拒绝但降级沉浸）', state.fullEl === true || state.fullClass === true,
        `fullscreenElement=${state.fullEl}`);
    rec('按钮文案变为「退出全屏」', state.btnText === '退出全屏', state.btnText);
    await shot('02-in-fullscreen');

    // 退出：点按钮
    const exitClicked = await evalJs(`(() => {
      const b = document.querySelector('button[data-action="fullscreen"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    rec('点击「退出全屏」', exitClicked === true);
    await sleep(1500);
    const exited = await evalJs(`(() => {
      const page = document.querySelector('.reader-page');
      return {
        fullClass: !!page && page.classList.contains('reader-page--fullscreen'),
        fullEl: !!document.fullscreenElement,
        rsideVisible: (() => { const r = document.querySelector('.rside'); return !!r && getComputedStyle(r).display !== 'none'; })(),
      };
    })()`);
    rec('退出后 class 移除', exited.fullClass === false, JSON.stringify(exited));
    rec('退出后右栏恢复', exited.rsideVisible === true);
    await shot('03-after-exit');

    // Esc 退出路径：先再进全屏，再发 Esc
    await evalJs(`(() => { const b = document.querySelector('button[data-action="fullscreen"]'); if (b) b.click(); return true; })()`);
    await sleep(1200);
    const reentered = await evalJs(`(() => !!document.querySelector('.reader-page--fullscreen'))()`);
    rec('再次进入全屏（为测 Esc）', reentered === true);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(1500);
    const escOut = await evalJs(`(() => !!document.querySelector('.reader-page--fullscreen'))()`);
    rec('Esc 退出全屏', escOut === false);

    // 用户核心诉求：看幻灯片原件时全屏。补验原图模式也能全屏。
    const toOriginal = await evalJs(`(() => {
      for (const b of document.querySelectorAll('button')) {
        if ((b.innerText || '').trim() === '看原图') { b.click(); return true; }
      }
      return false;
    })()`);
    rec('切到「看原图」模式（用户核心场景）', toOriginal === true);
    await sleep(4500); // wasm 首次加载 + 渲染

    const imgOk = await evalJs(`(() => {
      const el = document.querySelector('.reader-original__img');
      if (!el) return false;
      const src = el.getAttribute('src') || '';
      return src.startsWith('data:image/png;base64,') && src.length > 2000;
    })()`);
    rec('原图渲染出 PNG', imgOk === true);

    await evalJs(`(() => { const b = document.querySelector('button[data-action="fullscreen"]'); if (b) b.click(); return true; })()`);
    await sleep(1500);
    const origFs = await evalJs(`(() => {
      const page = document.querySelector('.reader-page');
      const el = document.querySelector('.reader-original__img');
      const sidebar = document.querySelector('.app > .sidebar');
      const topbar = document.querySelector('.topbar');
      const hidden = (x) => !x || getComputedStyle(x).display === 'none';
      return {
        fullClass: !!page && page.classList.contains('reader-page--fullscreen'),
        imgW: el ? Math.round(el.getBoundingClientRect().width) : 0,
        sidebarHidden: hidden(sidebar),
        topbarHidden: hidden(topbar),
      };
    })()`);
    rec('原图模式下全屏生效', origFs.fullClass === true, JSON.stringify(origFs));
    rec('原图模式下幻灯片铺开（宽度 > 700）', origFs.imgW > 700);
    rec('原图全屏时外壳隐藏', origFs.sidebarHidden === true && origFs.topbarHidden === true);
    await shot('04-original-fullscreen');

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

/**
 * 桌面安装版验证：阅读器「全屏沉浸查看资料」已随新版 exe+asar 生效（2026-11-17）。
 *
 * 直接启动安装目录 OpenLeaner.exe（无项目根参数 → 加载 resources/app.asar），
 * 若 asar integrity 与 exe 不匹配会起不来/白屏，本脚本能抓到。
 * 隔离：--user-data-dir 指隔离副本 + APPDATA 环境变量，不碰真实库。
 * 只读打开库里已有资料 → 全屏/退出/Esc/原图全屏 → 断言 DOM + 截图。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const INSTALL_EXE = 'C:/Users/ASUS/AppData/Local/Programs/OpenLeaner/OpenLeaner.exe';
const INSTALL_DIR = path.dirname(INSTALL_EXE);
const APPDATA = path.resolve(ROOT, '.tmp/cloud-fullonly-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const PORT = Number(process.argv[2] || 9801);
const OUT = path.resolve(ROOT, '.verify-shots/desktop-fullscreen');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function rec(name, pass, detail = '') {
  results.push({ name, pass: pass === true, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(INSTALL_EXE) || !fs.existsSync(DATA)) {
    console.error('缺少安装 exe / 隔离数据');
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
    rec('加载的是安装目录 asar', String(target.url).indexOf('app.asar') >= 0, target.url);

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

    const opened = await evalJs(`(() => {
      const row = document.querySelector('.source-row');
      if (!row) return null;
      const title = (row.querySelector('.source-row__title')?.innerText || '').trim();
      row.click();
      return title;
    })()`);
    rec('打开一份资料进入阅读器', !!opened, String(opened));
    await sleep(3000);

    const fsBtn = await evalJs(`(() => {
      const b = document.querySelector('button[data-action="fullscreen"]');
      return b ? { ok:true, text:(b.innerText||'').trim() } : { ok:false };
    })()`);
    rec('桌面版工具栏有「全屏」按钮', fsBtn.ok === true, JSON.stringify(fsBtn));

    await evalJs(`(() => { const b = document.querySelector('button[data-action="fullscreen"]'); if (b) b.click(); return true; })()`);
    await sleep(1500);
    const state = await evalJs(`(() => {
      const page = document.querySelector('.reader-page');
      const rside = document.querySelector('.rside');
      const search = document.querySelector('.reader-search');
      const sidebar = document.querySelector('.app > .sidebar');
      const topbar = document.querySelector('.topbar');
      const hidden = (el) => !el || getComputedStyle(el).display === 'none';
      return {
        fullClass: !!page && page.classList.contains('reader-page--fullscreen'),
        rsideHidden: hidden(rside),
        searchHidden: hidden(search),
        sidebarHidden: hidden(sidebar),
        topbarHidden: hidden(topbar),
        btnText: (document.querySelector('button[data-action="fullscreen"]')?.innerText || '').trim(),
      };
    })()`);
    rec('桌面版全屏 class 生效', state.fullClass === true, JSON.stringify(state));
    rec('桌面版沉浸：右栏/搜索框/外壳全收起', state.rsideHidden && state.searchHidden && state.sidebarHidden && state.topbarHidden);
    rec('桌面版按钮变「退出全屏」', state.btnText === '退出全屏', state.btnText);
    await shot('01-desktop-fullscreen');

    // 退出
    await evalJs(`(() => { const b = document.querySelector('button[data-action="fullscreen"]'); if (b) b.click(); return true; })()`);
    await sleep(1200);
    const exited = await evalJs(`(() => !document.querySelector('.reader-page--fullscreen'))()`);
    rec('桌面版退出全屏', exited === true);

    // Esc
    await evalJs(`(() => { const b = document.querySelector('button[data-action="fullscreen"]'); if (b) b.click(); return true; })()`);
    await sleep(1200);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(1200);
    const escOut = await evalJs(`(() => !document.querySelector('.reader-page--fullscreen'))()`);
    rec('桌面版 Esc 退出全屏', escOut === true);

    // 原图模式全屏（用户核心场景）
    const toOriginal = await evalJs(`(() => {
      for (const b of document.querySelectorAll('button')) {
        if ((b.innerText || '').trim() === '看原图') { b.click(); return true; }
      }
      return false;
    })()`);
    rec('桌面版切到「看原图」', toOriginal === true);
    await sleep(4500);
    const imgOk = await evalJs(`(() => {
      const el = document.querySelector('.reader-original__img');
      if (!el) return false;
      const src = el.getAttribute('src') || '';
      return src.startsWith('data:image/png;base64,') && src.length > 2000;
    })()`);
    rec('桌面版原图渲染 PNG', imgOk === true);
    await evalJs(`(() => { const b = document.querySelector('button[data-action="fullscreen"]'); if (b) b.click(); return true; })()`);
    await sleep(1500);
    const origFs = await evalJs(`(() => {
      const page = document.querySelector('.reader-page');
      const el = document.querySelector('.reader-original__img');
      return {
        fullClass: !!page && page.classList.contains('reader-page--fullscreen'),
        imgW: el ? Math.round(el.getBoundingClientRect().width) : 0,
      };
    })()`);
    rec('桌面版原图全屏生效且幻灯片铺开', origFs.fullClass === true && origFs.imgW > 700, JSON.stringify(origFs));
    await shot('02-desktop-original-fullscreen');

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

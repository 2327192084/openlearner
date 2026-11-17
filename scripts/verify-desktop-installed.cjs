/**
 * 验证「桌面安装版」更新是否生效（2026-11-17）。
 *
 * 与 verify-cloud-fullonly-ui.cjs 的区别：
 * - 那个脚本启动 .tmp 里复制的 electron.exe + 项目根 dist（验证源码逻辑）；
 * - 本脚本直接启动桌面安装目录里的 OpenLeaner.exe，
 *   它加载的是刚替换进去的 resources/app.asar（新 exe + 新 asar 同批配套）。
 *   若 asar integrity 不匹配，应用会起不来 / 白屏 —— 本脚本能抓到。
 *
 * 隔离：用 --user-data-dir 指到隔离副本（从真实库只读复制），
 * 并设 APPDATA 环境变量，绝不碰用户真实库。真实库基线在替换前后已比对未变。
 *
 * 不花钱：只切引擎、看 DOM、截图，不点解析按钮、不发 OCR 请求。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const INSTALL_EXE = 'C:/Users/ASUS/AppData/Local/Programs/OpenLeaner/OpenLeaner.exe';
const INSTALL_DIR = path.dirname(INSTALL_EXE);
const APPDATA = path.resolve(ROOT, '.tmp/cloud-fullonly-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const PORT = Number(process.argv[2] || 9791);
const OUT = path.resolve(ROOT, '.verify-shots/desktop-installed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function rec(name, pass, detail = '') {
  results.push({ name, pass: pass === true, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(INSTALL_EXE) || !fs.existsSync(DATA)) {
    console.error('缺少：桌面 exe 或隔离数据副本');
    process.exit(2);
  }

  // 不带项目根参数 —— 让安装版 exe 按生产逻辑加载自己的 resources/app.asar
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
      console.error('桌面应用没起来（可能是 asar integrity 不匹配），日志尾部：\n' + appLog.slice(-3000));
      throw new Error('桌面应用没起来');
    }
    rec('桌面安装版正常启动（asar integrity 配套）', true, target.url);

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
    await sleep(4500);

    // 进「文档解析」页
    await evalJs(`(() => {
      for (const g of [...document.querySelectorAll('.nav-group')]) {
        if (g.getAttribute('aria-expanded') !== 'true') g.click();
      }
      return true;
    })()`);
    await sleep(1200);
    const navOk = await evalJs(`(() => {
      for (const b of [...document.querySelectorAll('.nav-item')]) {
        const l = b.querySelector('.nav-item__label');
        if (l && l.innerText.trim() === '文档解析') { b.click(); return true; }
      }
      return false;
    })()`);
    rec('进入文档解析页', navOk === true);
    await sleep(3000);

    // 选一份 PDF 资料
    const picked = await evalJs(`(() => {
      const rows = [...document.querySelectorAll('.pp-source')];
      if (!rows.length) return { ok:false, all:[] };
      const all = rows.map(r => r.innerText.replace(/\\s+/g,' ').slice(0, 60));
      const r = rows.find(x => x.innerText.indexOf('信号与系统') >= 0) || rows[0];
      r.click();
      return { ok:true, picked: all[rows.indexOf(r)], all };
    })()`);
    rec('选中 PDF 资料', picked && picked.ok === true, picked ? (picked.picked || JSON.stringify(picked.all)) : '');
    await sleep(2200);

    const engineRadios = await evalJs(`(() => [...document.querySelectorAll('input[name="parse-engine"]')].map(r => ({ value:r.value, disabled:r.disabled })))()`);
    rec('云 OCR 引擎可选', Array.isArray(engineRadios) && engineRadios.some((r) => r.value === 'deepseek' && !r.disabled));

    // 切到云 OCR（必须点 input 本身，点 label 不触发 React onChange）
    const cloud = await evalJs(`(() => {
      const r = document.querySelector('input[name="parse-engine"][value="deepseek"]');
      if (!r || r.disabled) return 'unavailable';
      r.click();
      return r.checked ? 'ok' : 'not-checked';
    })()`);
    rec('点击云 OCR 引擎', cloud === 'ok', String(cloud));
    await sleep(6000);

    const probe = `(() => {
      const q = (s) => document.querySelectorAll(s).length;
      const cs = (s) => { const e = document.querySelector(s); return e ? (e.innerText || '').trim() : ''; };
      const buttons = [...document.querySelectorAll('.convert-panel button')].map(b => (b.innerText || '').trim()).filter(Boolean);
      return {
        modes: q('.prp__modes'),
        parseModeInputs: q('input[name="parse-mode"]'),
        range: q('.prp__range'),
        buttons,
        warnText: cs('.engine-opt--on .engine-opt__warn'),
        panelText: cs('.convert-panel').slice(0, 400)
      };
    })()`;
    const cloudState = await evalJs(probe);
    console.log('桌面云 OCR 状态:', JSON.stringify(cloudState, null, 2));
    rec('桌面版：云 OCR 无完整/分片单选', cloudState.modes === 0 && cloudState.parseModeInputs === 0,
      `modes=${cloudState.modes}, inputs=${cloudState.parseModeInputs}`);
    rec('桌面版：云 OCR 无页码范围输入', cloudState.range === 0, `range=${cloudState.range}`);
    rec('桌面版：引擎卡片无「大书建议先分批」', cloudState.warnText.indexOf('大书建议先分批') < 0,
      cloudState.warnText);
    rec('桌面版：引擎卡片写「只支持整本」', cloudState.warnText.indexOf('只支持整本') >= 0, cloudState.warnText);
    rec('桌面版：面板无「用分片解析再跑一次」', cloudState.panelText.indexOf('用下面的「分片解析」再跑一次') < 0);
    await shot('desktop-cloud-fullonly');

    // 对照：切回本机 MinerU，单选必须回来
    const local = await evalJs(`(() => {
      const r = document.querySelector('input[name="parse-engine"][value="local"]');
      if (!r || r.disabled) return 'unavailable';
      r.click();
      return r.checked ? 'ok' : 'not-checked';
    })()`);
    rec('点击本机 MinerU 引擎', local === 'ok', String(local));
    await sleep(2500);
    const localState = await evalJs(probe);
    rec('桌面版：本机 MinerU 完整/分片单选恢复', localState.modes === 1 && localState.parseModeInputs === 2,
      `modes=${localState.modes}, inputs=${localState.parseModeInputs}`);
    await shot('desktop-local-range');
  } catch (e) {
    rec('脚本执行', false, e && e.stack ? e.stack : String(e));
  } finally {
    try { if (webSocket) webSocket.close(); } catch {}
    try { app.kill(); } catch {}
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) {
    console.log('失败项:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
})();

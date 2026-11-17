/**
 * CDP 复核：选「DeepSeek 云 OCR」时不再显示「完整/分片」解析单选，
 * 只提供整本解析；切回本机 MinerU 时单选仍正常出现（证明没误伤本地路径）。
 *
 * ## 为什么必须用真实界面
 *
 * 单测验不到这次改动：`fullOnly` 是渲染分支，断言的是 DOM 里有没有
 * `.prp__modes`。改了界面就必须 CDP 截图肉眼复核（项目硬约束）。
 *
 * ## 隔离
 *
 * 不碰用户真实库：IndexedDB/Local Storage 从 %APPDATA%/OpenLeaner
 * 只读复制到 .tmp/cloud-fullonly-appdata/OpenLeaner；APPDATA 环境变量
 * 指到这个副本。electron.exe 从 .tmp/cloud-fullonly-app 启动（旁边没有
 * openleaner-data，避开 ensureUserDataDir 的第 4 候选抢先）。
 * 页面走 `electron.exe <项目根>` → 加载**新构建的 dist**，
 * 不是 release/win-unpacked 里的旧 asar。
 *
 * 不花钱：只切引擎、看 DOM、截图，不点解析按钮、不发 OCR 请求。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const APP_EXE = path.resolve(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
const APPDATA = path.resolve(ROOT, '.tmp/cloud-fullonly-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const PORT = Number(process.argv[2] || 9783);
const OUT = path.resolve(ROOT, '.verify-shots/cloud-fullonly');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function rec(name, pass, detail = '') {
  results.push({ name, pass: pass === true, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(APP_EXE) || !fs.existsSync(DATA)) {
    console.error('缺少隔离环境：先准备 .tmp/cloud-fullonly-app 与 .tmp/cloud-fullonly-appdata/OpenLeaner');
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
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }
    if (!target) {
      console.error('应用没起来，日志尾部：\n' + appLog.slice(-3000));
      throw new Error('应用没起来');
    }
    console.log(`target: ${target.url}`);

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
    const shot = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(4500);

    /* 进「文档解析」页 */
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

    /* 选一份 PDF 资料 */
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

    /* 引擎选择器存在吗 */
    const engineRadios = await evalJs(`(() => [...document.querySelectorAll('input[name="parse-engine"]')].map(r => ({ value:r.value, disabled:r.disabled })))()`);
    console.log('引擎选项:', JSON.stringify(engineRadios));
    rec('云 OCR 引擎可选', Array.isArray(engineRadios) && engineRadios.some((r) => r.value === 'deepseek' && !r.disabled));

    /* 切到云 OCR —— 必须点 input 本身（见 verify-ocr-413-ui.cjs:192-196 的坑） */
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
      const checked = document.querySelector('input[name="parse-engine"]:checked');
      return {
        engine: checked ? checked.value : null,
        prp: q('.prp'),
        modes: q('.prp__modes'),
        parseModeInputs: q('input[name="parse-mode"]'),
        range: q('.prp__range'),
        note: cs('.prp__note'),
        prpText: cs('.prp'),
        buttons,
        panelText: cs('.convert-panel').slice(0, 600)
      };
    })()`;

    const cloudState = await evalJs(probe);
    console.log('云 OCR 状态:', JSON.stringify(cloudState, null, 2));
    rec('云 OCR：无完整/分片单选', cloudState.modes === 0 && cloudState.parseModeInputs === 0,
      `modes=${cloudState.modes}, parse-mode inputs=${cloudState.parseModeInputs}`);
    rec('云 OCR：无页码范围输入', cloudState.range === 0, `range=${cloudState.range}`);
    rec('云 OCR：按钮写整本识别', cloudState.buttons.some((t) => t.indexOf('识别') >= 0 || t.indexOf('整本') >= 0),
      JSON.stringify(cloudState.buttons));
    rec('云 OCR：只剩整本解析（无非整本 UI）', cloudState.prp === 1 || cloudState.prpText.length === 0,
      `prp=${cloudState.prp}`);
    await shot('cloud-fullonly');

    /* 对照：切回本机 MinerU，单选必须回来 */
    const local = await evalJs(`(() => {
      const r = document.querySelector('input[name="parse-engine"][value="local"]');
      if (!r || r.disabled) return 'unavailable';
      r.click();
      return r.checked ? 'ok' : 'not-checked';
    })()`);
    rec('点击本机 MinerU 引擎', local === 'ok', String(local));
    await sleep(2500);
    const localState = await evalJs(probe);
    console.log('本机 MinerU 状态:', JSON.stringify(localState, null, 2));
    rec('本机 MinerU：完整/分片单选恢复', localState.modes === 1 && localState.parseModeInputs === 2,
      `modes=${localState.modes}, inputs=${localState.parseModeInputs}`);
    rec('本机 MinerU：默认整本时不显示页码范围（切分片才显示）', localState.range === 0,
      `range=${localState.range}`);
    /* 本机 MinerU 再点「分片解析」（radio 无 value 属性，按 label 文案找），页码范围输入必须出现 */
    const switchedRange = await evalJs(`(() => {
      const labels = [...document.querySelectorAll('.prp__mode')];
      const label = labels.find(l => (l.innerText || '').indexOf('分片解析') >= 0);
      const r = label && label.querySelector('input[type="radio"]');
      if (!r || r.disabled) return 'unavailable';
      r.click();
      return r.checked ? 'ok' : 'not-checked';
    })()`);
    await sleep(1200);
    const rangeState = await evalJs(probe);
    rec('本机 MinerU：切分片后页码范围输入出现', switchedRange === 'ok' && rangeState.range === 1,
      `switched=${switchedRange}, range=${rangeState.range}`);
    await shot('local-range-picker');
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

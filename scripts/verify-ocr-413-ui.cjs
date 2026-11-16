/**
 * 验证 413 的新提示真的会显示到界面上（2026-11-16）。
 *
 * ## 为什么不能只靠单测
 *
 * 单测验的是 `runOcr` 返回的 reason 字符串对不对。
 * 但用户看到的是**界面上那段红字** —— 从 reason 到界面之间还有：
 * ConvertPanel 的 catch → setPhase({hint}) → 渲染。
 * 中间任何一环丢了，单测全绿也没用（这个项目栽过多次）。
 *
 * ## 做法
 *
 * 用真实桌面版 + 隔离副本，把 window.fetch 临时包一层：
 * 当请求打到 /v1/tools/ocr 时，不真的发出去，直接返回一个
 * **openresty 的 413 HTML**（与实测拿到的响应逐字一致）。
 * 然后在界面上点「解析」，看红字说什么。
 *
 * 这样验证的是完整链路，且**不花一分钱、不碰用户库**。
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
const PORT = Number(arg('port', '9750'));
const OUT = path.resolve(ROOT, arg('out', '.verify-shots/ocr-fix-20261116'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 实测拿到的 openresty 413 响应体，逐字照抄 */
const GATEWAY_413_HTML = `<!doctype html><html>
<head><title>413 Request Entity Too Large</title></head>
<body>
<center><h1>413 Request Entity Too Large</h1></center>
<hr><center>openresty</center>
</body>
</html>
`;

const results = [];
function rec(name, pass, detail = '') {
  results.push({ name, pass: pass === true, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!DATA || !fs.existsSync(DATA)) {
    console.error('用法: --data <数据目录副本>');
    process.exit(2);
  }

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
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(4000);

  /* ---- 1. 装一个拦截器：打 /v1/tools/ocr 就回 413 HTML ---- */
  const installed = await evalJs(`(() => {
    if (window.__ocrInterceptInstalled) return 'already';
    window.__ocrInterceptInstalled = true;
    const orig = window.fetch.bind(window);
    window.__ocrRealFetch = orig;
    window.__ocrIntercepted = 0;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/v1/tools/ocr') >= 0) {
        window.__ocrIntercepted += 1;
        return Promise.resolve(new Response(${JSON.stringify(GATEWAY_413_HTML)}, {
          status: 413,
          headers: { 'content-type': 'text/html', server: 'openresty' },
        }));
      }
      return orig(input, init);
    };
    return 'ok';
  })()`);
  rec('拦截器装上', installed === 'ok' || installed === 'already', String(installed));

  /* ---- 2. 进「文档解析」页 ----
   *
   * ⚠️ 展开分组与点击导航必须**分两次 eval 执行**，中间等 React 重渲染。
   *
   * 第一版脚本把「展开所有分组」和「找导航项」写在同一个表达式里，
   * 结果 click() 只是排入了 React 的更新队列，同一帧里 DOM 还没变 ——
   * 于是 `.nav-item__label` 一个都查不到，报 not-found，
   * 页面停在「学习库」而脚本却继续往下跑，整轮验证等于没验。
   * 这是「验证脚本自己会错」的又一例（本项目已记录多次）。
   */
  await evalJs(`(() => {
    for (const g of [...document.querySelectorAll('.nav-group')]) {
      if (g.getAttribute('aria-expanded') !== 'true') g.click();
    }
    return true;
  })()`);
  await sleep(1200); /* 等 React 把折叠组的内容挂进 DOM */

  const navState = await evalJs(`(() => {
    const labels = [...document.querySelectorAll('.nav-item__label')].map(
      (el) => el.innerText.trim(),
    );
    return { count: labels.length, hasParse: labels.indexOf('文档解析') >= 0, labels };
  })()`);
  rec(
    '侧栏展开后能看到「文档解析」',
    navState.hasParse === true,
    `共 ${navState.count} 项`,
  );

  const navOk = await evalJs(`(() => {
    for (const b of [...document.querySelectorAll('.nav-item')]) {
      const label = b.querySelector('.nav-item__label');
      if (label && label.innerText.trim() === '文档解析') { b.click(); return 'ok'; }
    }
    return 'not-found';
  })()`);
  await sleep(2500);

  /* 复核：真的到了那一页吗（判据贴真实界面，不贴脚本自己的变量） */
  const landed = await evalJs(
    `(document.querySelector('.topbar__title') || {}).innerText || ''`,
  );
  rec('进入「文档解析」页', navOk === 'ok' && landed === '文档解析', `顶栏=${landed}`);

  /* ---- 3. 选「云 OCR」这条路 ----
   *
   * ⚠️ 必须点 `input[type=radio][value=deepseek]` 本身。
   * 第一版脚本是「找含『DeepSeek 云 OCR』字样的元素再点」，
   * 结果点到了外层 label，而 React 的 onChange 挂在 input 上 ——
   * 引擎根本没切换，后面点的还是 MinerU 按钮，整轮验证等于没验。
   * 这是「验证脚本自己会错」的又一例。
   */
  const radioState = await evalJs(`(() => {
    const radios = [...document.querySelectorAll('input[name="parse-engine"]')];
    if (radios.length === 0) {
      /* 把页面结构报出来，便于判断到底是没渲染还是没进去 */
      return {
        kind: 'no-radio',
        hasEnginePick: !!document.querySelector('.engine-pick'),
        hasConvertPanel: !!document.querySelector('.convert-panel'),
        hashTitle: (document.querySelector('.topbar__title') || {}).innerText || '',
        bodyHead: document.body.innerText.slice(0, 160).replace(/\\s+/g, ' '),
      };
    }
    const radio = document.querySelector('input[name="parse-engine"][value="deepseek"]');
    if (!radio) return { kind: 'no-deepseek-radio', values: radios.map(r => r.value) };
    if (radio.disabled) return { kind: 'disabled' };
    radio.click();
    return { kind: radio.checked ? 'ok' : 'clicked-not-checked' };
  })()`);
  rec('切到「DeepSeek 云 OCR」', radioState.kind === 'ok', JSON.stringify(radioState).slice(0, 300));

  /*
   * 等云端 runner 建好再点。
   *
   * ⚠️ 这一段是踩出来的，判据选错过一次：
   *
   * 第一版：切完只睡 2.5 秒就点 → runner 还没建好（异步读凭据+原文件，
   *         实测 3~5 秒），ConvertPanel 回落到本地 runner，
   *         界面显示「正在启动 MinerU…」，看着像产品 bug，其实是抢跑。
   *
   * 第二版：改成等「按钮文案变成『用 DeepSeek 云 OCR 识别』」→ **没用**，
   *         因为按钮文案只看 `engine` prop，不看 runner 有没有建好。
   *         文案立刻就变了，判据 0ms 通过，然后照样抢跑。
   *         这就是「判据要贴真实状态，不能贴自己的数据结构」那条。
   *
   * 第三版（现在）：直接问那一份资料的原文件能不能读到 ——
   * runner 建好后 readFile 才可用。用「点一下看结果」太慢，
   * 改成固定的保守等待 + 点完后复核 fetch 有没有被打到。
   * 反正点错了也只是显示本地那条路的错误，不影响用户数据。
   */
  console.log('  等云端 runner 建好（保守等 6 秒）…');
  await sleep(6000);

  /* ---- 4. 点「开始/解析」按钮 ----
   *
   * ⚠️ 按钮文案随引擎变（2026-11-16 修完这个 bug 之后）：
   *  本地 → 「用本机 MinerU 转成正文」
   *  云端 → 「用 DeepSeek 云 OCR 识别」
   * 第一版只找含「解析」的按钮，云端这条路一个都匹配不到 →
   * 点了空，拦截次数 0，整轮又等于没验。
   * 所以这里按**多个关键词**匹配，并优先取 .convert-panel 里的主按钮。
   */
  const clicked = await evalJs(`(() => {
    const panel = document.querySelector('.convert-panel');
    const scope = panel || document;
    const btns = [...scope.querySelectorAll('button')];
    const names = btns.map(b => b.innerText.trim()).filter(Boolean);
    for (const b of btns) {
      const t = b.innerText.trim();
      if (b.disabled) continue;
      if (t.indexOf('解析') >= 0 || t.indexOf('识别') >= 0 || t.indexOf('转成正文') >= 0) {
        b.click();
        return t;
      }
    }
    return '(没有可点的按钮: ' + names.join(' / ') + ')';
  })()`);
  console.log(`  点了按钮: 「${clicked}」`);
  await sleep(8000);

  /* ---- 5. 读界面上的红字 ---- */
  const ui = await evalJs(`(() => {
    const panel = document.querySelector('.convert-panel');
    const txt = panel ? panel.innerText : document.body.innerText;
    return {
      intercepted: window.__ocrIntercepted || 0,
      text: txt,
    };
  })()`);

  console.log(`  拦截命中次数: ${ui.intercepted}`);
  rec('请求确实被拦截（走到云 OCR 那条路）', ui.intercepted > 0, `${ui.intercepted} 次`);

  const hasGateway = ui.text.indexOf('网关') >= 0;
  const hasWrongClaim = /文件超过 100 MiB/.test(ui.text);
  const hasSentSize = /5\d\.\d MiB/.test(ui.text);
  const hasMineruHint = ui.text.indexOf('MinerU') >= 0;

  console.log('\n  --- 界面上的提示 ---');
  console.log(
    ui.text
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 14)
      .map((l) => `  | ${l}`)
      .join('\n'),
  );
  console.log('  ----------------------\n');

  /* 否定断言：不许再出现「文件超过 100 MiB」 */
  rec('★ 界面不再说「文件超过 100 MiB」', hasWrongClaim === false);
  rec('★ 界面说清了这是「网关」的限制', hasGateway === true);
  rec('★ 界面写出了实际发送的体积', hasSentSize === true);
  rec('提示指向可用的替代做法（MinerU）', hasMineruHint === true);

  await shot('ocr-413-ui');

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;

  app.kill();
  try {
    spawn('taskkill', ['/F', '/IM', 'OpenLeaner.exe'], { stdio: 'ignore' });
  } catch {
    /* 忽略 */
  }
  await sleep(600);
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('验证失败:', e.message);
  process.exit(2);
});
/**
 * 批量截取主要页面，供 UI 复核（2026-11-10）。
 *
 * 为什么需要它：用户要求「美化 UI」，而美化最容易变成凭感觉改。
 * 硬约束第 5 条写着「改界面必须 CDP 截图肉眼复核」，
 * 所以先把当前状态**一次性拍下来**，改完再用同样的命令拍一次对比。
 *
 * 一页一页手点脚本很慢且容易漏，这里按侧栏分组把所有 ready 页走一遍。
 *
 * 用法：
 *   node scripts/shot-pages.cjs --app release/win-unpacked --data .tmp/<副本> [--only today,sources]
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_URL_PREFIX = 'file://';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APP_DIR = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA_DIR = path.resolve(ROOT, arg('data', '.tmp/shot-data'));
const PORT = Number(arg('port', '9980'));
const OUT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/pages'));
const ONLY = arg('only', '');
const W = Number(arg('width', '1440'));
const H = Number(arg('height', '900'));

const APP_EXE = path.join(APP_DIR, 'OpenLeaner.exe');
if (!fs.existsSync(APP_EXE)) {
  console.error(`找不到打包产物: ${APP_EXE}`);
  process.exit(2);
}
if (!fs.existsSync(DATA_DIR)) {
  console.error(`数据目录不存在: ${DATA_DIR}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let app = null;
  try {
    app = spawn(
      APP_EXE,
      [
        `--user-data-dir=${DATA_DIR}`,
        '--no-sandbox',
        `--remote-debugging-port=${PORT}`,
        `--window-size=${W},${H}`,
      ],
      { stdio: 'ignore' },
    );

    let page = null;
    for (let i = 0; i < 120; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find(
          (t) =>
            t.type === 'page' &&
            t.webSocketDebuggerUrl &&
            typeof t.url === 'string' &&
            t.url.indexOf(APP_URL_PREFIX) === 0,
        );
        if (page) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }
    if (!page) throw new Error('应用没起来');

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
            reject(new Error(`CDP 超时: ${method}`));
          }
        }, 30000);
      });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(4000);

    /* 先列出侧栏能点到的页（含分组展开） */
    const pages = await evalJs(`(() => {
      /* 展开所有分组，否则拿不到收起组里的项 */
      for (const g of [...document.querySelectorAll('.nav-group')]) {
        if (g.getAttribute('aria-expanded') === 'false') g.click();
      }
      const out = [...document.querySelectorAll('.nav-item__label')].map(el => el.innerText.trim());
      return out;
    })()`);
    await sleep(800);

    const wanted = ONLY
      ? ONLY.split(',').map((s) => s.trim()).filter(Boolean)
      : pages.filter((p) => p && p !== '开始学习');

    console.log(`将截取 ${wanted.length} 页: ${wanted.join(' / ')}\n`);

    const results = [];
    for (const label of wanted) {
      const clicked = await evalJs(`(() => {
        for (const g of [...document.querySelectorAll('.nav-group')]) {
          if (g.getAttribute('aria-expanded') === 'false') g.click();
        }
        const labels = [...document.querySelectorAll('.nav-item__label')];
        const hit = labels.find(el => el.innerText.trim() === ${JSON.stringify(label)});
        if (!hit) return false;
        hit.closest('button').click();
        return true;
      })()`);
      if (!clicked) {
        console.log(`  跳过「${label}」：侧栏找不到`);
        continue;
      }
      await sleep(2200);

      /* 取一页的基本信息，便于判断「是不是空页」 */
      const info = await evalJs(`(() => {
        const h = document.querySelector('h1, .page-title, .kb-title, .bk-title');
        const body = document.body.innerText || '';
        return {
          title: h ? h.innerText.trim() : null,
          len: body.length,
          /* 空态的特征词：有它就说明这一页没内容 */
          empty: /还是空的|还没有|没有可|暂无可/.test(body.slice(0, 1200)),
        };
      })()`);

      const safe = label.replace(/[\\/:*?"<>|\n]/g, '_');
      const s = await send('Page.captureScreenshot', { format: 'png' });
      const p = path.join(OUT_DIR, `${safe}.png`);
      fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
      results.push({ label, title: info.title, empty: info.empty, file: path.basename(p) });
      console.log(`  ✅ ${label}  (${info.title || '无标题'}${info.empty ? ' · 空态' : ''}) → ${path.basename(p)}`);
    }

    console.log(`\n共 ${results.length} 张，输出目录: ${path.relative(ROOT, OUT_DIR)}`);
    console.log(`空态的页: ${results.filter((r) => r.empty).map((r) => r.label).join(' / ') || '（无）'}`);
  } catch (e) {
    console.error('截图失败:', e.message);
    process.exitCode = 1;
  } finally {
    try {
      app && app.kill();
    } catch {
      /* ignore */
    }
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/F', '/IM', 'OpenLeaner.exe'], { stdio: 'ignore' });
      } catch {
        /* ignore */
      }
    }
    await sleep(600);
  }
})();

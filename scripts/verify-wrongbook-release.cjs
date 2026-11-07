/**
 * 用**真实发布包**验证「错题与待巩固」页。
 *
 * 与 smoke-release.cjs 的分工：那个只验「能启动、三模式在」；
 * 这个专门验新做的错题页：入口能点、数据能读、筛选与排序可用、布局正常。
 *
 * 只读，不写任何记录。
 *
 * 用法：node scripts/verify-wrongbook-release.cjs [--port 9530]
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APP = path.resolve(ROOT, arg('target', 'release/win-unpacked'));
const PORT = Number(arg('port', '9530'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  const app = spawn(
    path.join(APP, 'OpenLeaner-Launcher.bat'),
    [`--remote-debugging-port=${PORT}`],
    { cwd: APP, stdio: 'ignore', shell: true },
  );

  let code = 0;
  try {
    let page = null;
    for (let i = 0; i < 100; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
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
    const evalJs = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const click = (label) =>
      evalJs(`(() => {
        const els = [...document.querySelectorAll('button, a, [role="button"]')];
        const hit = els.find(el => (el.innerText || '').trim().split('\\n')[0] === ${JSON.stringify(label)})
                 || els.find(el => (el.innerText || '').includes(${JSON.stringify(label)}));
        if (!hit) return false;
        hit.click();
        return true;
      })()`);

    await send('Runtime.enable');
    await sleep(3000);

    // ---- 进入错题页 ----
    const entered = await click('错题与待巩固');
    record('侧栏能点进「错题与待巩固」', entered === true);
    await sleep(1800);

    const heading = await evalJs("document.querySelector('.wbk-title')?.innerText ?? ''");
    record('页面标题正确', heading === '错题与待巩固', heading);

    const rows = await evalJs("document.querySelectorAll('.wbk-item').length");
    record('列出了错题', rows > 0, `${rows} 道`);

    // ---- 布局：每行不能是竖条（这是之前踩过的 bug）----
    const layout = await evalJs(`(() => {
      const item = document.querySelector('.wbk-item');
      const prompt = document.querySelector('.wbk-item__prompt');
      if (!item || !prompt) return null;
      const ir = item.getBoundingClientRect();
      const pr = prompt.getBoundingClientRect();
      return {
        itemW: Math.round(ir.width),
        itemH: Math.round(ir.height),
        promptW: Math.round(pr.width),
        display: getComputedStyle(item).display,
      };
    })()`);
    record(
      '题目卡片是横向铺开的（不是被压成竖条）',
      layout !== null && layout.promptW > 200 && layout.itemH < 900,
      layout ? `卡片 ${layout.itemW}×${layout.itemH}，题干宽 ${layout.promptW}` : '找不到元素',
    );

    // ---- 筛选与排序可用 ----
    const hasFilter = await evalJs("!!document.querySelector('.wbk-select')");
    record('有题组筛选下拉', hasFilter === true);

    const sortCount = await evalJs("document.querySelectorAll('.wbk-sort__btn').length");
    record('有三种排序方式', sortCount === 3, `${sortCount} 个`);

    // 点「最近错的」应重排（不报错即可，顺序本身依赖数据）
    const sortClicked = await evalJs(`(() => {
      const b = [...document.querySelectorAll('.wbk-sort__btn')].find(x => x.innerText.includes('最近错的'));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(600);
    const afterSort = await evalJs("document.querySelectorAll('.wbk-item').length");
    record('切换排序后列表仍在', sortClicked === true && afterSort === rows, `${afterSort} 道`);

    // ---- 指向做题入口 ----
    const goPractice = await evalJs(
      "[...document.querySelectorAll('button')].some(b => b.innerText.includes('去练错题'))",
    );
    record('有「去练错题」入口', goPractice === true);

    // ---- 白边回归检查 ----
    const bodyBg = await evalJs('getComputedStyle(document.body).backgroundColor');
    const rgb = bodyBg.replace(/[^0-9,]/g, '').split(',').map(Number);
    const isDark = rgb.length >= 3 && rgb[0] < 60 && rgb[1] < 60 && rgb[2] < 60;
    record('页面底色仍是深色（无白边）', isDark, bodyBg);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, '.verify-shots', 'released-wrongbook.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n截图: .verify-shots/released-wrongbook.png');
  } catch (e) {
    console.error('失败:', e.message);
    code = 1;
  } finally {
    try {
      spawn('taskkill', ['/IM', 'OpenLeaner.exe', '/F'], { stdio: 'ignore', shell: true });
    } catch {
      /* ignore */
    }
    await sleep(1500);
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n结果: ${pass}/${results.length} 通过`);
    if (pass !== results.length) code = 1;
  }
  process.exit(code);
})();

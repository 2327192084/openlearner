/**
 * 用**用户真实安装目录**做一次冒烟验证：确认发布的包真的能跑、新功能真的在。
 *
 * ## 为什么单独写这一个
 *
 * publish-asar.cjs 只证明了「文件写进去了」，
 * 但「写进去的能不能跑起来」是另一件事 —— 历史上踩过：
 * asar 内容对、样式文件缺、界面打开一片空白。
 *
 * 所以这里直接启动 release/win-unpacked 里的 exe（和快捷方式同一条路径），
 * 用 CDP 看界面，并截图留证。
 *
 * ## 不会污染用户数据
 *
 * 只做「打开 → 切到做题页 → 读文字 → 截图」，**不提交任何答案**，
 * 不写任何记录。所以不需要复制数据目录。
 *
 * 用法：node scripts/smoke-release.cjs [--port 9470]
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
const PORT = Number(arg('port', '9470'));
const SHOT = path.join(ROOT, '.verify-shots', 'released-app.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  /*
   * 启动方式必须和用户点快捷方式一致：走 launcher（传 --no-sandbox）。
   * 直接 spawn exe 在这台机器上会 exit 3 静默退出 ——
   * 那会让人误判成「打出来的包是坏的」。
   */
  /*
   * 走 launcher（和用户点快捷方式同一路径），并用 %* 把调试端口传进去。
   * launcher 最后一行是 `start "" "%EXE%" --no-sandbox %*`，所以参数会透传。
   */
  const app = spawn(
    path.join(APP, 'OpenLeaner-Launcher.bat'),
    [`--remote-debugging-port=${PORT}`],
    {
      cwd: APP,
      stdio: 'ignore',
      shell: true,
    },
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
    if (!page) throw new Error('应用没起来（CDP 连不上）—— launcher 或包有问题');

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
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      }
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

    // ---- 1. 页面能打开、有内容 ----
    const bodyLen = await evalJs('document.body.innerText.trim().length');
    record('应用启动并渲染出界面', bodyLen > 50, `正文 ${bodyLen} 字`);

    const hasBrand = await evalJs("document.body.innerText.includes('OpenLeaner')");
    record('侧栏品牌可见', hasBrand === true);

    // ---- 2. 进做题页，确认三种模式 ----
    await click('开始学习');
    await sleep(1000);
    await click('开始做题');
    await sleep(1500);

    const tabs = await evalJs(
      "[...document.querySelectorAll('.practice-tab')].map(t => t.innerText.replace(/\\s*\\d+\\s*$/,'').trim())",
    );
    record(
      '三种做题模式都在',
      ['今日题组', '自由练习', '错题巩固'].every((t) => tabs.includes(t)),
      tabs.join(' / '),
    );

    // ---- 3. 样式的确加载了（不是白板）----
    const styled = await evalJs(`(() => {
      const t = document.querySelector('.practice-tab');
      if (!t) return null;
      const cs = getComputedStyle(t);
      return { font: cs.fontSize, color: cs.color, display: cs.display };
    })()`);
    /*
     * 判断「样式真的加载了」用的是**字号不是浏览器默认值**，
     * 而不是某个具体的 display 值。
     *
     * 一开始我断言 display === 'inline-flex'，实测是 'flex' ——
     * 那是外层容器（.practice-tabs）的 flex 布局影响了子项，
     * 并不是样式没生效。用会被布局影响的属性做断言，测的是浏览器行为，
     * 不是「CSS 有没有加载」这件事，所以换成字号/颜色这类
     * 只可能来自样式的证据（浏览器默认正文字号是 16px）。
     */
    const styledOk =
      styled !== null && styled.font !== '16px' && styled.color !== 'rgb(0, 0, 0)';
    record(
      '样式已加载（不是裸 HTML）',
      styledOk,
      styled ? `fontSize=${styled.font} color=${styled.color}` : '找不到元素',
    );

    // ---- 4. 数据在（用户自己的库没被换掉）----
    const counts = await evalJs(`(async () => {
      const d = await new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const out = {};
      for (const s of ['questions', 'knowledgePoints', 'decks', 'sources']) {
        out[s] = await new Promise((res, rej) => {
          const tx = d.transaction(s, 'readonly');
          const q = tx.objectStore(s).count();
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
      }
      return out;
    })()`);
    record(
      '用户原有数据仍在',
      counts.questions > 0 && counts.sources > 0,
      `题 ${counts.questions} / 知识点 ${counts.knowledgePoints} / 题组 ${counts.decks} / 资料 ${counts.sources}`,
    );

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`\n截图: ${path.relative(ROOT, SHOT)}`);
  } catch (e) {
    console.error('失败:', e.message);
    code = 1;
  } finally {
    /* 关掉应用：launcher 起的是独立进程，用 taskkill 确保整棵树都退掉 */
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

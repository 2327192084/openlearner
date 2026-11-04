/**
 * 复现 Electron file:// 下的路由行为。
 *
 * 不启动 Electron（本会话无法建窗口），而是用无头浏览器直接打开
 * file:// 协议的 dist/index.html —— 这正是 Electron loadFile 做的事。
 * 这样能真实复现「生产包一打开是什么页面」。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const PORT = 9223;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    }
    return res.result.value;
  }
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) break;
    } catch {
      /* wait */
    }
    await sleep(250);
  }
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, {
    method: 'PUT',
  }).then((r) => r.json());
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new Cdp(ws);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = path.join(OUT_DIR, 'edge-profile-file');
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      '--allow-file-access-from-files',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=1280,860',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp;
  try {
    cdp = await connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
    const fileUrl = `file:///${indexPath.replace(/\\/g, '/')}`;
    console.log(`打开: ${fileUrl}`);
    console.log('（这就是 Electron 生产分支 loadFile 的实际效果）\n');

    await cdp.send('Page.navigate', { url: fileUrl });
    await sleep(3500);

    const state = await cdp.eval(`(() => {
      const content = document.querySelector('.shell__content');
      return {
        href: location.href,
        pathname: location.pathname,
        hash: location.hash,
        hasShell: !!document.querySelector('.shell'),
        topbarTitle: document.querySelector('.shell__page-title')?.textContent ?? null,
        contentText: (content?.innerText ?? '').slice(0, 300),
        rootEmpty: document.getElementById('root').children.length === 0,
        bodyLen: document.body.innerText.length,
      };
    })()`);

    console.log('---- 结果 ----');
    console.log(`location.href : ${state.href}`);
    console.log(`pathname      : ${state.pathname}`);
    console.log(`hash          : ${state.hash || '(空)'}`);
    console.log(`外壳渲染      : ${state.hasShell}`);
    console.log(`顶栏标题      : ${state.topbarTitle}`);
    console.log(`根节点为空    : ${state.rootEmpty}`);
    console.log(`正文长度      : ${state.bodyLen}`);
    console.log(`正文前 300 字 :\n${state.contentText}`);

    const is404 = state.contentText.includes('页面不存在');
    console.log(`\n>>> 判定：${is404 ? '复现成功 —— file:// 下确实显示「页面不存在」' : '未复现 404'}`);

    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(
      path.join(OUT_DIR, 'file-protocol-result.png'),
      Buffer.from(image.data, 'base64'),
    );
    console.log(`截图: .verify-shots/file-protocol-result.png`);

    return is404 ? 1 : 0;
  } finally {
    try {
      cdp?.ws.close();
    } catch {
      /* ignore */
    }
    edge.kill();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('探测出错:', err);
    process.exit(2);
  });

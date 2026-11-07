/**
 * 验证「Markdown 结构化入库 + 阅读器渲染层次」。
 *
 * 用户三点要求里的两条：
 *   • docx 转成 Markdown 再入库
 *   • MinerU 转换过后的 PDF 也要是 Markdown 形式
 *
 * 验的是**用户看得见的结果**：导入 docx 后，阅读器里标题是小标题、
 * 列表是列表、表格是表格 —— 而不是一堆带上井号和竖线的纯文字。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const PORT = 9286;

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method) for (const fn of this.listeners) fn(msg);
    });
  }
  on(fn) {
    this.listeners.push(fn);
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
      }, 90000);
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
  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
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
  const userDataDir = path.join(OUT_DIR, 'edge-profile-md');
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=1440,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp;
  try {
    cdp = await connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const errs = [];
    cdp.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        errs.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
      }
    });

    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(3500);
    record('应用启动', Boolean(await cdp.eval(`Boolean(document.querySelector('.app'))`)));

    // 建库
    await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '设置')?.click();
      await wait(900);
      const input = document.querySelector('.settings-panel input.set-input');
      if (input) {
        setter.call(input, 'Markdown验证库');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'))?.click();
        await wait(1400);
      }
      [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '资料')?.click();
      await wait(1200);
      return true;
    })()`);

    // 导入真实 docx
    await cdp.send('DOM.enable');
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const fi = await cdp.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'input[type=file]',
    });
    if (fi.nodeId) {
      await cdp.send('DOM.setFileInputFiles', {
        nodeId: fi.nodeId,
        files: [path.join(__dirname, '..', 'src', 'test', 'fixtures', 'course.docx')],
      });
    }
    await sleep(5000);

    // 库里存的文字是否 Markdown
    const stored = await cdp.eval(`(async () => {
      const req = indexedDB.open('openleaner');
      const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
      const all = await new Promise((res, rej) => {
        const tx = db.transaction('sourceSegments', 'readonly');
        const g = tx.objectStore('sourceSegments').getAll();
        g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error);
      });
      db.close();
      all.sort((a, b) => a.index - b.index);
      const joined = all.map(s => s.text).join('\\n');
      return {
        segCount: all.length,
        hasHeading: /^#{1,6}\\s+\\S/m.test(joined),
        head: joined.slice(0, 120),
      };
    })()`);
    record('docx 入库的文字是 Markdown 形式（含 #）', stored.hasHeading === true, JSON.stringify(stored.head));
    record('确实存进了分段', stored.segCount > 0, `${stored.segCount} 段`);

    // 点进阅读器看渲染
    const view = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelector('.source-row')?.click();
      await wait(1800);
      const h = document.querySelector('.reader-md-h');
      const para = document.querySelector('.reader-para');
      return {
        isReader: Boolean(document.querySelector('.reader-page')),
        hasHeadingEl: Boolean(h),
        headingText: h?.textContent ?? '',
        headingTag: h?.tagName ?? '',
        // 关键：不该看到字面的 ## 井号
        showsRawHashes: (document.querySelector('.reader-md')?.textContent ?? '').includes('##'),
        hasPara: Boolean(para),
        paraText: (para?.textContent ?? '').slice(0, 60),
      };
    })()`);
    record('docx 进阅读器', view.isReader === true, JSON.stringify(view));
    record('标题渲染成 <hN> 元素（不是一行带 ## 的普通文字）', view.hasHeadingEl === true, `${view.headingTag} ${view.headingText}`);
    record('页面上看不到字面的 ## 井号', view.showsRawHashes === false, `showsRawHashes=${view.showsRawHashes}`);
    record('正文段落仍然正常显示', view.hasPara === true, view.paraText);

    await cdp.screenshot(path.join(OUT_DIR, 'md-docx-view.png'));

    record('全程无未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));

    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed`);
    if (passed !== results.length) {
      console.log('\n失败项：');
      for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}  ${r.detail}`);
      process.exitCode = 1;
    }
  } finally {
    try {
      edge.kill();
    } catch {
      /* ignore */
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

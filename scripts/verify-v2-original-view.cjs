/**
 * 验证「看原图」—— 用户报的「PDF 文件依旧查看不了」。
 *
 * 验：点资料行进阅读器 → 有「看原图」按钮 → 点了真的画出 PDF 那一页。
 * 用 fixture 里的真 PDF，不是伪造的 dataURL。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const PORT = 9284;

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
  const userDataDir = path.join(OUT_DIR, 'edge-profile-orig');
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

    // 建库 + 用真实 PDF 导入（走 file input，让它真的存下原始字节）
    await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const nav = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '设置');
      nav?.click();
      await wait(900);
      const input = document.querySelector('.settings-panel input.set-input');
      if (input) {
        setter.call(input, '原图验证库');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'))?.click();
        await wait(1400);
      }
      const nav2 = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '资料');
      nav2?.click();
      await wait(1200);
      return true;
    })()`);

    await cdp.send('DOM.enable');
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const fi = await cdp.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'input[type=file]',
    });
    if (fi.nodeId) {
      await cdp.send('DOM.setFileInputFiles', {
        nodeId: fi.nodeId,
        files: [path.join(__dirname, '..', 'src', 'test', 'fixtures', 'scanned.pdf')],
      });
    }
    await sleep(5000);

    const imported = await cdp.eval(`(() => [...document.querySelectorAll('.source-row')].map(r => r.textContent.trim()))()`);
    record('真实 PDF 导入成功', (imported ?? []).length >= 1, JSON.stringify(imported));

    // 点资料行进阅读器
    const openReader = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelector('.source-row')?.click();
      await wait(1800);
      return {
        isReader: Boolean(document.querySelector('.reader-page')),
        hasToggle: Boolean([...document.querySelectorAll('.reader-bar button')].find(b => b.textContent.includes('看原图'))),
        buttons: [...document.querySelectorAll('.reader-bar button')].map(b => b.textContent.trim()),
      };
    })()`);
    record('点资料行进阅读器', openReader.isReader === true, JSON.stringify(openReader));
    record('PDF 有「看原图」切换', openReader.hasToggle === true, JSON.stringify(openReader.buttons));

    // 点「看原图」→ 检查真的画出图片
    const orig = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const btn = [...document.querySelectorAll('.reader-bar button')].find(b => b.textContent.includes('看原图'));
      if (!btn) return { error: '没找到按钮' };
      btn.click();
      // 渲染一页 PDF 要时间（pdfjs 初始化 + 绘制）
      await wait(4000);
      const img = document.querySelector('.reader-original__img');
      return {
        hasImg: Boolean(img),
        srcHead: img?.getAttribute('src')?.slice(0, 30) ?? null,
        naturalW: img?.naturalWidth ?? 0,
        naturalH: img?.naturalHeight ?? 0,
        err: document.querySelector('.reader-error--inline')?.textContent ?? null,
        stillLoading: Boolean([...document.querySelectorAll('.reader-hint')].find(e => e.textContent.includes('正在把这一页画出来'))),
      };
    })()`);
    record('点「看原图」真的画出了 PDF 页面', orig.hasImg === true, `尺寸 ${orig.naturalW}x${orig.naturalH}`);
    record('画的是真图片（dataURL）', (orig.srcHead ?? '').startsWith('data:image/png'), orig.srcHead ?? '');
    record('页面有实际像素', (orig.naturalW ?? 0) > 200, `${orig.naturalW}x${orig.naturalH}`);
    record('渲染没有报错', !orig.err, orig.err ?? '');

    await cdp.screenshot(path.join(OUT_DIR, 'reader-original.png'));

    // 切回文字
    const back = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const btn = [...document.querySelectorAll('.reader-bar button')].find(b => b.textContent.includes('看文字'));
      btn?.click();
      await wait(1200);
      return {
        hasImg: Boolean(document.querySelector('.reader-original__img')),
        hasText: Boolean(document.querySelector('.reader-para')),
      };
    })()`);
    record('能切回文字视图', back.hasImg === false && back.hasText === true, JSON.stringify(back));

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

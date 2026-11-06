/**
 * 验证「扫描件转换入口」在真实界面里长什么样、点了会怎样。
 *
 * ## 验什么
 *
 *  1. 种一份扫描件（textStatus='no-text-layer'）进库
 *  2. 进整理页 → 必须看到转换面板，且说清「这是扫描件，不是文件坏了」
 *  3. **不可用时必须明说原因**，而不是摆一个点了才报错的按钮
 *     （浏览器环境跑不了 MinerU，正好验这条）
 *  4. 有文字层的普通资料**不该**出现这个面板（不打扰）
 *  5. 转好的资料不该出现这个面板
 *  6. 截图肉眼复核
 *
 * 真跑 MinerU 的那部分由 verify-mineru.cjs / verify-mineru-writeback.cjs 覆盖
 * （它们直接调主进程模块，不需要开浏览器）。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const PORT = 9275;

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
      }, 60000);
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
  const userDataDir = path.join(OUT_DIR, 'edge-profile-convert');
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

    const pageErrors = [];
    cdp.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        pageErrors.push(
          msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text,
        );
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        pageErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
    });

    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(3500);
    record('应用启动', Boolean(await cdp.eval(`Boolean(document.querySelector('.app'))`)));

    // 建库
    await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const nav = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '设置');
      if (!nav) return false;
      nav.click();
      await wait(900);
      const input = document.querySelector('.settings-panel input.set-input');
      if (input) {
        setter.call(input, '转换验证库');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'));
        if (btn) btn.click();
        await wait(1400);
      }
      return true;
    })()`);

    // 种三份资料：扫描件 / 正常 / 已转好
    const seeded = await cdp.eval(`(async () => {
      const req = indexedDB.open('openleaner');
      const db = await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const now = new Date().toISOString();
      const put = (store, rows) => new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        for (const r of rows) tx.objectStore(store).put(r);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
      const mk = (id, title, status, segs) => ({
        id, title, fileName: title + '.pdf', kind: 'pdf', courseId: null,
        pageCount: 3, byteSize: 1000, textStatus: status, segmentCount: segs,
        fileStored: true, createdAt: now, updatedAt: now,
      });
      await put('sources', [
        mk('src_scan', '扫描件·信号与系统', 'no-text-layer', 0),
        mk('src_ok', '正常·数据结构讲义', 'ready', 3),
        mk('src_done', '已转好·操作系统', 'ready', 3),
      ]);
      db.close();
      return true;
    })()`);
    record('种入三份资料（扫描件 / 正常 / 已转好）', seeded === true);

    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(3200);

    // ---------- 扫描件：必须看到转换面板 ----------
    const scanView = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const nav = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '资料');
      nav.click();
      await wait(1100);
      // 点扫描件那行的「整理」
      const li = [...document.querySelectorAll('.source-item')]
        .find(el => (el.querySelector('.source-row')?.textContent ?? '').includes('扫描件'));
      if (!li) return { error: '找不到扫描件行' };
      li.querySelector('.source-item__organize').click();
      await wait(1600);
      const panel = document.querySelector('.convert-panel');
      return {
        hasPanel: Boolean(panel),
        title: panel?.querySelector('.convert-panel__title')?.textContent ?? '',
        hints: [...(panel?.querySelectorAll('.convert-panel__hint') ?? [])].map(e => e.textContent.trim()),
        unavailTitle: panel?.querySelector('.convert-panel__unavail-title')?.textContent ?? '',
        unavailReason: panel?.querySelector('.convert-panel__unavailable .convert-panel__hint')?.textContent ?? '',
        buttons: [...(panel?.querySelectorAll('button') ?? [])].map(b => b.textContent.trim()),
      };
    })()`);
    record('扫描件在整理页显示转换面板', scanView.hasPanel === true, JSON.stringify(scanView.error ?? ''));
    record(
      '面板说清「这是扫描件」',
      (scanView.title ?? '').includes('扫描件') || (scanView.title ?? '').includes('没有文字层'),
      scanView.title ?? '',
    );
    record(
      '面板明说「不是文件坏了」',
      (scanView.hints ?? []).some((h) => h.includes('不是文件坏了')),
      (scanView.hints ?? []).join(' | ').slice(0, 100),
    );
    record(
      '浏览器环境如实说用不了 MinerU（不摆假按钮）',
      (scanView.unavailTitle ?? '').length > 0,
      `${scanView.unavailTitle} / ${(scanView.unavailReason ?? '').slice(0, 60)}`,
    );
    record(
      '不可用时没有「点了才报错」的转换按钮',
      !(scanView.buttons ?? []).some((b) => b.includes('转成正文')),
      JSON.stringify(scanView.buttons),
    );

    await cdp.screenshot(path.join(OUT_DIR, 'convert-01-scanned.png'));

    // ---------- 正常资料：不该出现面板 ----------
    const okView = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const nav = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '资料');
      nav.click();
      await wait(1000);
      const li = [...document.querySelectorAll('.source-item')]
        .find(el => (el.querySelector('.source-row')?.textContent ?? '').includes('正常·数据结构'));
      if (!li) return { error: '找不到正常资料行' };
      li.querySelector('.source-item__organize').click();
      await wait(1500);
      return {
        hasPanel: Boolean(document.querySelector('.convert-panel')),
        orgPage: Boolean(document.querySelector('.org-page')),
      };
    })()`);
    record('有文字层的资料不显示转换面板（不打扰）', okView.hasPanel === false, JSON.stringify(okView));

    // ---------- 已转好的资料：也不该出现 ----------
    const doneView = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const nav = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '资料');
      nav.click();
      await wait(1000);
      const li = [...document.querySelectorAll('.source-item')]
        .find(el => (el.querySelector('.source-row')?.textContent ?? '').includes('已转好'));
      if (!li) return { error: '找不到已转好资料行' };
      li.querySelector('.source-item__organize').click();
      await wait(1500);
      return { hasPanel: Boolean(document.querySelector('.convert-panel')) };
    })()`);
    record('已转好的资料不显示转换面板', doneView.hasPanel === false, JSON.stringify(doneView));

    // ---------- 窄屏 ----------
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 560,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(600);
    const narrow = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const nav = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '资料');
      nav.click();
      await wait(900);
      const li = [...document.querySelectorAll('.source-item')]
        .find(el => (el.querySelector('.source-row')?.textContent ?? '').includes('扫描件'));
      li?.querySelector('.source-item__organize')?.click();
      await wait(1400);
      const doc = document.documentElement;
      return {
        hScroll: doc.scrollWidth > doc.clientWidth + 1,
        hasPanel: Boolean(document.querySelector('.convert-panel')),
      };
    })()`);
    record('窄屏 560px 下无横向溢出', narrow.hScroll === false, JSON.stringify(narrow));

    await cdp.screenshot(path.join(OUT_DIR, 'convert-02-narrow.png'));

    record('全程无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

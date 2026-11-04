/**
 * P1 在桌面端（file://）的验收。
 *
 * 为什么必须单独跑：PDF 解析依赖 Web Worker，而 file:// 协议对 Worker 的
 * 加载有额外限制（跨源、blob URL 等）。http:// 下能跑不代表桌面端能跑 ——
 * 这正是 P0 踩过的教训（history 路由在 file:// 下 404，浏览器验收发现不了）。
 *
 * 这里验的是「打包产物里的 PDF 导入链路在 file:// 下是否可用」。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const EXTRACT_DIR = path.join(OUT_DIR, 'asar-p1');
const PORT = 9228;
const LOG = path.join(OUT_DIR, 'log-p1-desktop.txt');

const results = [];
function say(line) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(LOG, `${line}\n`);
  console.log(line);
}
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
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

function fixtureBase64(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'test', 'fixtures', name)).toString('base64');
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LOG, '');
  say(`P1 桌面端（file://）验收开始 ${new Date().toISOString()}`);

  const asarPath = path.join(__dirname, '..', 'release', 'win-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) {
    say(`找不到 ${asarPath}，请先 electron-builder --dir`);
    return 1;
  }

  // 解包，用 file:// 加载真实产物
  fs.rmSync(EXTRACT_DIR, { recursive: true, force: true });
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  asar.extractAll(asarPath, EXTRACT_DIR);

  const indexPath = path.join(EXTRACT_DIR, 'dist', 'index.html');
  const fileUrl = `file:///${indexPath.replace(/\\/g, '/')}`;
  say(`加载: ${fileUrl}\n`);

  // worker 是否打进产物
  const assetsDir = path.join(EXTRACT_DIR, 'dist', 'assets');
  const assetFiles = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  const workerFile = assetFiles.find((f) => /pdf\.worker.*\.mjs$/.test(f));
  record(
    '打包产物里含 pdf worker 文件',
    Boolean(workerFile),
    workerFile ?? `assets: ${assetFiles.join(', ')}`,
  );

  const userDataDir = path.join(OUT_DIR, 'edge-profile-p1-desktop');
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
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp;
  try {
    cdp = await connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const consoleErrors = [];
    cdp.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(
          msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text,
        );
      }
    });

    await cdp.send('Page.navigate', { url: fileUrl });
    await sleep(3500);

    // 建库
    await cdp.eval(`(async () => {
      location.hash = '#/settings';
      await new Promise(r => setTimeout(r, 1500));
      const input = document.querySelector('.card input.input');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '桌面端 P1 库');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'));
        if (btn) { btn.click(); await new Promise(r => setTimeout(r, 1500)); }
      }
    })()`);

    // 导入 PDF（这一步会真实启动 worker）
    await cdp.eval(`location.hash = '#/sources'`);
    await sleep(1800);

    const pdfB64 = fixtureBase64('course.pdf');
    const imported = await cdp.eval(`(async () => {
      const b64 = ${JSON.stringify(pdfB64)};
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], '桌面PDF.pdf', { type: 'application/pdf' });

      const input = document.querySelector('input[type=file]');
      if (!input) return { ok: false, why: '找不到文件输入框' };
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));

      await new Promise(r => setTimeout(r, 6000));
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return { ok: true, text: text.slice(0, 500) };
    })()`);

    const dbState = await cdp.eval(`(async () => {
      const open = () => new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await open();
      const readAll = (name) => new Promise((res, rej) => {
        if (!db.objectStoreNames.contains(name)) return res([]);
        const tx = db.transaction(name, 'readonly');
        const req = tx.objectStore(name).getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const sources = await readAll('sources');
      const segments = await readAll('sourceSegments');
      db.close();
      return {
        sourceCount: sources.length,
        segCount: segments.length,
        pages: segments.map(s => s.page).sort((a,b)=>a-b),
        meta: sources[0] ? {
          title: sources[0].title,
          pageCount: sources[0].pageCount,
          textStatus: sources[0].textStatus,
        } : null,
      };
    })()`);

    record(
      'file:// 下 PDF 能解析入库（worker 可用）',
      dbState.sourceCount === 1 && dbState.segCount === 3,
      `资料 ${dbState.sourceCount} 份，段 ${dbState.segCount} 条，页码 ${JSON.stringify(dbState.pages)}`,
    );
    record(
      'file:// 下切分页数正确（3 页 / ready）',
      dbState.meta?.pageCount === 3 && dbState.meta?.textStatus === 'ready',
      JSON.stringify(dbState.meta ?? {}),
    );

    // 阅读器 + 搜索
    const readerCheck = await cdp.eval(`(async () => {
      const target = document.querySelector('.source-item__main');
      if (!target) return { ok: false, why: '找不到资料条目' };
      target.click();
      await new Promise(r => setTimeout(r, 2000));

      const content = document.querySelector('.shell__content')?.innerText ?? '';
      const input = [...document.querySelectorAll('input')]
        .find(i => /搜索|查找/.test(i.placeholder ?? ''));

      let searchOk = false;
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '假溢出');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const form = input.closest('form');
        if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, 2500));
        const after = document.querySelector('.shell__content')?.innerText ?? '';
        searchOk = /找到\\s*\\d+\\s*处/.test(after) || document.querySelectorAll('.reader__mark').length > 0;
      }

      return {
        ok: true,
        hasReader: !!document.querySelector('.reader'),
        showsPage1: content.includes('数据结构研究的是数据元素之间的关系'),
        tocCount: document.querySelectorAll('.reader__toc-item').length,
        searchOk,
      };
    })()`);

    record(
      'file:// 下阅读器显示正确原文，目录 3 项',
      readerCheck.ok && readerCheck.hasReader && readerCheck.showsPage1 && readerCheck.tocCount === 3,
      readerCheck.ok ? `目录 ${readerCheck.tocCount} 项` : readerCheck.why,
    );
    record(
      'file:// 下全文搜索可用',
      readerCheck.ok && readerCheck.searchOk,
      readerCheck.ok ? `searchOk=${readerCheck.searchOk}` : readerCheck.why,
    );

    await cdp.screenshot(path.join(OUT_DIR, 'p1-desktop.png'));

    record(
      'file:// 下无 console 错误',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | '),
    );

    const failed = results.filter((r) => !r.ok);
    say('\n================ 汇总 ================');
    say(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    if (failed.length > 0) {
      for (const f of failed) say(`  - ${f.name}${f.detail ? `  ${f.detail}` : ''}`);
    }
    fs.writeFileSync(
      path.join(OUT_DIR, 'report-p1-desktop.json'),
      JSON.stringify({ results, consoleErrors }, null, 2),
    );
    return failed.length;
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
  .then((n) => process.exit(n === 0 ? 0 : 1))
  .catch((err) => {
    say(`探针自身出错：${err && err.stack ? err.stack : err}`);
    process.exit(2);
  });

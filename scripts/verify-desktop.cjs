/**
 * 桌面端（file:// 协议）验收探针。
 *
 * 存在的理由是踩过一次的坑：P0 主体验收跑在 http:// 上全过，
 * 但 Electron 生产包用 loadFile 加载的是 file://，history 路由在那里匹配不到，
 * 首屏直接显示「页面不存在」。这个缺陷在浏览器里永远发现不了。
 *
 * 所以单独一个探针，专门验证打包产物在 file:// 下的行为：
 *   1. 首屏不是 404，而是真正落到默认页
 *   2. 导航可点通（hash 路由在 file:// 下要能工作）
 *   3. 刷新后仍在同一页（hash 不会被 file:// 吃掉）
 *   4. IndexedDB 在 file:// 下可用（Chromium 对 file:// 有额外限制）
 *   5. 建库后刷新仍在
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const PORT = 9224;
const LOG = path.join(OUT_DIR, 'log-desktop.txt');

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
  fs.writeFileSync(LOG, '');
  say(`桌面端（file://）验收开始 ${new Date().toISOString()}`);

  const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
  if (!fs.existsSync(indexPath)) {
    say('dist/index.html 不存在，请先 npm run build');
    return 1;
  }
  const fileUrl = `file:///${indexPath.replace(/\\/g, '/')}`;
  say(`加载: ${fileUrl}\n`);

  const userDataDir = path.join(OUT_DIR, 'edge-profile-desktop');
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      // file:// 下要允许本地文件访问与存储，Electron 默认已放宽同等限制
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

    // ---------- 1. 首屏不是 404 ----------
    await cdp.send('Page.navigate', { url: fileUrl });
    await sleep(3500);

    const first = await cdp.eval(`(() => {
      const content = document.querySelector('.shell__content');
      return {
        href: location.href,
        hash: location.hash,
        hasShell: !!document.querySelector('.shell'),
        title: document.querySelector('.shell__page-title')?.textContent ?? null,
        heading: document.querySelector('.page__title')?.textContent ?? null,
        contentText: (content?.innerText ?? '').slice(0, 200),
        navCount: document.querySelectorAll('.shell__link').length,
      };
    })()`);

    record(
      'file:// 下首屏落到默认页，不是「页面不存在」',
      first.hasShell && !first.contentText.includes('页面不存在') && first.title === '资料库',
      `hash=${first.hash} 顶栏=${first.title} 正文=${first.heading}`,
    );
    record(
      'file:// 下导航条目正常生成',
      first.navCount === 7,
      `实际 ${first.navCount} 条`,
    );
    await cdp.screenshot(path.join(OUT_DIR, 'desktop-01-first.png'));

    // ---------- 2. 导航可点通 ----------
    const expected = [
      ['knowledge', '知识点'],
      ['decks', '习题集'],
      ['settings', '设置'],
    ];
    for (const [id, title] of expected) {
      const clicked = await cdp.eval(`(() => {
        const link = [...document.querySelectorAll('.shell__link')]
          .find(a => (a.getAttribute('href') ?? '').includes('${id}'));
        if (!link) return false;
        link.click();
        return true;
      })()`);
      await sleep(500);
      const state = await cdp.eval(`(() => ({
        title: document.querySelector('.shell__page-title')?.textContent ?? null,
        hash: location.hash,
        alive: !!document.querySelector('.shell'),
        len: (document.querySelector('.shell__content')?.innerText ?? '').length,
      }))()`);
      record(
        `file:// 下页面「${title}」可点通`,
        clicked && state.title === title && state.alive && state.len > 30,
        `hash=${state.hash} 顶栏=${state.title}`,
      );
    }

    // ---------- 3. 刷新后仍在同一页 ----------
    const hashBefore = await cdp.eval('location.hash');
    await cdp.send('Page.reload');
    await sleep(3000);
    const afterReload = await cdp.eval(`(() => ({
      hash: location.hash,
      title: document.querySelector('.shell__page-title')?.textContent ?? null,
      alive: !!document.querySelector('.shell'),
    }))()`);
    record(
      'file:// 下刷新后仍在同一页（hash 未被丢失）',
      afterReload.alive && afterReload.hash === hashBefore && afterReload.title === '设置',
      `刷新前 hash=${hashBefore} 刷新后=${afterReload.hash} 标题=${afterReload.title}`,
    );

    // ---------- 4. file:// 下 IndexedDB 可用 ----------
    const dbUsable = await cdp.eval(`(async () => {
      try {
        const open = () => new Promise((res, rej) => {
          const r = indexedDB.open('openleaner');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
          r.onblocked = () => rej(new Error('blocked'));
        });
        const db = await open();
        const stores = [...db.objectStoreNames];
        db.close();
        return { ok: true, storeCount: stores.length };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    })()`);
    record(
      'file:// 下 IndexedDB 可正常打开且分区齐全',
      dbUsable.ok && dbUsable.storeCount === 10,
      dbUsable.ok ? `分区 ${dbUsable.storeCount} 个` : dbUsable.error,
    );

    // ---------- 5. file:// 下能建库且刷新还在 ----------
    const created = await cdp.eval(`(async () => {
      const link = [...document.querySelectorAll('.shell__link')]
        .find(a => (a.getAttribute('href') ?? '').includes('settings'));
      link.click();
      await new Promise(r => setTimeout(r, 900));

      const input = document.querySelector('.card input.input');
      if (!input) return { ok: false, why: '找不到输入框' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '桌面端离线库');
      input.dispatchEvent(new Event('input', { bubbles: true }));

      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'));
      if (!btn) return { ok: false, why: '找不到建库按钮' };
      btn.click();
      await new Promise(r => setTimeout(r, 1800));

      return {
        ok: true,
        name: document.querySelector('.card input.input')?.value ?? null,
        hasExport: [...document.querySelectorAll('button')].some(b => b.textContent.includes('导出学习库')),
      };
    })()`);

    await cdp.send('Page.reload');
    await sleep(3000);
    const persisted = await cdp.eval(`(async () => {
      const link = [...document.querySelectorAll('.shell__link')]
        .find(a => (a.getAttribute('href') ?? '').includes('settings'));
      link.click();
      await new Promise(r => setTimeout(r, 1200));
      return {
        name: document.querySelector('.card input.input')?.value ?? null,
        hasExport: [...document.querySelectorAll('button')].some(b => b.textContent.includes('导出学习库')),
      };
    })()`);

    record(
      'file:// 下建库成功，刷新后学习库仍在',
      created.ok && created.hasExport && persisted.name === '桌面端离线库' && persisted.hasExport,
      `库名=${persisted.name}`,
    );
    await cdp.screenshot(path.join(OUT_DIR, 'desktop-02-settings.png'));

    // ---------- 6. 无控制台错误 ----------
    record(
      'file:// 下无 console 错误 / 未捕获异常',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | '),
    );

    const failed = results.filter((r) => !r.ok);
    say('\n================ 汇总 ================');
    say(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    if (failed.length > 0) {
      say('失败项：');
      for (const f of failed) say(`  - ${f.name}${f.detail ? `  ${f.detail}` : ''}`);
    }
    fs.writeFileSync(
      path.join(OUT_DIR, 'report-desktop.json'),
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

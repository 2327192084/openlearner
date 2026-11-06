/**
 * 验「桌面上那个包」里到底有没有新东西。
 *
 * 为什么单独写这个：
 *   用户明确说过「它不是新包，我没看见 api 设置的有关设置」。
 *   工作区里 dist 是新的、commit 也提交了，都可能和桌面上那个 app.asar 无关 ——
 *   只有把**桌面那个文件**解出来、原样加载，才算证明了。
 *
 * 怎么验：
 *   解 app.asar → 用 file:// 加载 dist/index.html（和 Electron 一样的方式）→
 *   CDP 点真实按钮，看得到「设置 / 模型与出题 / 整理知识点」。
 *   不看源码字符串，看界面上真的能点开。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const EXTRACT_DIR = path.join(OUT_DIR, 'desktop-dist');
const PORT = 9261;

/** 桌面上那个包（用户实际双击的） */
const DESKTOP_ASAR = 'C:\\Users\\ASUS\\Desktop\\OpenLeaner-测试版-2026-11-06\\resources\\app.asar';

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

  if (!fs.existsSync(DESKTOP_ASAR)) {
    console.log(`找不到桌面上的包：${DESKTOP_ASAR}`);
    return 1;
  }

  const stat = fs.statSync(DESKTOP_ASAR);
  console.log(`桌面包：${DESKTOP_ASAR}\n  ${stat.size} 字节  ${stat.mtime.toISOString()}`);

  // ---------- 1. 包结构 ----------
  const entries = asar.listPackage(DESKTOP_ASAR).map((e) => e.replace(/\\/g, '/'));
  record(
    '桌面包含主进程 / preload / 界面入口',
    entries.includes('/electron/main.cjs') &&
      entries.includes('/electron/preload.cjs') &&
      entries.includes('/dist/index.html'),
  );

  // ---------- 2. 解出 dist，用 file:// 原样加载 ----------
  fs.rmSync(EXTRACT_DIR, { recursive: true, force: true });
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  asar.extractAll(DESKTOP_ASAR, EXTRACT_DIR);
  const packagedIndex = path.join(EXTRACT_DIR, 'dist', 'index.html');
  if (!fs.existsSync(packagedIndex)) {
    console.log('解包后没有 dist/index.html');
    return 1;
  }
  const fileUrl = `file:///${packagedIndex.replace(/\\/g, '/')}`;

  const userDataDir = path.join(OUT_DIR, 'edge-profile-desktop');
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

    await cdp.send('Page.navigate', { url: fileUrl });
    await sleep(3500);

    const boot = await cdp.eval(`(() => ({
      hasApp: Boolean(document.querySelector('.app')),
      sidebar: [...document.querySelectorAll('.sidebar .nav-item__label')].map(n => n.textContent.trim()),
      boot: Boolean(window.__DSH_BOOT__),
      bodyText: (document.body.innerText || '').slice(0, 120),
    }))()`);

    record('桌面包里的界面能在 file:// 下启动', boot.hasApp === true, boot.bodyText ?? '');
    record(
      '侧栏有「资料 / 创建题组 / 学习库」',
      (boot.sidebar ?? []).includes('资料') && (boot.sidebar ?? []).includes('创建题组'),
      JSON.stringify(boot.sidebar ?? []),
    );

    // ---------- 3. 设置页：模型与出题（这就是用户说没看见的那块） ----------
    const settings = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const nav = [...document.querySelectorAll('.sidebar .nav-item')]
        .find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '设置');
      if (!nav) return { error: '侧栏没有「设置」' };
      nav.click();
      await wait(1200);
      const cats = [...document.querySelectorAll('.settings-nav__item')].map(b => b.textContent.trim());
      const modelTab = [...document.querySelectorAll('.settings-nav__item')]
        .find(b => b.textContent.includes('模型与出题'));
      if (!modelTab) return { error: '没有「模型与出题」分类', cats };
      modelTab.click();
      await wait(800);
      const addBtn = [...document.querySelectorAll('.settings-panel button')]
        .find(b => b.textContent.includes('添加模型'));
      return {
        cats,
        topbar: document.querySelector('.topbar__title')?.textContent ?? '',
        hasAddModel: Boolean(addBtn),
        panelText: (document.querySelector('.settings-panel')?.innerText ?? '').slice(0, 160),
      };
    })()`);

    record('桌面包里有「设置」页', !settings.error && settings.topbar === '设置', settings.error ?? settings.topbar ?? '');
    record(
      '设置页有「模型与出题」分类',
      (settings.cats ?? []).some((c) => c.includes('模型与出题')),
      JSON.stringify(settings.cats ?? []),
    );
    record('模型页有「添加模型」按钮', settings.hasAddModel === true, (settings.panelText ?? '').slice(0, 60));

    await cdp.screenshot(path.join(OUT_DIR, 'pkg-01-settings-model.png'));

    // ---------- 4. 整理知识点页在不在（本轮新补的） ----------
    // 这个页面不是侧栏项（它属于某一份资料），所以先往库里放一份资料，
    // 再点资料行 —— 走的是用户真实路径，不是查字符串。
    const seeded = await cdp.eval(`(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('openleaner');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const put = (store, rows) => new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        for (const r of rows) tx.objectStore(store).put(r);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
      const now = new Date().toISOString();
      const text = '顺序存储结构把线性表的元素存放在一片连续的存储单元里，因此可以随机访问。';
      await put('sources', [{
        id: 'src_pkg', title: '桌面包验证资料', fileName: null, kind: 'text',
        courseId: null, pageCount: 1, byteSize: text.length, textStatus: 'ready',
        segmentCount: 1, fileStored: false, createdAt: now, updatedAt: now,
      }]);
      await put('sourceSegments', [{
        id: 'seg_pkg', sourceId: 'src_pkg', index: 1, page: 1,
        chapter: null, text, charCount: text.length,
      }]);
      db.close();
      return true;
    })()`);
    record('往桌面包里种一份资料', seeded === true);

    await cdp.send('Page.reload');
    await sleep(3200);

    const organize = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const nav = [...document.querySelectorAll('.sidebar .nav-item')]
        .find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '资料');
      if (!nav) return { error: '侧栏没有「资料」' };
      nav.click();
      await wait(1200);
      const row = document.querySelector('.source-row');
      if (!row) return { error: '资料列表是空的', text: (document.querySelector('.sources-page')?.innerText ?? '').slice(0, 120) };

      // 阅读器做出来之后，点资料行 = 打开原文。整理走独立的「整理」按钮。
      row.click();
      await wait(1600);
      const reader = {
        title: document.querySelector('.reader-title')?.textContent ?? '',
        hasBody: Boolean(document.querySelector('.reader-body')),
      };

      // 回资料页，走「整理」按钮
      nav.click();
      await wait(1000);
      const orgBtn = document.querySelector('.source-item__organize');
      if (!orgBtn) return { error: '资料行没有「整理」按钮', reader };
      orgBtn.click();
      await wait(1600);

      return {
        reader,
        title: document.querySelector('.org-title')?.textContent ?? '',
        topbar: document.querySelector('.topbar__title')?.textContent ?? '',
        backendOptions: [...(document.querySelectorAll('.org-select')[1]?.options ?? [])].map(o => o.textContent),
      };
    })()`);

    record(
      '点资料行能打开「阅读原文」（阅读器真的在包里）',
      (organize.reader?.hasBody ?? false) === true && (organize.reader?.title ?? '').includes('桌面包验证资料'),
      organize.error ?? JSON.stringify(organize.reader),
    );
    record(
      '点「整理」能进「整理知识点」（新页面真的在包里）',
      organize.title === '整理知识点',
      organize.error ?? organize.title ?? '',
    );
    record(
      '整理页默认后端是示例后端',
      (organize.backendOptions ?? [])[0]?.includes('示例后端') === true,
      (organize.backendOptions ?? [])[0] ?? '',
    );

    await cdp.screenshot(path.join(OUT_DIR, 'pkg-02-organize.png'));

    // ---------- 5. 页面没有未捕获异常 ----------
    record('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    try {
      edge.kill();
    } catch {
      /* ignore */
    }
    if (cdp) {
      try {
        cdp.ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

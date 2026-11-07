/**
 * 验证三处改动：
 *   1. 创建题组 + 我的题组 整合成一页（侧栏只有「我的题组」）
 *   2. 「草稿」改叫「待审核」
 *   3. 顶部按钮「回到题目」改叫「开始学习」
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const PORT = 9290;

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
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
  const userDataDir = path.join(OUT_DIR, 'edge-profile-merge');
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
        setter.call(input, '整合验证库');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'))?.click();
        await wait(1400);
      }
      return true;
    })()`);

    // 1) 侧栏：只有「我的题组」，没有「创建题组」
    const nav = await cdp.eval(`(() =>
      [...document.querySelectorAll('.sidebar .nav-item')]
        .map(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim())
    )()`);
    record('侧栏有「我的题组」', (nav ?? []).includes('我的题组'), JSON.stringify(nav));
    record('侧栏没有「创建题组」（已整合）', !(nav ?? []).includes('创建题组'), '');
    record('顶部按钮叫「开始学习」', (nav ?? []).includes('开始学习'), '');
    record('不再有「回到题目」', !(nav ?? []).includes('回到题目'), '');

    // 2) 种一个草稿题组，看是否显示「待审核」
    await cdp.eval(`(async () => {
      const req = indexedDB.open('openleaner');
      const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
      const put = (store, rows) => new Promise((res, rej) => {
        const tx = db.transaction(store, 'readwrite');
        for (const r of rows) tx.objectStore(store).put(r);
        tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
      });
      const now = new Date().toISOString();
      await put('decks', [{
        id: 'deck_m', title: '信号与系统 · 第1章 · 题组', courseId: null,
        status: 'draft', sourceId: null, backendId: null,
        questionCount: 2, blockingIssues: 0, createdAt: now, updatedAt: now,
      }]);
      await put('questions', [1,2].map(i => ({
        id: 'mq' + i, deckId: 'deck_m', kind: 'single',
        prompt: '第 ' + i + ' 题：测试题干', options: [{key:'A',text:'甲'}],
        answer: 'A', explanation: '', anchors: [], sequence: i, createdAt: now,
      })));
      db.close();
      return true;
    })()`);

    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(3200);

    const page = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('.sidebar .nav-item')]
        .find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '我的题组')?.click();
      await wait(1400);
      const body = document.body.innerText;
      return {
        isDecks: Boolean(document.querySelector('.decks-page')),
        badges: [...document.querySelectorAll('.deck-badge')].map(e => e.textContent.trim()),
        tabs: [...document.querySelectorAll('.decks-tab')].map(e => e.textContent.trim()),
        hasCreateBtn: [...document.querySelectorAll('button')].some(b => b.textContent.includes('新建题组')),
        showsDraftWord: body.includes('草稿'),
        showsPendingWord: body.includes('待审核'),
      };
    })()`);
    record('能进「我的题组」页', page.isDecks === true, '');
    record('页面上有「新建题组」按钮（整合后的出题入口）', page.hasCreateBtn === true, '');
    record('题组标记为「待审核」而不是「草稿」', (page.badges ?? []).includes('待审核'), JSON.stringify(page.badges));
    record('分类标签用「待审核」', (page.tabs ?? []).some((t) => t.includes('待审核')), JSON.stringify(page.tabs));
    record('页面上不出现「草稿」二字', page.showsDraftWord === false, `showsDraft=${page.showsDraftWord}`);

    await cdp.screenshot(path.join(OUT_DIR, 'merge-01-list.png'));

    // 3) 点「新建题组」就地展开表单
    const create = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('button')].find(b => b.textContent.includes('新建题组'))?.click();
      await wait(1200);
      return {
        hasGenPage: Boolean(document.querySelector('.gen-page') || document.querySelector('.gen-empty')),
        title: document.querySelector('.gen-title')?.textContent ?? '',
        hasBack: [...document.querySelectorAll('button')].some(b => b.textContent.includes('返回题组列表')),
        stillDecks: Boolean(document.querySelector('.decks-title')),
      };
    })()`);
    record('点「新建题组」就地展开出题表单', create.hasGenPage === true, create.title);
    record('出题页有「返回题组列表」', create.hasBack === true, '');
    record('展开后不再是列表视图（同一页切换）', create.stillDecks === false, '');

    await cdp.screenshot(path.join(OUT_DIR, 'merge-02-create.png'));

    // 4) 返回
    const back = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('button')].find(b => b.textContent.includes('返回题组列表'))?.click();
      await wait(1000);
      return { backToList: Boolean(document.querySelector('.decks-title')) };
    })()`);
    record('能返回题组列表', back.backToList === true, '');

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

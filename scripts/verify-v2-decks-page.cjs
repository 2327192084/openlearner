/**
 * 验证「我的题组」页 —— 用户出完题找不到题的修复。
 *
 * 验的是用户真实路径：
 *   种一个草稿题组 → 侧栏能看到「我的题组」→ 点进去看到题
 *   → 草稿题不进复习 → 发布后进复习
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const PORT = 9288;

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
  const userDataDir = path.join(OUT_DIR, 'edge-profile-decks');
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
        setter.call(input, '题组验证库');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'))?.click();
        await wait(1400);
      }
      return true;
    })()`);

    // 侧栏必须有「我的题组」
    const nav = await cdp.eval(`(() =>
      [...document.querySelectorAll('.sidebar .nav-item')]
        .map(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim())
    )()`);
    record('侧栏有「我的题组」入口', (nav ?? []).includes('我的题组'), JSON.stringify(nav));

    // 种一个草稿题组 + 3 道题
    const seeded = await cdp.eval(`(async () => {
      const req = indexedDB.open('openleaner');
      const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
      const put = (store, rows) => new Promise((res, rej) => {
        const tx = db.transaction(store, 'readwrite');
        for (const r of rows) tx.objectStore(store).put(r);
        tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
      });
      const now = new Date().toISOString();
      await put('decks', [{
        id: 'deck_test', title: '信号与系统 · 第1章 · 题组', courseId: null,
        status: 'draft', sourceId: null, backendId: null,
        questionCount: 3, blockingIssues: 0, createdAt: now, updatedAt: now,
      }]);
      await put('questions', [1,2,3].map(i => ({
        id: 'q' + i, deckId: 'deck_test', kind: 'single',
        prompt: '第 ' + i + ' 题：信号与系统的基本概念是什么？',
        options: [{ key: 'A', text: '选项甲' }, { key: 'B', text: '选项乙' }],
        answer: 'A', explanation: '', anchors: [{ sourceId: 's1', page: 5, charStart: 0, charEnd: 4 }],
        sequence: i, createdAt: now,
      })));
      db.close();
      return true;
    })()`);
    record('种入草稿题组（3 道题）', seeded === true);

    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(3200);

    // 进「我的题组」
    const page = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('.sidebar .nav-item')]
        .find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '我的题组')?.click();
      await wait(1400);
      return {
        isDecksPage: Boolean(document.querySelector('.decks-page')),
        title: document.querySelector('.decks-title')?.textContent ?? '',
        deckTitles: [...document.querySelectorAll('.deck-item__title')].map(e => e.textContent),
        badges: [...document.querySelectorAll('.deck-badge')].map(e => e.textContent),
        tabs: [...document.querySelectorAll('.decks-tab')].map(e => e.textContent),
      };
    })()`);
    record('能进「我的题组」页', page.isDecksPage === true, page.title);
    record('列出了那个题组', (page.deckTitles ?? []).some((t) => t.includes('信号与系统')), JSON.stringify(page.deckTitles));
    record('标出它是「草稿」', (page.badges ?? []).includes('草稿'), JSON.stringify(page.badges));
    record('有分类标签', (page.tabs ?? []).length >= 3, JSON.stringify(page.tabs));

    await cdp.screenshot(path.join(OUT_DIR, 'decks-01-list.png'));

    // 展开看题
    const expanded = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelector('.deck-item__main')?.click();
      await wait(1200);
      return {
        qCount: document.querySelectorAll('.deck-q').length,
        firstPrompt: document.querySelector('.deck-q__prompt')?.textContent ?? '',
        hasAnswer: Boolean(document.querySelector('.deck-q__opt--right')),
        anchor: document.querySelector('.deck-q__anchor')?.textContent ?? '',
      };
    })()`);
    record('展开能看到题目列表', expanded.qCount === 3, `${expanded.qCount} 道`);
    record('题目内容正确显示', (expanded.firstPrompt ?? '').includes('信号与系统'), expanded.firstPrompt);
    record('正确答案标出来了', expanded.hasAnswer === true, '');
    record('每道题标了出处页码', (expanded.anchor ?? '').includes('第 5 页'), expanded.anchor);

    await cdp.screenshot(path.join(OUT_DIR, 'decks-02-questions.png'));

    // 草稿不该进复习
    const notInReview = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('.sidebar .nav-item')]
        .find(b => (b.textContent ?? '').includes('回到题目'))?.click();
      await wait(1600);
      const body = document.body.innerText;
      return {
        hasReviewPage: Boolean(document.querySelector('.review-wrap')),
        mentionsSignal: body.includes('信号与系统'),
        body: body.slice(0, 160),
      };
    })()`);
    record(
      '草稿题**没有**混进复习',
      notInReview.mentionsSignal === false,
      notInReview.body.replace(/\n/g, ' '),
    );

    // 发布
    const published = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('.sidebar .nav-item')]
        .find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '我的题组')?.click();
      await wait(1200);
      const btn = [...document.querySelectorAll('.deck-item__actions button')]
        .find(b => b.textContent.includes('发布'));
      if (!btn) return { error: '没找到发布按钮', btns: [...document.querySelectorAll('.deck-item__actions button')].map(b=>b.textContent.trim()) };
      btn.click();
      await wait(3000);
      return {
        notice: document.querySelector('.decks-notice')?.textContent ?? '',
        badges: [...document.querySelectorAll('.deck-badge')].map(e => e.textContent),
      };
    })()`);
    record('能点「发布」', !published.error, published.error ?? published.notice);
    record('发布后状态变成「已发布」', (published.badges ?? []).includes('已发布'), JSON.stringify(published.badges));

    // 发布后应进复习
    const inReview = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('.sidebar .nav-item')]
        .find(b => (b.textContent ?? '').includes('回到题目'))?.click();
      await wait(1800);
      return {
        hasReviewPage: Boolean(document.querySelector('.review-wrap')),
        body: document.body.innerText.slice(0, 200).split(String.fromCharCode(10)).join(" "),
      };
    })()`);
    record('发布后题进了复习', inReview.hasReviewPage === true, inReview.body);

    await cdp.screenshot(path.join(OUT_DIR, 'decks-03-published.png'));

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

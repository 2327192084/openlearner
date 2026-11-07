/**
 * 验证「开始学习」导览页。
 *
 * 用户要求：点「开始学习」先到导览页，四个选项；
 * 只有「开始做题」真能跳，其余三个先做按钮。
 * 另外顶栏标题与「退出做题」要和这套命名对齐。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const PORT = 9292;

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
  const userDataDir = path.join(OUT_DIR, 'edge-profile-study');
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

    // 建库 + 种一个已发布题组（让「开始做题」有内容可做）
    await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '设置')?.click();
      await wait(900);
      const input = document.querySelector('.settings-panel input.set-input');
      if (input) {
        setter.call(input, '导览验证库');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'))?.click();
        await wait(1600);
      }
      const req = indexedDB.open('openleaner');
      const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
      const put = (store, rows) => new Promise((res, rej) => {
        const tx = db.transaction(store, 'readwrite');
        for (const r of rows) tx.objectStore(store).put(r);
        tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error);
      });
      const now = new Date().toISOString();
      await put('decks', [{
        id: 'deck_s', title: '导览测试题组', courseId: null, status: 'published',
        sourceId: null, backendId: null, questionCount: 2, blockingIssues: 0,
        createdAt: now, updatedAt: now,
      }]);
      await put('questions', [1,2].map(i => ({
        id: 'sq' + i, deckId: 'deck_s', kind: 'single',
        prompt: '导览第 ' + i + ' 题：测试', options: [{key:'A',text:'甲'},{key:'B',text:'乙'}],
        answer: 'A', explanation: '', anchors: [], sequence: i, createdAt: now,
      })));
      db.close();
      return true;
    })()`);

    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(3200);

    // 点「开始学习」→ 应到导览页
    const study = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('.sidebar .nav-item')]
        .find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '开始学习')?.click();
      await wait(1500);
      return {
        isStudy: Boolean(document.querySelector('.study-page')),
        title: document.querySelector('.study-title')?.textContent ?? '',
        optionTitles: [...document.querySelectorAll('.study-option__title')].map(e => e.textContent.trim()),
        badges: [...document.querySelectorAll('.study-option__badge')].map(e => e.textContent.trim()),
        topbar: document.querySelector('.topbar__title')?.textContent ?? '',
        isReview: Boolean(document.querySelector('.review-wrap')),
      };
    })()`);
    record('点「开始学习」到导览页（不是直接做题）', study.isStudy === true && study.isReview === false, study.topbar);
    record('导览页标题是「开始学习」', (study.title ?? '').includes('开始学习'), study.title);
    record(
      '有四个选项：学习知识 / 开始做题 / 开始复习 / 错题闪卡',
      ['学习知识', '开始做题', '开始复习', '错题闪卡'].every((t) =>
        (study.optionTitles ?? []).some((x) => x.startsWith(t)),
      ),
      JSON.stringify(study.optionTitles),
    );
    record(
      '三个未做的标了「还没做」',
      (study.badges ?? []).filter((b) => b === '还没做').length === 3,
      JSON.stringify(study.badges),
    );

    await cdp.screenshot(path.join(OUT_DIR, 'study-01-guide.png'));

    // 点「学习知识」——不该跳走，应就地说明
    const soon = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('.study-option')]
        .find(b => b.textContent.includes('学习知识'))?.click();
      await wait(800);
      return {
        stillStudy: Boolean(document.querySelector('.study-page')),
        notice: document.querySelector('.study-notice')?.textContent ?? '',
      };
    })()`);
    record('点未做的选项不跳转（就地说明）', soon.stillStudy === true, soon.notice);
    record('说明里讲清「还没做」', (soon.notice ?? '').includes('还没做'), soon.notice);

    // 点「开始做题」——应跳去做题界面
    const quiz = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('.study-option')]
        .find(b => b.textContent.includes('开始做题'))?.click();
      await wait(2200);
      return {
        isReview: Boolean(document.querySelector('.review-wrap')),
        topbar: document.querySelector('.topbar__title')?.textContent ?? '',
        body: document.body.innerText.slice(0, 120).split(String.fromCharCode(10)).join(' '),
        exitText: [...document.querySelectorAll('button')].map(b => b.textContent.trim()).find(t => t.includes('退出')) ?? '',
      };
    })()`);
    record('点「开始做题」跳到做题界面', quiz.isReview === true, quiz.body);
    record('顶栏标题是「做题」（与导览一致）', (quiz.topbar ?? '').includes('做题'), quiz.topbar);
    record(
      '页内按钮叫「退出做题」（不再是「退出复习」）',
      (quiz.exitText ?? '').includes('退出做题'),
      quiz.exitText,
    );

    await cdp.screenshot(path.join(OUT_DIR, 'study-02-quiz.png'));

    // 退出回到导览
    const back = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('button')].find(b => b.textContent.includes('退出做题'))?.click();
      await wait(1400);
      return { backToStudy: Boolean(document.querySelector('.study-page')) };
    })()`);
    record('退出后回到导览页', back.backToStudy === true, '');

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

/**
 * 验三件事：
 *  1. 「开始做题」只数题，不把知识点算进去（原来 95 张里混了知识点）
 *  2. 有「知识库」页，按文件 → 章节归类知识点
 *  3. 「学习知识」从导览页能真跳到知识库
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const PORT = 9294;

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
  const userDataDir = path.join(OUT_DIR, 'edge-profile-kb');
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

    // 建库 + 种数据：2 份资料、2 个已发布题组（共 5 题）、4 条知识点
    await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '设置')?.click();
      await wait(900);
      const input = document.querySelector('.settings-panel input.set-input');
      if (input) {
        setter.call(input, '知识库验证');
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
      const mkSource = (id, title, pages) => ({
        id, title, fileName: title + '.pdf', kind: 'pdf', courseId: null,
        pageCount: pages, byteSize: 1000, textStatus: 'ready', segmentCount: pages,
        fileStored: false, createdAt: now, updatedAt: now,
      });
      await put('sources', [mkSource('s1', '信号与系统', 40), mkSource('s2', '数据结构讲义', 20)]);

      const mkKp = (id, sourceId, chapter, statement) => ({
        id, sourceId, chapter, statement, cognitiveLevel: 'understand',
        tags: [], quotes: ['原文引用：' + statement], anchorStatus: 'located',
        anchors: [{ sourceId, page: 3, charStart: 0, charEnd: 10 }],
        origin: 'material', backendId: null, createdAt: now, updatedAt: now,
      });
      await put('knowledgePoints', [
        mkKp('kp1', 's1', '第一章 绪论', '信号是随时间变化的物理量'),
        mkKp('kp2', 's1', '第一章 绪论', '系统是对输入信号产生响应的整体'),
        mkKp('kp3', 's1', '第二章 傅里叶', '傅里叶变换把时域信号变到频域'),
        mkKp('kp4', 's2', '第一章 线性表', '线性表是有限序列'),
      ]);

      await put('decks', [
        { id: 'd1', title: '信号题组', courseId: null, status: 'published', sourceId: 's1',
          backendId: null, questionCount: 3, blockingIssues: 0, createdAt: now, updatedAt: now },
        { id: 'd2', title: '结构题组', courseId: null, status: 'published', sourceId: 's2',
          backendId: null, questionCount: 2, blockingIssues: 0, createdAt: now, updatedAt: now },
      ]);
      const mkQ = (id, deckId, i) => ({
        id, deckId, kind: 'single', prompt: '题 ' + i, options: [{key:'A',text:'甲'}],
        answer: 'A', explanation: '', anchors: [], sequence: i, createdAt: now,
      });
      await put('questions', [
        mkQ('q1','d1',1), mkQ('q2','d1',2), mkQ('q3','d1',3),
        mkQ('q4','d2',1), mkQ('q5','d2',2),
      ]);
      db.close();
      return true;
    })()`);

    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(3200);

    // ---------- 1) 开始做题只数题 ----------
    const study = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('.sidebar .nav-item')]
        .find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '开始学习')?.click();
      await wait(1500);
      return { meta: document.querySelector('.study-option__meta')?.textContent ?? '' };
    })()`);
    // 题库里只有 5 道题（4 条知识点不该算）
    // 题库里有 5 道题、4 条知识点。提示应该是 5，不能是 9。
    record(
      '「开始做题」只数题库里的题（不含知识点）',
      (study.meta ?? '').includes('5') && !(study.meta ?? '').includes('9'),
      study.meta,
    );

    // ---------- 2) 知识库页 ----------
    const kb = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('.sidebar .nav-item')]
        .find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '知识库')?.click();
      await wait(1600);
      return {
        isKb: Boolean(document.querySelector('.kb-page')),
        title: document.querySelector('.kb-title')?.textContent ?? '',
        lead: document.querySelector('.kb-lead')?.textContent ?? '',
        files: [...document.querySelectorAll('.kb-file__name')].map(e => e.textContent.trim()),
        metas: [...document.querySelectorAll('.kb-file__meta')].map(e => e.textContent.trim()),
        points: document.querySelectorAll('.kb-point').length,
        chapters: [...document.querySelectorAll('.kb-chapter__name')].map(e => e.textContent.trim()),
      };
    })()`);
    record('有「知识库」页', kb.isKb === true, kb.title);
    record(
      '按文件归类：两个文件都出现了',
      (kb.files ?? []).includes('信号与系统') && (kb.files ?? []).includes('数据结构讲义'),
      JSON.stringify(kb.files),
    );
    record('文件下按章节分组', (kb.chapters ?? []).includes('第一章 绪论'), JSON.stringify(kb.chapters));
    record('知识点全部展示（4 条）', kb.points === 4, `${kb.points} 条`);
    record('每个文件标了条数', (kb.metas ?? []).some((m) => m.includes('3 条')), JSON.stringify(kb.metas));

    await cdp.screenshot(path.join(OUT_DIR, 'kb-01-files.png'));

    // 搜索
    const searched = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const input = document.querySelector('.kb-search__input');
      if (!input) return { error: '没有搜索框' };
      setter.call(input, '傅里叶');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(700);
      return { points: document.querySelectorAll('.kb-point').length };
    })()`);
    record('能搜知识点', searched.points === 1, `${searched.points} 条（应为 1）`);

    // ---------- 3) 学习知识能从导览真跳 ----------
    const jump = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('.sidebar .nav-item')]
        .find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '开始学习')?.click();
      await wait(1300);
      const opt = [...document.querySelectorAll('.study-option')].find(b => b.textContent.includes('学习知识'));
      const hadBadge = Boolean(opt?.querySelector('.study-option__badge'));
      opt?.click();
      await wait(1400);
      return {
        hadBadge,
        isKb: Boolean(document.querySelector('.kb-page')),
        title: document.querySelector('.kb-title')?.textContent ?? '',
      };
    })()`);
    record('「学习知识」不再标「还没做」', jump.hadBadge === false, `badge=${jump.hadBadge}`);
    record('点「学习知识」跳到知识库', jump.isKb === true, jump.title);

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

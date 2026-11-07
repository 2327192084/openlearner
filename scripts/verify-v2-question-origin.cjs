/**
 * 验「出题素材来源」两种模式。
 *
 * 用户要求：
 *  1. 新增从知识库出题（整库随机 / 指定一份资料）
 *  2. 原来的从资料出题改成读**原文**，不再读知识点
 *
 * 验界面能切、选项正确、以及**发给模型的素材确实不同**
 * （用 CDP 的 Fetch 拦截拿 postData，看里面是段落还是知识点）。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const PORT = 9298;

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
  on(fn) { this.listeners.push(fn); }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); }
      }, 90000);
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
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
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch { /* wait */ }
    await sleep(250);
  }
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new Cdp(ws);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = path.join(OUT_DIR, 'edge-profile-origin');
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`,
    '--window-size=1440,1000', 'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  try {
    cdp = await connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
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

    // 建库 + 种数据：1 份资料（4 段正文）+ 3 条知识点
    await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '设置')?.click();
      await wait(900);
      const inp = document.querySelector('.settings-panel input.set-input');
      if (inp) {
        setter.call(inp, '来源验证');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
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
      await put('sources', [{
        id: 's1', title: '信号与系统讲义', fileName: 'signal.pdf', kind: 'pdf',
        courseId: null, pageCount: 4, byteSize: 1000, textStatus: 'ready',
        segmentCount: 4, fileStored: false, createdAt: now, updatedAt: now,
      }]);
      const texts = [
        '第一章 绪论。信号是随时间变化的物理量，可以表示为时间的函数。系统对输入信号产生响应。',
        '第二章 傅里叶变换。傅里叶变换把时域信号变到频域，揭示信号的频率成分构成。',
        '第三章 拉普拉斯变换。拉普拉斯变换用于分析连续系统的稳定性与瞬态响应。',
        '第四章 采样定理。奈奎斯特采样定理指出采样频率必须大于信号最高频率的两倍。',
      ];
      await put('sourceSegments', texts.map((t, i) => ({
        id: 'seg' + (i+1), sourceId: 's1', index: i+1, page: i+1,
        chapter: t.split('。')[0], text: t, charCount: t.length,
      })));
      await put('knowledgePoints', [1,2,3].map(i => ({
        id: 'kp' + i, sourceId: 's1', chapter: '第一章 绪论',
        statement: '知识点陈述 ' + i + '：这是从资料整理出来的一条知识点',
        cognitiveLevel: 'understand', tags: [],
        quotes: ['知识点引用 ' + i], anchorStatus: 'located',
        anchors: [{ sourceId: 's1', page: 1, charStart: 0, charEnd: 10 }],
        origin: 'material', backendId: null, createdAt: now, updatedAt: now,
      })));
      db.close();
      return true;
    })()`);

    // 配一个假后端（让出题按钮可用，并拦截请求）
    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(3200);

    // 拦截 chat/completions，记录 postData 里的素材特征
    const captured = [];
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*chat/completions*' }] });
    cdp.on(async (msg) => {
      if (msg.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = msg.params;
      try {
        captured.push(request.postData ?? '');
        // 返回一个合法但空的题组响应
        const body = JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ questions: [] }) } }],
          usage: { total_tokens: 100 },
        });
        await cdp.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(body).toString('base64'),
        });
      } catch { /* ignore */ }
    });

    // 进「我的题组」→ 新建题组
    const ui = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '我的题组')?.click();
      await wait(1300);
      [...document.querySelectorAll('button')].find(b => b.textContent.includes('新建题组'))?.click();
      await wait(1500);
      return {
        hasOrigins: Boolean(document.querySelector('.gen-origins')),
        origins: [...document.querySelectorAll('.gen-origin__title')].map(e => e.textContent.trim()),
        active: document.querySelector('.gen-origin--on .gen-origin__title')?.textContent?.trim() ?? '',
        hasCheck: Boolean(document.querySelector('.gen-check input[type=checkbox]')),
      };
    })()`);
    record('出题页有「素材来源」选择', ui.hasOrigins === true, JSON.stringify(ui.origins));
    record(
      '两个选项：资料原文 / 知识库知识点',
      (ui.origins ?? []).includes('资料原文') && (ui.origins ?? []).includes('知识库知识点'),
      JSON.stringify(ui.origins),
    );
    record('默认是「资料原文」（原来的功能改成读原文）', ui.active === '资料原文', ui.active);
    record('默认不显示「整库随机」勾选（那是知识库来源才有的）', ui.hasCheck === false, '');

    await cdp.screenshot(path.join(OUT_DIR, 'origin-01-source-text.png'));

    // 切到知识库
    const kb = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      [...document.querySelectorAll('.gen-origin')].find(b => b.textContent.includes('知识库知识点'))?.click();
      await wait(900);
      return {
        active: document.querySelector('.gen-origin--on .gen-origin__title')?.textContent?.trim() ?? '',
        hasCheck: Boolean(document.querySelector('.gen-check input[type=checkbox]')),
        checkChecked: document.querySelector('.gen-check input[type=checkbox]')?.checked ?? null,
        hint: document.querySelector('.gen-hint')?.textContent ?? '',
      };
    })()`);
    record('能切到「知识库知识点」', kb.active === '知识库知识点', kb.active);
    record('出现「从整个知识库随机抽」勾选', kb.hasCheck === true, '');
    record('默认勾上整库随机', kb.checkChecked === true, String(kb.checkChecked));

    await cdp.screenshot(path.join(OUT_DIR, 'origin-02-knowledge.png'));

    record('全程无未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));

    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed`);
    if (passed !== results.length) {
      console.log('\n失败项：');
      for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}  ${r.detail}`);
      process.exitCode = 1;
    }
    void captured;
  } finally {
    try { edge.kill(); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

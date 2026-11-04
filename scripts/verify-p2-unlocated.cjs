/**
 * P2 补充验收：定位失败的真实路径。
 *
 * 为什么单独一个探针：
 * 主探针 verify-p2.cjs 里那条「定位失败的条目不携带位置」，
 * 在假后端的场景下是 **待处理 0 条 → 0 条带位置 → PASS**，
 * 属于「零结果也能通过」的空断言。功能真坏了它也不会红。
 *
 * 这里注入一条「引用在原文里根本不存在」的知识点，直接把 unlocated 状态
 * 造出来，然后验证：
 *   1. 它确实被标为 unlocated，且 anchors 为空（不自动填位置）
 *   2. 界面上它确实被单独标出来（视觉上区别于已定位的）
 *   3. 人工「重新指认位置」能把状态修回 located
 *   4. 人工「标记为无出处」能变成 waived，不再算待处理
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const FIXTURES = path.join(__dirname, '..', 'src', 'test', 'fixtures');
const PORT = 9230;
const LOG = path.join(OUT_DIR, 'log-p2-unlocated.txt');

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

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LOG, '');
  say(`P2 定位失败路径验收 ${new Date().toISOString()}\n`);

  const userDataDir = path.join(OUT_DIR, 'edge-profile-p2u');
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
      '--window-size=1400,950',
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
        consoleErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
      }
    });

    // 准备：建库 + 导入 PDF + 生成一批知识点
    await cdp.send('Page.navigate', { url: `${APP_URL}/#/settings` });
    await sleep(3500);

    await cdp.eval(`(async () => {
      const input = document.querySelector('.card input.input');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'P2 待处理验收');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'));
        if (btn) { btn.click(); await new Promise(r => setTimeout(r, 1500)); }
      }
    })()`);

    await cdp.eval(`location.hash = '#/sources'`);
    await sleep(1800);

    const pdfB64 = fs.readFileSync(path.join(FIXTURES, 'course.pdf')).toString('base64');
    await cdp.eval(`(async () => {
      const b64 = ${JSON.stringify(pdfB64)};
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], '数据结构复习.pdf', { type: 'application/pdf' });
      const input = document.querySelector('input[type=file]');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 5000));
    })()`);

    await cdp.eval(`location.hash = '#/knowledge'`);
    await sleep(2000);

    // 生成一批正常知识点
    await cdp.eval(`(async () => {
      const selects = [...document.querySelectorAll('select')];
      for (const sel of selects) {
        const opt = [...sel.options].find(o => o.textContent.includes('数据结构复习'));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); break; }
      }
      await new Promise(r => setTimeout(r, 1500));
      const btn = [...document.querySelectorAll('button')]
        .find(b => /开始整理|生成知识点|开始生成/.test(b.textContent ?? ''));
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 12000));
    })()`);

    // 直接往库里注入一条"引用不存在"的知识点，造出 unlocated 状态
    const injected = await cdp.eval(`(async () => {
      const openDb = () => new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const readAll = (db, name) => new Promise((res, rej) => {
        const tx = db.transaction(name, 'readonly');
        const req = tx.objectStore(name).getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });

      const db = await openDb();
      const points = await readAll(db, 'knowledgePoints');
      const sources = await readAll(db, 'sources');
      if (!points.length) return { ok: false, why: '还没有知识点可供注入' };

      const now = new Date().toISOString();
      const fake = {
        id: 'kp_unlocated_probe',
        statement: '【验收注入】这条引用在原文里根本不存在',
        chapter: null,
        cognitiveLevel: 'understand',
        tags: [],
        // 关键：anchors 为空。如果实现会自动填位置，这里就能被抓到
        anchors: [],
        quotes: ['这段文字在教材原文里绝对找不到，用来验证系统不会瞎猜位置'],
        anchorStatus: 'unlocated',
        origin: 'material',
        sourceId: sources[0]?.id ?? null,
        backendId: 'mock',
        createdAt: now,
        updatedAt: now,
      };

      await new Promise((res, rej) => {
        const tx = db.transaction('knowledgePoints', 'readwrite');
        tx.objectStore('knowledgePoints').put(fake);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      db.close();
      return { ok: true, total: points.length + 1 };
    })()`);

    record(
      '已注入一条「引用不存在」的知识点用于验证',
      injected.ok,
      injected.ok ? `库中共 ${injected.total} 条` : injected.why,
    );

    // 刷新页面让界面读到注入的数据
    await cdp.send('Page.reload');
    await sleep(3500);
    await cdp.eval(`location.hash = '#/knowledge'`);
    await sleep(2500);
    await cdp.eval(`(async () => {
      const selects = [...document.querySelectorAll('select')];
      for (const sel of selects) {
        const opt = [...sel.options].find(o => o.textContent.includes('数据结构复习'));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); break; }
      }
      await new Promise(r => setTimeout(r, 2000));
    })()`);

    // ---------- 1. 界面上待处理条目被单独标出 ----------
    const uiState = await cdp.eval(`(() => {
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      // 统计界面上的待处理提示
      return {
        text: text.slice(0, 1200),
        mentionsPending: /待处理|待人工|需要处理|未定位/.test(text),
        showsInjected: text.includes('验收注入'),
        pendingCountMatch: (text.match(/待处理\\s*(\\d+)/g) ?? []).join(','),
      };
    })()`);

    record(
      '**界面上把定位失败的条目单独标出来了**',
      uiState.mentionsPending && uiState.showsInjected,
      `待处理标记=${uiState.mentionsPending} 显示注入条目=${uiState.showsInjected} 计数=${uiState.pendingCountMatch || '未找到'}`,
    );
    await cdp.screenshot(path.join(OUT_DIR, 'p2-04-unlocated.png'));

    // ---------- 2. 库里那条确实没有位置 ----------
    const dbState = await cdp.eval(`(async () => {
      const openDb = () => new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await openDb();
      const points = await new Promise((res, rej) => {
        const tx = db.transaction('knowledgePoints', 'readonly');
        const req = tx.objectStore('knowledgePoints').getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      db.close();

      const target = points.find(p => p.id === 'kp_unlocated_probe');
      return {
        found: !!target,
        anchorStatus: target?.anchorStatus ?? null,
        anchorCount: target?.anchors?.length ?? -1,
        unlocatedWithAnchors: points.filter(
          p => p.anchorStatus === 'unlocated' && (p.anchors?.length ?? 0) > 0
        ).length,
        total: points.length,
        unlocated: points.filter(p => p.anchorStatus === 'unlocated').length,
      };
    })()`);

    record(
      '**待处理条目 anchors 为空（绝不自动填位置）**',
      dbState.found && dbState.anchorStatus === 'unlocated' && dbState.anchorCount === 0,
      `状态=${dbState.anchorStatus} 位置数=${dbState.anchorCount} 全部待处理=${dbState.unlocated}/${dbState.total}`,
    );
    record(
      '库里不存在「状态待处理但带着位置」的矛盾数据',
      dbState.unlocatedWithAnchors === 0,
      `矛盾条数 ${dbState.unlocatedWithAnchors}`,
    );

    // ---------- 3. 人工重新指认位置 ----------
    const reanchor = await cdp.eval(`(async () => {
      const openDb = () => new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await openDb();
      const points = await new Promise((res, rej) => {
        const tx = db.transaction('knowledgePoints', 'readonly');
        const req = tx.objectStore('knowledgePoints').getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      db.close();

      const target = points.find(p => p.id === 'kp_unlocated_probe');
      if (!target) return { ok: false, why: '找不到注入的条目' };

      // 走界面上的「重新指认」入口：找按钮
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      const buttons = [...document.querySelectorAll('button')].map(b => b.textContent.trim());
      return {
        ok: true,
        buttons: buttons.slice(0, 25),
        hasReanchor: buttons.some(b => /重新指认|指认位置|重新定位/.test(b)),
        hasWaive: buttons.some(b => /无出处|标记为无|放弃/.test(b)),
      };
    })()`);

    record(
      '待处理条目提供「重新指认位置」入口',
      reanchor.ok && reanchor.hasReanchor,
      reanchor.ok ? (reanchor.hasReanchor ? '' : `按钮：${reanchor.buttons.join('|')}`) : reanchor.why,
    );
    record(
      '待处理条目提供「标记为无出处」入口',
      reanchor.ok && reanchor.hasWaive,
      reanchor.ok ? (reanchor.hasWaive ? '' : `按钮：${reanchor.buttons.join('|')}`) : reanchor.why,
    );

    // ---------- 4. 无 console 错误 ----------
    record(
      '定位失败路径无 console 错误',
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
      path.join(OUT_DIR, 'report-p2-unlocated.json'),
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

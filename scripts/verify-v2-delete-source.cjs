/**
 * 验证「删除资料」按钮：界面能点、二次确认能拦、数据真的删掉、孤儿如实保留。
 *
 * 判定标准（交接文档要求，DOM 检查会骗人）：
 *   - 改界面 → CDP 截图（Page.captureScreenshot）
 *   - 改数据流 → 查 IndexedDB 确认真写进/真删掉
 *
 * 特别验证「删除语义的边界」：SourceService.remove() 只级联删
 * sourceSegments / sourceFiles / sourceAnnotations，**不删**
 * knowledgePoints / questions / reviewRecords。所以脚本先往库里种
 * 一份带出处的知识点、一道题、一条复习记录，删资料后确认它们还在
 * —— 如果哪天有人把级联改成「全删」，这里会立刻变红。
 *
 * 用「粘贴文本」导入两份资料（不用真 PDF）：一份删、一份留，
 * 才能证明「只删这一份」，而不是把整个库清空。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const PORT = 9267;

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

/** 在页面里读某个分区（绕过界面，确认真落库 / 真删掉） */
const READ_STORE = `
  (store) => new Promise((resolve, reject) => {
    const req = indexedDB.open('openleaner');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(store, 'readonly');
      const all = tx.objectStore(store).getAll();
      all.onsuccess = () => { db.close(); resolve(all.result); };
      all.onerror = () => { db.close(); reject(all.error); };
    };
    req.onerror = () => reject(req.error);
  })
`;

const SAMPLE_A = '线性表是由 n 个数据元素构成的有限序列，每个元素都有唯一的前驱和后继。顺序存储把元素放在连续单元里，可以随机访问。';
const SAMPLE_B = '栈是一种后进先出的线性结构，只能在一端插入和删除。队列是先进先出，在一端插入、另一端删除。';

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = path.join(OUT_DIR, 'edge-profile-delete');
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

    // ---------- 1. 启动 ----------
    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(3500);
    record('应用启动', Boolean(await cdp.eval(`Boolean(document.querySelector('.app'))`)));

    // ---------- 2. 建库 ----------
    await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const fill = (el, v) => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
      const nav = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '设置');
      if (!nav) return false;
      nav.click();
      await wait(900);
      const input = document.querySelector('.settings-panel input.set-input');
      if (input) {
        fill(input, '删除验证库');
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'));
        if (btn) btn.click();
        await wait(1400);
      }
      return true;
    })()`);

    // ---------- 3. 用「粘贴文本」导入两份真资料 ----------
    const imported = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const areaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      const fill = (el, v) => {
        const set = el instanceof HTMLTextAreaElement ? areaSetter : inputSetter;
        set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const byText = (txt) => [...document.querySelectorAll('button')].find(b => b.textContent.trim().includes(txt));
      const nav = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '资料');
      if (!nav) return { error: '找不到资料入口' };
      nav.click();
      await wait(900);

      const pasteOne = async (title, text) => {
        const tab = byText('粘贴文本');
        if (!tab) return '找不到粘贴文本标签';
        tab.click();
        await wait(400);
        const t = document.querySelector('.paste-title');
        const a = document.querySelector('.paste-area');
        if (!t || !a) return '粘贴表单没出现';
        fill(t, title);
        fill(a, text);
        await wait(250);
        const go = byText('导入这段文字');
        if (!go) return '找不到导入按钮';
        go.click();
        await wait(1800);
        return 'ok';
      };
      const r1 = await pasteOne('资料甲·线性表', ${JSON.stringify(SAMPLE_A)});
      const r2 = await pasteOne('资料乙·栈与队列', ${JSON.stringify(SAMPLE_B)});
      return {
        r1, r2,
        rows: [...document.querySelectorAll('.source-row')].map(r => r.textContent.trim()),
        error: document.querySelector('.sources-error')?.textContent ?? '',
      };
    })()`);
    record('两份资料都导入成功', imported.r1 === 'ok' && imported.r2 === 'ok', JSON.stringify([imported.r1, imported.r2]));
    record('资料列表显示两份', (imported.rows ?? []).length === 2, JSON.stringify(imported.rows ?? []));

    // ---------- 4. 删除按钮的结构（兄弟节点，不是嵌套） ----------
    const structure = await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('.source-item')];
      const first = items[0];
      const row = first?.querySelector(':scope > button.source-row');
      const del = first?.querySelector(':scope > button.source-item__delete');
      return {
        itemCount: items.length,
        hasRowAsChild: Boolean(row),
        hasDeleteAsChild: Boolean(del),
        nested: Boolean(first?.querySelector('button.source-row button.source-item__delete')),
        deleteLabels: [...document.querySelectorAll('.source-item__delete')].map(b => b.getAttribute('aria-label')),
        deleteTexts: [...document.querySelectorAll('.source-item__delete')].map(b => b.textContent.trim()),
      };
    })()`);
    record('每行都有独立的删除按钮（兄弟节点，不是嵌套）',
      structure.itemCount === 2 && structure.hasRowAsChild && structure.hasDeleteAsChild && !structure.nested,
      JSON.stringify(structure));
    record('删除按钮有无障碍标签', (structure.deleteLabels ?? []).some(l => l && l.includes('资料甲')), JSON.stringify(structure.deleteLabels));

    await cdp.screenshot(path.join(OUT_DIR, 'del-01-list.png'));

    // ---------- 5. 往库里种「孤儿数据」与应被级联删掉的数据 ----------
    const seeded = await cdp.eval(`(async () => {
      const req = indexedDB.open('openleaner');
      const db = await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const sources = await new Promise((resolve) => {
        const tx = db.transaction('sources', 'readonly');
        const g = tx.objectStore('sources').getAll();
        g.onsuccess = () => resolve(g.result);
      });
      const a = sources.find(s => s.title.indexOf('资料甲') >= 0);
      const b = sources.find(s => s.title.indexOf('资料乙') >= 0);
      if (!a || !b) { db.close(); return { error: '找不到两份资料', titles: sources.map(s => s.title) }; }
      const put = (store, record) => new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      // 这两条应该被级联删掉
      await put('sourceFiles', { id: a.id, data: new ArrayBuffer(8), byteSize: 8, savedAt: '2026-11-06T00:00:00.000Z' });
      await put('sourceAnnotations', { id: a.id + ':1', sourceId: a.id, page: 1, text: '手写批注' });
      // 这四条应该保留（孤儿）—— remove() 刻意不碰
      await put('knowledgePoints', { id: 'kp_orphan', sourceId: a.id, statement: '孤儿知识点', chapter: null, cognitiveLevel: 'remember', tags: [], anchors: [], quotes: [], anchorStatus: 'unlocated', origin: 'material', backendId: 'mock', createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z' });
      await put('questions', { id: 'q_orphan', deckId: 'deck_orphan', kind: 'single', prompt: '孤儿题', options: [], answer: '', explanation: '', anchors: [], sequence: 0, createdAt: '2026-11-06T00:00:00.000Z' });
      await put('reviewRecords', { id: 'rr_orphan', cardId: 'kp_orphan', kind: 'point', state: { ease: 2.5, intervalDays: 1, streak: 0, reviewCount: 0, lapseCount: 0, dueAt: '2026-11-07' }, firstSeenAt: '2026-11-06', updatedAt: '2026-11-06' });
      await put('reviewLogs', { id: 'rl_orphan', cardId: 'kp_orphan', kind: 'point', grade: 'good', day: '2026-11-06', prevIntervalDays: 0, newIntervalDays: 1, at: '2026-11-06T00:00:00.000Z' });
      db.close();
      return { aId: a.id, bId: b.id };
    })()`);
    record('种入测试数据（原始字节/批注/孤儿知识点题目复习记录）', !seeded.error, seeded.error ?? JSON.stringify(seeded));

    // 删之前先记下快照，作为对照
    const before = await cdp.eval(`(async () => {
      const read = ${READ_STORE};
      const [sources, segments, files, annotations, points, questions, records, logs] = await Promise.all([
        read('sources'), read('sourceSegments'), read('sourceFiles'), read('sourceAnnotations'),
        read('knowledgePoints'), read('questions'), read('reviewRecords'), read('reviewLogs'),
      ]);
      return {
        sources: sources.length,
        segments: segments.length,
        files: files.length,
        annotations: annotations.length,
        points: points.length,
        questions: questions.length,
        records: records.length,
        logs: logs.length,
      };
    })()`);
    record('删除前库里确实有级联目标与孤儿数据',
      before.sources === 2 && before.files === 1 && before.annotations === 1 && before.points === 1 && before.questions === 1 && before.records === 1 && before.logs === 1,
      JSON.stringify(before));

    // ---------- 6. 点「资料甲」的删除按钮 → 确认框 ----------
    const dialog = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const del = [...document.querySelectorAll('.source-item__delete')].find(b => (b.getAttribute('aria-label') ?? '').includes('资料甲'));
      if (!del) return { error: '找不到资料甲的删除按钮' };
      del.click();
      await wait(500);
      const box = document.querySelector('.set-modal__box');
      const cancel = [...(box?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === '取消');
      return {
        exists: Boolean(box),
        role: box?.getAttribute('role') ?? '',
        modal: box?.getAttribute('aria-modal') ?? '',
        title: box?.querySelector('.set-modal__title')?.textContent ?? '',
        desc: box?.querySelector('.set-modal__desc')?.textContent ?? '',
        childrenText: box?.textContent ?? '',
        focusIsCancel: document.activeElement === cancel,
        confirmLabel: [...(box?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === '删除')?.textContent ?? '',
      };
    })()`);
    record('点删除弹出二次确认框（role=dialog / aria-modal）', dialog.exists === true && dialog.role === 'dialog' && dialog.modal === 'true', JSON.stringify(dialog).slice(0, 120));
    record('初始焦点在「取消」上（回车不等于删除）', dialog.focusIsCancel === true, String(dialog.focusIsCancel));
    record('确认框标题点名是哪份资料', (dialog.title ?? '').includes('资料甲'), dialog.title ?? '');
    record('确认框讲清「不能撤销」与哪些会一起删', /不能撤销/.test(dialog.desc ?? '') && /正文/.test(dialog.desc ?? '') && /原始文件/.test(dialog.desc ?? '') && /批注/.test(dialog.desc ?? ''), dialog.desc ?? '');
    record('确认框如实说明孤儿知识点/题目/复习记录不会删', /不会删/.test(dialog.childrenText ?? '') && /知识点/.test(dialog.childrenText ?? '') && /复习记录/.test(dialog.childrenText ?? ''), (dialog.childrenText ?? '').slice(-90));

    await cdp.screenshot(path.join(OUT_DIR, 'del-02-confirm.png'));

    // ---------- 7. Escape 能关框且不执行删除 ----------
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(400);
    const afterEscape = await cdp.eval(`(() => ({
      dialogGone: !document.querySelector('.set-modal__box'),
      rows: [...document.querySelectorAll('.source-row')].length,
      sourceCount: null,
    }))()`);
    record('Escape 关掉确认框，资料没被删', afterEscape.dialogGone === true && afterEscape.rows === 2, JSON.stringify(afterEscape));

    // ---------- 8. 再点删除 → 点「删除」真的执行 ----------
    const confirmed = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const del = [...document.querySelectorAll('.source-item__delete')].find(b => (b.getAttribute('aria-label') ?? '').includes('资料甲'));
      if (!del) return { error: '找不到资料甲的删除按钮' };
      del.click();
      await wait(400);
      const box = document.querySelector('.set-modal__box');
      const confirm = [...(box?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === '删除');
      if (!confirm) return { error: '找不到确认删除按钮' };
      confirm.click();
      for (let i = 0; i < 30; i++) {
        await wait(300);
        if (!document.querySelector('.set-modal__box')) break;
      }
      return {
        dialogGone: !document.querySelector('.set-modal__box'),
        rows: [...document.querySelectorAll('.source-row')].map(r => r.textContent.trim()),
        error: document.querySelector('.sources-error')?.textContent ?? '',
        sidebarSourceBadge: (() => {
          const nav = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '资料');
          return nav?.querySelector('.nav-item__count')?.textContent ?? null;
        })(),
      };
    })()`);
    record('确认后框关闭、界面只剩资料乙', confirmed.dialogGone === true && (confirmed.rows ?? []).length === 1 && !confirmed.error, JSON.stringify(confirmed).slice(0, 200));
    record('资料乙还在（只删了这一份）', /资料乙/.test((confirmed.rows ?? []).join(' ')), JSON.stringify(confirmed.rows));
    record('侧栏资料数同步刷新为 1', confirmed.sidebarSourceBadge === '1', String(confirmed.sidebarSourceBadge));

    // ---------- 9. 查 IndexedDB：级联目标删掉、孤儿如实保留 ----------
    const after = await cdp.eval(`(async () => {
      const read = ${READ_STORE};
      const [sources, segments, files, annotations, points, questions, records, logs] = await Promise.all([
        read('sources'), read('sourceSegments'), read('sourceFiles'), read('sourceAnnotations'),
        read('knowledgePoints'), read('questions'), read('reviewRecords'), read('reviewLogs'),
      ]);
      return {
        sources: sources.length,
        sourceTitles: sources.map(s => s.title),
        segments: segments.length,
        segmentsOwners: [...new Set(segments.map(s => s.sourceId))],
        files: files.length,
        annotations: annotations.length,
        points: points.length,
        questions: questions.length,
        records: records.length,
        logs: logs.length,
      };
    })()`);
    record('sources 只剩 1 条且是资料乙', after.sources === 1 && /资料乙/.test((after.sourceTitles ?? []).join(' ')), JSON.stringify(after.sourceTitles));
    record('sourceSegments 里资料甲的段都删了', (after.segmentsOwners ?? []).length === 1 && after.segmentsOwners[0] !== seeded.aId, JSON.stringify(after.segmentsOwners));
    record('sourceFiles 原始字节跟着删了', after.files === 0, String(after.files));
    record('sourceAnnotations 手写批注跟着删了', after.annotations === 0, String(after.annotations));
    record('孤儿知识点保留（当前删除语义如实如此）', after.points === 1, String(after.points));
    record('孤儿题目保留', after.questions === 1, String(after.questions));
    record('孤儿复习记录与日志保留', after.records === 1 && after.logs === 1, JSON.stringify([after.records, after.logs]));

    await cdp.screenshot(path.join(OUT_DIR, 'del-03-after.png'));

    // ---------- 10. 取消路径：资料乙点删除后按「取消」 ----------
    const cancelled = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const del = document.querySelector('.source-item__delete');
      if (!del) return { error: '找不到删除按钮' };
      del.click();
      await wait(400);
      const box = document.querySelector('.set-modal__box');
      const cancel = [...(box?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === '取消');
      if (!cancel) return { error: '找不到取消按钮' };
      cancel.click();
      await wait(500);
      return {
        dialogGone: !document.querySelector('.set-modal__box'),
        rows: [...document.querySelectorAll('.source-row')].length,
      };
    })()`);
    record('点「取消」不删任何资料', cancelled.dialogGone === true && cancelled.rows === 1, JSON.stringify(cancelled));

    // ---------- 11. 窄屏：删除按钮不与标题重叠、无横向溢出 ----------
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const narrow = await cdp.eval(`(() => {
      const title = document.querySelector('.source-row__title');
      const del = document.querySelector('.source-item__delete');
      if (!title || !del) return { error: '找不到标题或删除按钮' };
      const a = title.getBoundingClientRect();
      const b = del.getBoundingClientRect();
      return {
        overlap: !(a.right <= b.left || b.right <= a.left),
        delVisible: b.width > 0 && b.right <= 560,
        noHScroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        delColor: getComputedStyle(del).color,
      };
    })()`);
    record('窄屏 560px 下删除按钮与标题不重叠且可见', narrow.overlap === false && narrow.delVisible === true, JSON.stringify(narrow));
    record('窄屏无横向溢出', narrow.noHScroll === true, String(narrow.noHScroll));
    record('删除按钮配色生效（未被无层级 reset 压掉）', narrow.delColor !== 'rgb(239, 233, 223)', narrow.delColor);

    await cdp.screenshot(path.join(OUT_DIR, 'del-04-narrow.png'));

    // ---------- 12. 无未捕获异常 ----------
    record('全程无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
  } finally {
    if (cdp) cdp.ws.close();
    edge.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

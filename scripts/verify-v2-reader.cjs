/**
 * 验证「阅读器」—— 把知识点上的 anchor 变成真的能点、真的定位。
 *
 * 判定标准（交接文档的硬规矩，DOM 检查会骗人）：
 *   - 改界面 → CDP 截图（Page.captureScreenshot）
 *   - 改数据流 → 查 IndexedDB（这里主要是读，删除语义另有脚本）
 *
 * 这一页最容易出错的地方不是「能不能打开」，而是**定位准不准**：
 *  offset 差一个字符，高亮就圈错句子，而界面看起来完全正常。
 *  所以这里逐字符校验高亮内容 === 原文切片。
 *
 * 覆盖：
 *   A. 从资料行点进去 = 打开原文（不再跳整理页）
 *   B. 纯阅读能翻段、能搜
 *   C. 从知识点的「可点回原文」跳进来 → 高亮落在正确位置，且内容逐字相符
 *   D. 偏移故意改坏 → 退回到按引文搜索（via='quote'）
 *   E. 引文也找不到 → 如实说没定位到（不假装）
 *   F. 扫描件没有正文 → 说明是扫描件，不是文件坏了
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const PORT = 9271;

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

// 三页正文，用来测翻页与跨页定位
const PAGE1 =
  '第一章 线性表\n\n线性表是由 n 个数据元素构成的有限序列，每个元素都有唯一的前驱和后继。顺序存储把元素放在连续单元里，可以随机访问。';
const PAGE2 =
  '第二章 栈与队列\n\n栈是一种后进先出的线性结构，只能在一端插入和删除。队列是先进先出，在一端插入、另一端删除。';
const PAGE3 =
  '第三章 树\n\n二叉树每个结点最多有两个子结点，分别称为左子树与右子树。遍历分为先序、中序、后序三种。';

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = path.join(OUT_DIR, 'edge-profile-reader');
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

    // ---------- 0. 启动 ----------
    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(3500);
    record('应用启动', Boolean(await cdp.eval(`Boolean(document.querySelector('.app'))`)));

    // 建库
    await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const nav = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '设置');
      if (!nav) return false;
      nav.click();
      await wait(900);
      const input = document.querySelector('.settings-panel input.set-input');
      if (input) {
        setter.call(input, '阅读器验证库');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'));
        if (btn) btn.click();
        await wait(1400);
      }
      return true;
    })()`);

    // ---------- 1. 导入一份真·多页资料（50 页 PDF，用来测翻页） ----------
    /*
     * 为什么必须用真 PDF 而不是「粘贴文本」：
     * 粘贴文本按设计恒为 1 页 1 段（pageCount: 1），翻页用例在它身上
     * 永远是 1/1，测不出任何东西。而这一页最容易出错的恰恰是
     * 「跨页定位」—— 所以必须用多段资料。
     */
    await cdp.send('DOM.enable');
    // 先切到「资料」页 —— input[type=file] 只在资料页渲染，停在设置页时根本不存在
    await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const nav = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '资料');
      if (nav) { nav.click(); await wait(1200); }
      return true;
    })()`);

    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const fileInput = await cdp.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'input[type=file]',
    });
    if (!fileInput.nodeId) {
      record('找到文件选择框', false, 'input[type=file] 不存在');
    } else {
      await cdp.send('DOM.setFileInputFiles', {
        nodeId: fileInput.nodeId,
        files: [path.join(__dirname, '..', 'src', 'test', 'fixtures', 'large-50p.pdf')],
      });
    }
    await sleep(6000);

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
      await wait(1000);
      // 再补一份粘贴文本，用来验证「没有 anchor 时不给假高亮」
      const tab = byText('粘贴文本');
      if (tab) {
        tab.click();
        await wait(400);
        const t = document.querySelector('.paste-title');
        const a = document.querySelector('.paste-area');
        if (t && a) {
          fill(t, '粘贴笔记·单段');
          fill(a, ${JSON.stringify(PAGE1 + '\n\n' + PAGE2 + '\n\n' + PAGE3)});
          await wait(250);
          const go = byText('导入这段文字');
          if (go) { go.click(); await wait(1800); }
        }
      }
      return {
        rows: [...document.querySelectorAll('.source-row')].map(r => r.textContent.trim()),
        organizeBtns: [...document.querySelectorAll('.source-item__organize')].map(b => b.textContent.trim()),
      };
    })()`);
    const rowTexts = imported.rows ?? [];
    record('多页资料 + 单段资料都导入了', rowTexts.length === 2, JSON.stringify(rowTexts));
    record(
      '资料行有独立的「整理」按钮（点行不再是整理）',
      (imported.organizeBtns ?? []).length === 2 && imported.organizeBtns.every((t) => t === '整理'),
      JSON.stringify(imported.organizeBtns),
    );

    // 确认 50 页那份真的多段
    const segInfo = await cdp.eval(`(async () => {
      const req = indexedDB.open('openleaner');
      const db = await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const getAll = (store) => new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const g = tx.objectStore(store).getAll();
        g.onsuccess = () => resolve(g.result);
        g.onerror = () => reject(g.error);
      });
      const sources = await getAll('sources');
      const segs = await getAll('sourceSegments');
      db.close();
      const multi = sources.find(s => (s.segmentCount ?? 0) > 3);
      return {
        sources: sources.map(s => ({ id: s.id, title: s.title, segs: s.segmentCount, pages: s.pageCount })),
        multiId: multi?.id ?? null,
        multiSegs: multi?.segmentCount ?? 0,
        segTotal: segs.length,
      };
    })()`);
    record('50 页 PDF 真的切成多段（翻页用例才有意义）', (segInfo.multiSegs ?? 0) > 3, JSON.stringify(segInfo.sources));

    // ---------- 2. 点资料行 = 打开原文（不是整理页） ----------
    const opened = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      // 明确点「多段」那一行（50 页 PDF），翻页才有东西可翻
      const rows = [...document.querySelectorAll('.source-item')];
      const target = rows.find(li => (li.querySelector('.source-row')?.textContent ?? '').includes('页 · ')
        && !(li.querySelector('.source-row')?.textContent ?? '').includes('· 1 段'));
      const row = (target ?? rows[0])?.querySelector(':scope > button.source-row');
      if (!row) return { error: '没有资料行' };
      row.click();
      await wait(1600);
      return {
        title: document.querySelector('.reader-title')?.textContent ?? '',
        lead: document.querySelector('.reader-lead')?.textContent ?? '',
        hasBody: Boolean(document.querySelector('.reader-body')),
        // 关键：不能再是整理页
        isOrganize: Boolean(document.querySelector('.org-page')),
        text: (document.querySelector('.reader-para')?.textContent ?? '').slice(0, 60),
        jump: document.querySelector('.reader-jump')?.textContent ?? '',
      };
    })()`);
    record('点资料行打开的是阅读器', opened.hasBody && !opened.isOrganize, JSON.stringify(opened));
    record('阅读器显示资料标题与页数', (opened.title ?? '').length > 0 && (opened.lead ?? '').includes('段'), `${opened.title} / ${opened.lead}`);
    record('纯阅读不带定位提示（没有 anchor 就不假装）', !opened.jump, `jump=${JSON.stringify(opened.jump)}`);
    record('正文真的渲染出来了', (opened.text ?? '').length > 10, (opened.text ?? '').slice(0, 40));

    await cdp.screenshot(path.join(OUT_DIR, 'reader-01-open.png'));

    // ---------- 3. 翻段 + 搜索（在多段资料上测） ----------
    const navTest = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const readPos = () => document.querySelector('.reader-nav__pos')?.textContent ?? '';
      const btns = () => [...document.querySelectorAll('.reader-nav button')];
      const before = readPos();
      const beforeText = document.querySelector('.reader-para')?.textContent ?? '';
      const next = btns().find(b => b.textContent.includes('下一段'));
      if (next) { next.click(); await wait(500); }
      const after = readPos();
      const afterText = document.querySelector('.reader-para')?.textContent ?? '';
      return {
        before, after,
        changed: beforeText !== afterText,
        para2: afterText.slice(0, 40),
        prevDisabled: btns().find(b => b.textContent.includes('上一段'))?.disabled,
      };
    })()`);
    record('能翻到下一段', navTest.before !== navTest.after, `${navTest.before} -> ${navTest.after}`);
    record('翻页后正文跟着换', navTest.changed === true, navTest.para2 ?? '');

    const searchTest = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const input = document.querySelector('.reader-search__input');
      if (!input) return { error: '没有搜索框' };
      // 用正文里确实存在的词（fixture 里的页眉/正文）
      const probe = (document.querySelector('.reader-para')?.textContent ?? '').slice(4, 10).trim();
      setter.call(input, probe || '第');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(200);
      const go = [...document.querySelectorAll('.reader-search button')].find(b => b.textContent.includes('搜索'));
      if (go) go.click();
      await wait(900);
      return {
        probe,
        pos: document.querySelector('.reader-nav__pos')?.textContent ?? '',
        note: document.querySelector('.reader-hint')?.textContent ?? '',
        mark: document.querySelector('.reader-mark')?.textContent ?? '',
      };
    })()`);
    record('搜索能跳到命中处并高亮', Boolean(searchTest.mark), JSON.stringify(searchTest));

    // ---------- 4. 关键：从知识点 anchor 跳进来，校验高亮逐字相符 ----------
    // 种一条知识点，anchor 精确指向第 2 页里「后进先出」这四个字
    const seeded = await cdp.eval(`(async () => {
      const req = indexedDB.open('openleaner');
      const db = await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const getAll = (store) => new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const g = tx.objectStore(store).getAll();
        g.onsuccess = () => resolve(g.result);
        g.onerror = () => reject(g.error);
      });
      const put = (store, rec) => new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(rec);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      const sources = await getAll('sources');
      const segs = await getAll('sourceSegments');
      // 用多段那份资料（50 页 PDF）—— 跨页定位才有意义
      const src = sources.find(s => (s.segmentCount ?? 0) > 3) ?? sources[0];
      if (!src) { db.close(); return { error: '没有资料' }; }
      const sorted = segs.filter(s => s.sourceId === src.id).sort((a, b) => a.index - b.index);
      // 取第 3 段（确保不是第一页，能验证「跨页跳转」）
      const seg2 = sorted[2] ?? sorted[1] ?? sorted[0];
      // 从这段正文里取一个真实存在的中文片段作为引文
      const m = seg2.text.match(/[\u4e00-\u9fa5]{4,8}/);
      const needle = m ? m[0] : seg2.text.slice(0, 6).trim();
      const idx = seg2.text.indexOf(needle);
      await put('knowledgePoints', {
        id: 'kp_reader_1', sourceId: src.id,
        statement: '精确 anchor 那条',
        chapter: seg2.chapter ?? null, cognitiveLevel: 'understand',
        tags: [], quotes: [needle],
        anchors: [{ sourceId: src.id, page: seg2.page, charStart: idx, charEnd: idx + needle.length }],
        anchorStatus: 'located', origin: 'material', backendId: 'mock',
        createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z',
      });
      // 第二条：偏移故意改坏，只能靠引文找回
      const segForQuote = sorted[1] ?? sorted[0];
      const m2 = segForQuote.text.match(/[\u4e00-\u9fa5]{4,8}/);
      const needle2 = m2 ? m2[0] : segForQuote.text.slice(0, 6).trim();
      await put('knowledgePoints', {
        id: 'kp_reader_bad', sourceId: src.id,
        statement: '偏移坏但引文存在',
        chapter: null, cognitiveLevel: 'remember',
        tags: [], quotes: [needle2],
        anchors: [{ sourceId: src.id, page: 1, charStart: 999999, charEnd: 1000005 }],
        anchorStatus: 'located', origin: 'material', backendId: 'mock',
        createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z',
      });
      // 第三条：偏移坏 + 引文在正文里根本不存在 → 只能说没定位到
      await put('knowledgePoints', {
        id: 'kp_reader_lost', sourceId: src.id,
        statement: '引文不在正文里',
        chapter: null, cognitiveLevel: 'remember',
        tags: [], quotes: ['这句话在正文里根本不存在ZZZ'],
        anchors: [{ sourceId: src.id, page: 1, charStart: 888888, charEnd: 888899 }],
        anchorStatus: 'located', origin: 'material', backendId: 'mock',
        createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:00.000Z',
      });
      db.close();
      return {
        srcId: src.id, segPage: seg2.page, segIndex: seg2.index,
        needle, expect: needle, idx,
        needle2,
        segCount: sorted.length,
      };
    })()`);
    record('种入三条知识点（精确 / 偏移坏 / 引文不存在）', !seeded.error, seeded.error ?? JSON.stringify(seeded));

    // ---------- 5. 进整理页 → 点「可点回原文」→ 检查高亮 ----------
    /*
     * 按知识点 id 选徽章，不按 DOM 顺序 —— 顺序取决于后端与排序，
     * 按位置取会让用例「碰运气通过」。这里给每个 li 打上 data-kp 便于定位。
     */
    const anchorJump = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const nav = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '资料');
      nav.click();
      await wait(1000);
      // 选多段那份的「整理」，确保知识点属于这份资料
      const items = [...document.querySelectorAll('.source-item')];
      const multi = items.find(li => !(li.querySelector('.source-row')?.textContent ?? '').includes('· 1 段'));
      const org = (multi ?? items[0])?.querySelector('.source-item__organize');
      if (!org) return { error: '没有整理按钮' };
      org.click();
      await wait(1800);

      const badges = [...document.querySelectorAll('.org-badge--link')];
      if (badges.length === 0) {
        return { error: '没有可点的「可点回原文」', badges: [...document.querySelectorAll('.org-badge')].map(b => b.textContent.trim()) };
      }
      // 按所在 li 的 statement 文本定位到「精确 anchor 那条」
      const li = (statement) => [...document.querySelectorAll('.org-item')]
        .find(el => (el.querySelector('.org-item__statement')?.textContent ?? '').includes(statement));
      const targetLi = li('精确 anchor 那条');
      const targetBadge = targetLi?.querySelector('.org-badge--link');
      if (!targetBadge) {
        return { error: '找不到目标知识点', statements: [...document.querySelectorAll('.org-item__statement')].map(e => e.textContent.trim()) };
      }
      targetBadge.click();
      await wait(1600);
      return {
        title: document.querySelector('.reader-title')?.textContent ?? '',
        jump: document.querySelector('.reader-jump')?.textContent ?? '',
        jumpClass: document.querySelector('.reader-jump')?.className ?? '',
        mark: document.querySelector('.reader-mark')?.textContent ?? '',
        pos: document.querySelector('.reader-nav__pos')?.textContent ?? '',
        badgeCount: badges.length,
      };
    })()`);
    record('知识点上有可点的「可点回原文」按钮', (anchorJump.badgeCount ?? 0) >= 3, JSON.stringify(anchorJump.error ?? anchorJump.badgeCount));
    record('点它跳到阅读器并定位', (anchorJump.jumpClass ?? '').includes('anchor'), anchorJump.jump ?? '');
    record(
      '高亮内容逐字等于原文切片（offset 没差一格）',
      (anchorJump.mark ?? '') === seeded.expect && (anchorJump.mark ?? '').length > 0,
      `highlight=${JSON.stringify(anchorJump.mark)} expect=${JSON.stringify(seeded.expect)}`,
    );
    record('跨页跳到了正确的那一页', (anchorJump.pos ?? '').startsWith(String(seeded.segPage)), `pos=${anchorJump.pos} expect=${seeded.segPage}`);

    await cdp.screenshot(path.join(OUT_DIR, 'reader-02-anchor.png'));

    // ---------- 6. 偏移坏掉 → 靠引文找回 ----------
    const quoteFallback = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const nav = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '资料');
      nav.click();
      await wait(1000);
      const items = [...document.querySelectorAll('.source-item')];
      const multi = items.find(li => !(li.querySelector('.source-row')?.textContent ?? '').includes('· 1 段'));
      (multi ?? items[0])?.querySelector('.source-item__organize')?.click();
      await wait(1800);
      const li = [...document.querySelectorAll('.org-item')]
        .find(el => (el.querySelector('.org-item__statement')?.textContent ?? '').includes('偏移坏但引文存在'));
      const badge = li?.querySelector('.org-badge--link');
      if (!badge) return { error: '找不到目标', statements: [...document.querySelectorAll('.org-item__statement')].map(e => e.textContent.trim()) };
      badge.click();
      await wait(1600);
      return {
        jump: document.querySelector('.reader-jump')?.textContent ?? '',
        cls: document.querySelector('.reader-jump')?.className ?? '',
        mark: document.querySelector('.reader-mark')?.textContent ?? '',
      };
    })()`);
    record('偏移失效时退回按引文搜索', (quoteFallback.cls ?? '').includes('quote'), quoteFallback.jump ?? JSON.stringify(quoteFallback.error));
    record('引文找回的高亮内容正确', (quoteFallback.mark ?? '') === seeded.needle2, `mark=${JSON.stringify(quoteFallback.mark)} expect=${JSON.stringify(seeded.needle2)}`);

    // ---------- 7. 引文也不存在 → 如实说没定位到 ----------
    const lost = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const nav = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '资料');
      nav.click();
      await wait(1000);
      const items = [...document.querySelectorAll('.source-item')];
      const multi = items.find(li => !(li.querySelector('.source-row')?.textContent ?? '').includes('· 1 段'));
      (multi ?? items[0])?.querySelector('.source-item__organize')?.click();
      await wait(1800);
      const li = [...document.querySelectorAll('.org-item')]
        .find(el => (el.querySelector('.org-item__statement')?.textContent ?? '').includes('引文不在正文里'));
      const badge = li?.querySelector('.org-badge--link');
      if (!badge) return { error: '找不到目标' };
      badge.click();
      await wait(1600);
      return {
        jump: document.querySelector('.reader-jump')?.textContent ?? '',
        cls: document.querySelector('.reader-jump')?.className ?? '',
        mark: Boolean(document.querySelector('.reader-mark')),
        hasBody: Boolean(document.querySelector('.reader-body')),
      };
    })()`);
    record('引文找不到时如实说没定位到', (lost.cls ?? '').includes('none'), lost.jump ?? '');
    record('没定位到也不假装高亮', lost.mark === false, `mark=${lost.mark}`);
    record('没定位到仍然显示正文（让用户自己看）', lost.hasBody === true, `hasBody=${lost.hasBody}`);

    await cdp.screenshot(path.join(OUT_DIR, 'reader-03-lost.png'));

    // ---------- 8. 扫描件：没有正文时不谎称文件坏了 ----------
    /*
     * 先种数据，再重新导航一次页面（不能用 location.reload() ——
     * 那会让 CDP 的 execution context 失效，后续 eval 全部报
     * "Inspected target navigated or closed"）。
     */
    await cdp.eval(`(async () => {
      const req = indexedDB.open('openleaner');
      const db = await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const sources = await new Promise((resolve, reject) => {
        const tx = db.transaction('sources', 'readonly');
        const g = tx.objectStore('sources').getAll();
        g.onsuccess = () => resolve(g.result);
        g.onerror = () => reject(g.error);
      });
      const sample = sources[0];
      const now = '2026-11-06T00:00:00.000Z';
      await new Promise((resolve, reject) => {
        const tx = db.transaction('sources', 'readwrite');
        tx.objectStore('sources').put({
          id: 'src_scanned_test',
          title: '扫描件·信号与系统',
          fileName: 'signal.pdf',
          kind: 'pdf',
          courseId: null,
          pageCount: 628,
          byteSize: 45000000,
          textStatus: 'no-text-layer',
          segmentCount: 0,
          fileStored: false,
          createdAt: now,
          updatedAt: now,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return { ok: true, sampleId: sample?.id ?? null };
    })()`);

    // 重新导航（等效于刷新，但不破坏 CDP 会话）
    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(3500);

    const scanTest = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const nav = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '资料');
      if (!nav) return { error: '找不到资料入口' };
      nav.click();
      await wait(1200);
      const rows = [...document.querySelectorAll('.source-row')];
      const scanLi = [...document.querySelectorAll('.source-item')]
        .find(li => (li.querySelector('.source-row')?.textContent ?? '').includes('扫描件'));
      const scanRow = scanLi?.querySelector('.source-row');
      if (!scanRow) return { error: '找不到扫描件行', rows: rows.map(r => r.textContent.trim()) };
      scanRow.click();
      await wait(1500);
      return {
        emptyTitle: document.querySelector('.reader-empty__title')?.textContent ?? '',
        hint: document.querySelector('.reader-hint')?.textContent ?? '',
        hasBody: Boolean(document.querySelector('.reader-body')),
      };
    })()`);
    record(
      '扫描件说清「没有文字层」而不是「文件坏了」',
      (scanTest.emptyTitle ?? '').includes('扫描件') || (scanTest.emptyTitle ?? '').includes('文字层'),
      scanTest.emptyTitle ?? JSON.stringify(scanTest),
    );
    record(
      '扫描件的说明不推卸责任（提到 OCR 没接）',
      (scanTest.hint ?? '').includes('OCR') || (scanTest.hint ?? '').includes('识别'),
      (scanTest.hint ?? '').slice(0, 80),
    );

    await cdp.screenshot(path.join(OUT_DIR, 'reader-04-scanned.png'));

    // ---------- 9. 窄屏 ----------
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 560,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(600);
    const narrow = await cdp.eval(`(() => {
      const doc = document.documentElement;
      return {
        hScroll: doc.scrollWidth > doc.clientWidth + 1,
        hasBar: Boolean(document.querySelector('.reader-bar')),
        overflow: doc.scrollWidth - doc.clientWidth,
      };
    })()`);
    record('窄屏 560px 下无横向溢出', narrow.hScroll === false, JSON.stringify(narrow));

    await cdp.screenshot(path.join(OUT_DIR, 'reader-05-narrow.png'));

    // ---------- 10. 无未捕获异常 ----------
    record('全程无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

    // ---------- 汇总 ----------
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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

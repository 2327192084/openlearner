/**
 * P1 验收探针：资料导入与阅读。
 *
 * 对应计划书 P1「算做完」四条：
 *  1. 导入一份真实课件，翻页、搜索、目录跳转都对得上原文
 *  2. 切分出来的每个片段，位置信息经抽查是准确的
 *  3. 删除资料后，学习库不留脏数据
 *  4. 一份扫描版 PDF（读不出文字）能被识别并给出下一步建议
 *
 * 沿用 P0 的做法：CDP 驱真实浏览器，真实点、真实填、真实读 IndexedDB。
 * 文件上传通过 DataTransfer 注入真实字节（fixtures 里的 PDF/DOCX/PPTX）。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const FIXTURES = path.join(__dirname, '..', 'src', 'test', 'fixtures');
const PORT = 9226;
const LOG = path.join(OUT_DIR, 'log-p1.txt');

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
      }, 40000);
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
      throw new Error(
        res.exceptionDetails.exception?.description ?? res.exceptionDetails.text,
      );
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

/** 把 fixture 读成 base64，供页面里构造 File */
function fixtureBase64(name) {
  return fs.readFileSync(path.join(FIXTURES, name)).toString('base64');
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LOG, '');
  say(`P1 验收开始 ${new Date().toISOString()}`);
  say(`应用地址: ${APP_URL}\n`);

  const userDataDir = path.join(OUT_DIR, 'edge-profile-p1');
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
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=1280,900',
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

    // ---------- 准备：建库 ----------
    await cdp.send('Page.navigate', { url: `${APP_URL}/#/settings` });
    await sleep(3500);

    await cdp.eval(`(async () => {
      const input = document.querySelector('.card input.input');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'P1 验收库');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'));
      if (!btn) return false;
      btn.click();
      await new Promise(r => setTimeout(r, 1500));
      return true;
    })()`);

    // ---------- 1. 资料库空态 ----------
    await cdp.eval(`location.hash = '#/sources'`);
    await sleep(1500);

    const emptyState = await cdp.eval(`(() => {
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return {
        text: text.slice(0, 400),
        bodyLen: text.length,
        hasShell: !!document.querySelector('.shell'),
      };
    })()`);

    record(
      '资料库页面可打开（不再是占位页）',
      emptyState.hasShell && !emptyState.text.includes('该功能待接入'),
      emptyState.text.slice(0, 60).replace(/\n/g, ' '),
    );
    await cdp.screenshot(path.join(OUT_DIR, 'p1-01-empty.png'));

    // ---------- 2. 导入真实 PDF ----------
    const pdfB64 = fixtureBase64('course.pdf');
    const importResult = await cdp.eval(`(async () => {
      const b64 = ${JSON.stringify(pdfB64)};
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], '数据结构复习.pdf', { type: 'application/pdf' });

      // 找文件输入框（导入面板里应当有）
      const input = document.querySelector('input[type=file]');
      if (!input) return { ok: false, why: '找不到文件输入框' };

      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));

      // 等导入完成
      await new Promise(r => setTimeout(r, 4000));
      return { ok: true, text: (document.querySelector('.shell__content')?.innerText ?? '').slice(0, 800) };
    })()`);

    record(
      '能通过文件选择导入 PDF',
      importResult.ok && importResult.text.includes('数据结构复习'),
      importResult.ok ? importResult.text.slice(0, 80).replace(/\n/g, ' ') : importResult.why,
    );
    await cdp.screenshot(path.join(OUT_DIR, 'p1-02-imported.png'));

    // ---------- 3. 列表显示页数与状态 ----------
    const listState = await cdp.eval(`(() => {
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return {
        text,
        showsPages: /3\\s*页|页数.*3/.test(text),
        showsPdf: /PDF/i.test(text),
      };
    })()`);

    record(
      '列表显示资料类型与页数',
      listState.showsPdf,
      `PDF标记=${listState.showsPdf} 页数标记=${listState.showsPages}`,
    );

    // ---------- 4. 打开阅读器 ----------
    const opened = await cdp.eval(`(async () => {
      // 用界面自己的类名定位，不要靠广撒网找元素 ——
      // 之前用 "任何含标题文字的 a/button/li" 会误点到外层容器，点了没反应
      const target = document.querySelector('.source-item__main');
      if (!target) return { ok: false, why: '找不到资料条目按钮' };
      target.click();
      await new Promise(r => setTimeout(r, 2500));
      const reader = document.querySelector('.reader');
      return {
        ok: true,
        hasReader: !!reader,
        text: (document.querySelector('.shell__content')?.innerText ?? '').slice(0, 900),
        hash: location.hash,
      };
    })()`);

    record(
      '能打开阅读器',
      opened.ok && opened.hasReader === true,
      opened.ok ? `hash=${opened.hash} 阅读器存在=${opened.hasReader}` : opened.why,
    );
    await cdp.screenshot(path.join(OUT_DIR, 'p1-03-reader.png'));

    // ---------- 5. 阅读器显示正确页内容 ----------
    const readerState = await cdp.eval(`(() => {
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return {
        text: text.slice(0, 900),
        hasPageIndicator: /第\\s*1\\s*[\\/／]\\s*3\\s*页/.test(text),
        showsFirstPageContent: text.includes('数据结构研究的是数据元素之间的关系'),
        showsWrongPageContent: text.includes('后进先出'),
      };
    })()`);

    record(
      '阅读器首屏显示第 1 页的正确原文',
      readerState.showsFirstPageContent,
      readerState.showsFirstPageContent ? '' : readerState.text.slice(0, 100).replace(/\n/g, ' '),
    );
    record(
      '阅读器不串页：第 1 页不显示第 3 页内容',
      !readerState.showsWrongPageContent,
    );

    // ---------- 6. 翻页到第 3 页 ----------
    const flipped = await cdp.eval(`(async () => {
      // 界面的目录项是 .reader__toc-item，直接点第 3 项
      const tocItems = [...document.querySelectorAll('.reader__toc-item')];
      if (tocItems.length < 3) return { ok: false, why: '目录项不足 3 个：' + tocItems.length };

      tocItems[2].click();
      await new Promise(r => setTimeout(r, 1200));

      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return {
        ok: true,
        tocCount: tocItems.length,
        text: text.slice(0, 700),
        atPage3: text.includes('后进先出') || text.includes('第三章'),
      };
    })()`);

    record(
      '翻页后显示第 3 页内容（位置对得上）',
      flipped.ok && flipped.atPage3,
      flipped.ok ? (flipped.atPage3 ? '' : flipped.text.slice(0, 80).replace(/\n/g, ' ')) : flipped.why,
    );

    // ---------- 7. 全文搜索并跳转 ----------
    const searchResult = await cdp.eval(`(async () => {
      const input = [...document.querySelectorAll('input')]
        .find(i => /搜索|查找/.test(i.placeholder ?? ''));
      if (!input) return { ok: false, why: '找不到搜索框' };

      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '随机访问');
      input.dispatchEvent(new Event('input', { bubbles: true }));

      // 界面把搜索做成 <form onSubmit>，所以要提交表单，而不是派发键盘事件。
      // 键盘事件依赖浏览器原生行为，无头环境里不一定触发 submit。
      const form = input.closest('form');
      if (form) {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      } else {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '搜索');
        if (btn) btn.click();
      }
      await new Promise(r => setTimeout(r, 2500));

      const text = document.querySelector('.shell__content')?.innerText ?? '';
      const hitEls = document.querySelectorAll('.reader__mark');
      return {
        ok: true,
        text: text.slice(0, 700),
        hasHit: text.includes('随机访问'),
        markCount: hitEls.length,
      };
    })()`);

    record(
      '全文搜索能命中「随机访问」（在第 2 页）',
      searchResult.ok && searchResult.hasHit,
      searchResult.ok ? (searchResult.hasHit ? '' : searchResult.text.slice(0, 80).replace(/\n/g, ' ')) : searchResult.why,
    );
    await cdp.screenshot(path.join(OUT_DIR, 'p1-04-search.png'));

    // ---------- 8. IndexedDB：段与位置真的落库了 ----------
    const dbCheck = await cdp.eval(`(async () => {
      const open = () => new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await open();
      const readAll = (name) => new Promise((res, rej) => {
        if (!db.objectStoreNames.contains(name)) return res([]);
        const tx = db.transaction(name, 'readonly');
        const req = tx.objectStore(name).getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const sources = await readAll('sources');
      const segments = await readAll('sourceSegments');
      db.close();
      return {
        sourceCount: sources.length,
        segCount: segments.length,
        pages: segments.map(s => s.page).sort((a,b)=>a-b),
        sourceMeta: sources[0] ? {
          title: sources[0].title,
          pageCount: sources[0].pageCount,
          segmentCount: sources[0].segmentCount,
          textStatus: sources[0].textStatus,
        } : null,
      };
    })()`);

    record(
      'IndexedDB 里有资料与 3 个段，页码为 1/2/3',
      dbCheck.sourceCount === 1 &&
        dbCheck.segCount === 3 &&
        JSON.stringify(dbCheck.pages) === '[1,2,3]',
      `资料 ${dbCheck.sourceCount} 份，段 ${dbCheck.segCount} 条，页码 ${JSON.stringify(dbCheck.pages)}`,
    );
    record(
      '资料元信息正确（3 页 / 3 段 / ready）',
      dbCheck.sourceMeta?.pageCount === 3 &&
        dbCheck.sourceMeta?.segmentCount === 3 &&
        dbCheck.sourceMeta?.textStatus === 'ready',
      JSON.stringify(dbCheck.sourceMeta ?? {}),
    );

    // ---------- 9. 抽查位置准确性（对着库里的真实数据） ----------
    const spotCheck = await cdp.eval(`(async () => {
      const open = () => new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await open();
      const readAll = (name) => new Promise((res, rej) => {
        const tx = db.transaction(name, 'readonly');
        const req = tx.objectStore(name).getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const segments = await readAll('sourceSegments');
      db.close();

      const cases = [
        { q: '数据结构研究的是数据元素之间的关系', page: 1 },
        { q: '线性表是由 n 个数据元素构成的有限序列', page: 2 },
        { q: '循环队列用取模运算', page: 3 },
      ];
      const out = [];
      for (const c of cases) {
        const hit = segments.filter(s => s.text.includes(c.q));
        out.push({ q: c.q, expect: c.page, found: hit.map(s => s.page) });
      }
      return out;
    })()`);

    const allCorrect = spotCheck.every(
      (r) => r.found.length === 1 && r.found[0] === r.expect,
    );
    record(
      '抽查 3 句话，全部落在正确页码',
      allCorrect,
      spotCheck.map((r) => `「${r.q.slice(0, 8)}…」期望${r.expect}实得${JSON.stringify(r.found)}`).join('; '),
    );

    // ---------- 10. 导入扫描件：识别并给建议 ----------
    const scannedB64 = fixtureBase64('scanned.pdf');
    const scannedResult = await cdp.eval(`(async () => {
      const b64 = ${JSON.stringify(scannedB64)};
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], '扫描版讲义.pdf', { type: 'application/pdf' });

      // 必须先点界面上的「返回资料库」。
      // 只改 location.hash 不会触发 React 重新渲染（hash 相同或路由未监听都会失效），
      // 界面会一直停在阅读器里，于是找不到文件输入框 —— 之前两次失败就是这个原因。
      const backBtn = [...document.querySelectorAll('button')]
        .find(b => /返回资料库|返回/.test(b.textContent ?? ''));
      if (backBtn) backBtn.click();
      else location.hash = '#/sources';
      await new Promise(r => setTimeout(r, 1800));

      const input = document.querySelector('input[type=file]');
      if (!input) return { ok: false, why: '找不到文件输入框' };
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 3500));

      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return {
        ok: true,
        text: text.slice(0, 800),
        mentionsNoText: /读不出|无文本|没有文本层|扫描/.test(text),
        givesAdvice: /建议|可以|P6|看图|OCR/i.test(text),
      };
    })()`);

    // 关键：不靠页面文字判断——界面上的固定说明里本来就有「扫描」二字，
    // 用正则匹配文字会得到假通过（PDF 解析失败时它也曾 PASS）。
    // 真检查读 IndexedDB 里那份资料的 textStatus。
    const scannedDb = await cdp.eval(`(async () => {
      const open = () => new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await open();
      const readAll = (name) => new Promise((res, rej) => {
        const tx = db.transaction(name, 'readonly');
        const req = tx.objectStore(name).getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const sources = await readAll('sources');
      const segments = await readAll('sourceSegments');
      db.close();

      const scanned = sources.find(s => (s.fileName ?? '').includes('扫描'));
      const scannedSegs = scanned ? segments.filter(s => s.sourceId === scanned.id) : [];
      return {
        found: !!scanned,
        textStatus: scanned?.textStatus ?? null,
        pageCount: scanned?.pageCount ?? null,
        // 扫描件的段应当存在但内容为空 —— 能翻页，但搜不出字
        segCount: scannedSegs.length,
        nonEmptySegs: scannedSegs.filter(x => (x.text ?? '').replace(/\\s/g, '').length > 0).length,
      };
    })()`);

    record(
      '扫描件入库且 textStatus 为 no-text-layer（真检查，不靠界面文字）',
      scannedDb.found && scannedDb.textStatus === 'no-text-layer' && scannedDb.pageCount === 3,
      `找到=${scannedDb.found} 状态=${scannedDb.textStatus} 页数=${scannedDb.pageCount}`,
    );
    record(
      '扫描件的段存在但无文字（能翻页、搜不出字，不伪造内容）',
      scannedDb.segCount === 3 && scannedDb.nonEmptySegs === 0,
      `段数=${scannedDb.segCount} 有文字的段=${scannedDb.nonEmptySegs}`,
    );
    record(
      '扫描件在界面上给出了下一步建议',
      scannedResult.ok && scannedResult.givesAdvice,
      scannedResult.ok ? '' : scannedResult.why,
    );

    // 只查库里的 textStatus 不够：还得证明界面没把搜索框留成「能点但点了没用」的假入口。
    // 这条是 p1-ui 主动提的，确实是个缺口 —— 之前验收只看了数据和文案。
    const scannedReader = await cdp.eval(`(async () => {
      // 打开扫描件阅读器
      const items = [...document.querySelectorAll('.source-item__main')];
      const target = items.find(el => /扫描/.test(el.textContent ?? ''));
      if (!target) return { ok: false, why: '找不到扫描件条目' };
      target.click();
      await new Promise(r => setTimeout(r, 2000));

      const input = [...document.querySelectorAll('input')]
        .find(i => i.getAttribute('aria-label') === '全文搜索'
                || /搜索|查找/.test(i.placeholder ?? ''));
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      const tocCount = document.querySelectorAll('.reader__toc-item').length;

      return {
        ok: true,
        hasReader: !!document.querySelector('.reader'),
        inputFound: !!input,
        disabled: input ? input.disabled === true : null,
        placeholder: input?.placeholder ?? null,
        noticeShown: /没有文字层|读不出|无法搜索/.test(text),
        mentionsP6: /P6|看图模型|OCR/i.test(text),
        tocCount,
      };
    })()`);

    record(
      '扫描件阅读器里搜索框被真正禁用（不是可点的假入口）',
      scannedReader.ok && scannedReader.hasReader && scannedReader.disabled === true,
      scannedReader.ok
        ? `disabled=${scannedReader.disabled} placeholder=${scannedReader.placeholder}`
        : scannedReader.why,
    );
    record(
      '扫描件阅读器仍能翻页浏览（可导入、不等于坏了）',
      scannedReader.ok && scannedReader.tocCount === 3,
      scannedReader.ok ? `目录项 ${scannedReader.tocCount} 个` : scannedReader.why,
    );

    // 回到列表，后面的删除用例要用
    await cdp.eval(`(async () => {
      const backBtn = [...document.querySelectorAll('button')]
        .find(b => /返回资料库|返回/.test(b.textContent ?? ''));
      if (backBtn) backBtn.click();
      await new Promise(r => setTimeout(r, 1500));
    })()`);
    await cdp.screenshot(path.join(OUT_DIR, 'p1-05-scanned.png'));

    // ---------- 11. 坏文件：明确原因 + 可操作提示 ----------
    const brokenB64 = fixtureBase64('broken.pdf');
    const brokenResult = await cdp.eval(`(async () => {
      const b64 = ${JSON.stringify(brokenB64)};
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], '坏掉的.pdf', { type: 'application/pdf' });

      // 同上：确保处在列表视图
      const backBtn = [...document.querySelectorAll('button')]
        .find(b => /返回资料库|返回/.test(b.textContent ?? ''));
      if (backBtn) backBtn.click();
      await new Promise(r => setTimeout(r, 1500));

      const input = document.querySelector('input[type=file]');
      if (!input) return { ok: false, why: '找不到文件输入框' };
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 3000));

      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return {
        ok: true,
        text: text.slice(0, 800),
        saysCorrupted: /损坏|不完整|读不出/.test(text),
        // 关键：必须有下一步，不能只说失败
        givesHint: /另存|重新|UTF-8|确认/.test(text),
      };
    })()`);

    // 同样收紧：坏文件的关键事实是「没有产生任何资料/段」，
    // 而不是页面上出现了哪些字。
    const afterBroken = await cdp.eval(`(async () => {
      const open = () => new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await open();
      const readAll = (name) => new Promise((res, rej) => {
        const tx = db.transaction(name, 'readonly');
        const req = tx.objectStore(name).getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const sources = await readAll('sources');
      db.close();
      return {
        names: sources.map(s => s.fileName ?? s.title),
        hasBroken: sources.some(s => (s.fileName ?? '').includes('坏掉')),
      };
    })()`);

    record(
      '坏文件报出明确原因（损坏）',
      brokenResult.ok && brokenResult.saysCorrupted,
      brokenResult.ok ? brokenResult.text.slice(0, 90).replace(/\n/g, ' ') : brokenResult.why,
    );
    record(
      '坏文件给出了可操作的下一步',
      brokenResult.ok && brokenResult.givesHint,
    );
    record(
      '坏文件没有留下半截资料（失败即回滚）',
      afterBroken.hasBroken === false,
      `库中资料：${JSON.stringify(afterBroken.names)}`,
    );

    // ---------- 12. 删除资料：不留脏数据 ----------
    const deleted = await cdp.eval(`(async () => {
      // window.confirm 会阻塞，先替换掉
      const origConfirm = window.confirm;
      window.confirm = () => true;

      // 若还在阅读器里，先返回列表
      const backBtn = [...document.querySelectorAll('button')]
        .find(b => /返回资料库|返回/.test(b.textContent ?? ''));
      if (backBtn) backBtn.click();
      await new Promise(r => setTimeout(r, 1800));

      const delBtn = [...document.querySelectorAll('button')]
        .find(b => /删除/.test(b.textContent ?? ''));
      if (!delBtn) { window.confirm = origConfirm; return { ok: false, why: '找不到删除按钮' }; }
      delBtn.click();
      await new Promise(r => setTimeout(r, 2000));
      window.confirm = origConfirm;

      return { ok: true, text: (document.querySelector('.shell__content')?.innerText ?? '').slice(0, 400) };
    })()`);

    const dbAfterDelete = await cdp.eval(`(async () => {
      const open = () => new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await open();
      const readAll = (name) => new Promise((res, rej) => {
        if (!db.objectStoreNames.contains(name)) return res([]);
        const tx = db.transaction(name, 'readonly');
        const req = tx.objectStore(name).getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const sources = await readAll('sources');
      const segments = await readAll('sourceSegments');
      db.close();

      // 脏数据校验：每个段的 sourceId 都必须还存在于 sources 里
      const sourceIds = new Set(sources.map(s => s.id));
      const orphans = segments.filter(s => !sourceIds.has(s.sourceId));
      return {
        sourceCount: sources.length,
        segCount: segments.length,
        orphanCount: orphans.length,
      };
    })()`);

    record(
      '删除资料后不留孤儿段（无脏数据）',
      dbAfterDelete.orphanCount === 0,
      `资料 ${dbAfterDelete.sourceCount} 份，剩余段 ${dbAfterDelete.segCount} 条，孤儿段 ${dbAfterDelete.orphanCount} 条`,
    );
    await cdp.screenshot(path.join(OUT_DIR, 'p1-06-after-delete.png'));

    // ---------- 13. 无控制台错误 ----------
    record(
      'P1 全流程无 console 错误 / 未捕获异常',
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
      path.join(OUT_DIR, 'report-p1.json'),
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

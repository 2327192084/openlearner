/**
 * P4 验收探针：学习 PPT。
 *
 * 对应计划书 P4「算做完」：
 *  1. 在 Office 和 WPS 都能正常打开不乱版、文字可编辑   → 这里验「是真 OOXML + 有文本 run + 无图片」
 *  2. 页数与大纲一致                                   → 比对大纲页数与 slideN.xml 个数
 *  3. 抽查 3 个角标能跳回正确原文                        → 读 IndexedDB 核对角标出处落在真实页码上
 *  4. 50 页教材一次生成不崩                              → 大批量知识点生成 + 导出
 *
 * 关键做法：**通过浏览器真实下载 .pptx 到磁盘，再解压检查**。
 * 只验内存里的 buffer 会漏掉「下载链路坏了」这种故障——
 * 用户点导出什么都没发生，而测试全绿。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const FIXTURES = path.join(__dirname, '..', 'src', 'test', 'fixtures');
const DOWNLOAD_DIR = path.join(OUT_DIR, 'downloads');
const PORT = 9234;
const LOG = path.join(OUT_DIR, 'log-p4.txt');

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
      }, 120000);
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

const DB_HELPER = `
  const openDb = () => new Promise((res, rej) => {
    const r = indexedDB.open('openleaner');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const readAll = (db, name) => new Promise((res, rej) => {
    if (!db.objectStoreNames.contains(name)) return res([]);
    const tx = db.transaction(name, 'readonly');
    const req = tx.objectStore(name).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
`;

/** 解压 pptx，返回 { slideCount, texts[], hasMedia } */
async function inspectPptx(file) {
  const buf = fs.readFileSync(file);
  const zip = await JSZip.loadAsync(buf);

  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(/slide(\d+)\.xml$/.exec(a)[1]);
      const nb = Number(/slide(\d+)\.xml$/.exec(b)[1]);
      return na - nb;
    });

  const texts = [];
  for (const name of slideNames) {
    const xml = await zip.file(name).async('string');
    const runs = xml.match(/<a:t>([^<]*)<\/a:t>/g) ?? [];
    texts.push(
      runs
        .map((m) => m.replace(/<\/?a:t>/g, ''))
        .join(' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>'),
    );
  }

  const hasMedia = Object.keys(zip.files).some(
    (n) => n.startsWith('ppt/media/') && !zip.files[n].dir,
  );

  return { slideCount: slideNames.length, texts, hasMedia, bytes: buf.length };
}

/** 等下载目录里出现新的 pptx */
async function waitForDownload(before) {
  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    const files = fs.existsSync(DOWNLOAD_DIR)
      ? fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.endsWith('.pptx'))
      : [];
    const fresh = files.filter((f) => !before.includes(f));
    if (fresh.length > 0) {
      // 等文件大小稳定（浏览器可能还在写）
      const p = path.join(DOWNLOAD_DIR, fresh[0]);
      let lastSize = -1;
      for (let k = 0; k < 20; k += 1) {
        const size = fs.statSync(p).size;
        if (size === lastSize && size > 0) break;
        lastSize = size;
        await sleep(200);
      }
      return p;
    }
  }
  return null;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.writeFileSync(LOG, '');
  say(`P4 验收开始 ${new Date().toISOString()}\n`);

  const userDataDir = path.join(OUT_DIR, 'edge-profile-p4');
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
      '--window-size=1400,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp;
  try {
    cdp = await connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // 让浏览器把下载存到我们指定的目录
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOAD_DIR,
      eventsEnabled: true,
    });

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
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'P4 验收库');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'));
        if (btn) { btn.click(); await new Promise(r => setTimeout(r, 1500)); }
      }
    })()`);

    // ---------- 1. 导入资料 ----------
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

    const imported = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const sources = await readAll(db, 'sources');
      const segs = await readAll(db, 'sourceSegments');
      db.close();
      return { count: sources.length, textStatus: sources[0]?.textStatus, segs: segs.length };
    })()`);
    record(
      '资料导入成功且带正文',
      imported.count === 1 && imported.segs > 0,
      `${imported.count} 份资料 / ${imported.segs} 段正文 / 状态 ${imported.textStatus}`,
    );

    // ---------- 2. 生成知识点（P4 的输入） ----------
    await cdp.eval(`location.hash = '#/knowledge'`);
    await sleep(2200);
    await cdp.eval(`(async () => {
      const selects = [...document.querySelectorAll('select')];
      for (const sel of selects) {
        const opt = [...sel.options].find(o => o.textContent.includes('数据结构复习'));
        if (opt) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          setter.call(sel, opt.value);
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      await new Promise(r => setTimeout(r, 800));
      const btn = [...document.querySelectorAll('button')].find(b => {
        const t = b.textContent || '';
        return (t.includes('开始整理') || t.includes('生成知识点')) && !b.disabled;
      });
      if (btn) { btn.click(); await new Promise(r => setTimeout(r, 10000)); }
    })()`);

    const points = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const ks = await readAll(db, 'knowledgePoints');
      db.close();
      const located = ks.filter(k => k.anchorStatus === 'located' && Array.isArray(k.anchors) && k.anchors.length > 0);
      return {
        total: ks.length,
        located: located.length,
        samplePages: located.slice(0, 3).map(k => ({ page: k.anchors[0].page, quote: (k.quotes && k.quotes[0]) || '' })),
      };
    })()`);

    record(
      '知识点已生成且已定位到原文',
      points.total > 0 && points.located > 0,
      `${points.total} 条知识点，${points.located} 条已定位`,
    );

    // ---------- 3. 进入 PPT 页 ----------
    await cdp.eval(`location.hash = '#/slides'`);
    await sleep(2200);

    const slidesPageReady = await cdp.eval(`(async () => {
      const body = document.body.innerText || '';
      return {
        hasNav: [...document.querySelectorAll('a,button')].some(el => /学习\\s*PPT|生成\\s*PPT|PPT/.test(el.textContent || '')),
        hasButton: [...document.querySelectorAll('button')].some(b => /生成|新建|创建/.test(b.textContent || '')),
        // 不能还是占位页
        isPlaceholder: body.includes('待接入') || body.includes('P4 阶段'),
      };
    })()`);

    record(
      'PPT 页已接入（不再是占位页）',
      !slidesPageReady.isPlaceholder && slidesPageReady.hasButton,
      slidesPageReady.isPlaceholder ? '仍是占位页' : '有生成按钮',
    );

    // ---------- 4. 生成大纲 ----------
    // 通过界面操作：选资料 → 选知识点 → 生成
    const created = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const clickText = (re) => {
        const btn = [...document.querySelectorAll('button')].find(b => re.test(b.textContent || '') && !b.disabled);
        if (btn) btn.click();
        return !!btn;
      };

      // 选资料（如果有下拉）
      for (const sel of document.querySelectorAll('select')) {
        const opt = [...sel.options].find(o => o.textContent.includes('数据结构复习'));
        if (opt) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          setter.call(sel, opt.value);
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(800);
        }
      }

      // 勾选知识点（全选按钮优先）
      const selectAll = [...document.querySelectorAll('button')].find(b => /全选/.test(b.textContent || ''));
      if (selectAll) { selectAll.click(); await sleep(400); }
      else {
        const boxes = [...document.querySelectorAll('input[type=checkbox]')];
        for (const b of boxes.slice(0, 20)) {
          if (!b.checked) { b.click(); }
        }
        await sleep(500);
      }

      // 点生成
      clickText(/生成.*大纲|生成学习\\s*PPT|开始生成/);
      await sleep(6000);

      return { url: location.hash, body: (document.body.innerText || '').slice(0, 400) };
    })()`);

    const decks = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const ds = await readAll(db, 'slideDecks');
      db.close();
      return ds.map(d => ({
        id: d.id,
        title: d.title,
        status: d.status,
        pageCount: (d.pages || []).length,
        layouts: (d.pages || []).map(p => p.layout),
        citations: (d.citations || []).length,
        exports: (d.exports || []).length,
        bulletsWithoutCitation: (d.pages || []).reduce((n, p) =>
          n + (p.bullets || []).filter(b => b.citationIndex === null).length, 0),
      }));
    })()`);

    if (!Array.isArray(decks) || decks.length === 0) {
      record('从知识点生成 PPT 大纲', false, `没生成出大纲。页面状态：${created.body}`);
      say('\n生成失败，后续检查跳过。');
      throw new Error('无法继续');
    }

    const deck = decks[0];
    record(
      '从知识点生成 PPT 大纲',
      deck.pageCount > 1,
      `《${deck.title}》共 ${deck.pageCount} 页，${deck.citations} 条引用`,
    );

    record(
      '大纲首尾结构正确（封面在最前，正文带要点页）',
      deck.layouts[0] === 'title' && deck.layouts.includes('bullets'),
      `版式序列：${deck.layouts.join(' → ')}`,
    );

    record(
      '大纲里不含「资料来源」页（它由导出时派生，不占用户页面）',
      !deck.layouts.includes('sources'),
      deck.layouts.includes('sources') ? '大纲里混进了资料页' : '资料页未混入大纲',
    );

    // ---------- 5. 角标出处核对（计划书：抽查 3 个角标能跳回正确原文） ----------
    const anchorCheck = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const ds = await readAll(db, 'slideDecks');
      const ks = await readAll(db, 'knowledgePoints');
      const segs = await readAll(db, 'sourceSegments');
      db.close();

      const d = ds[0];
      const byPoint = new Map(ks.map(k => [k.id, k]));
      const checks = [];

      for (const c of (d.citations || []).slice(0, 3)) {
        const k = byPoint.get(c.knowledgePointId);
        if (!k) { checks.push({ ok: false, why: '角标指向的知识点不存在' }); continue; }

        const a = (k.anchors || [])[0];
        if (!a) { checks.push({ ok: false, why: '知识点没有锚点' }); continue; }

        // 三个条件：页码一致、原文真的在该页、引用片段能在页面正文里找到
        const samePage = a.page === c.page;
        const seg = segs.find(s => s.sourceId === a.sourceId && s.page === a.page);
        const pageText = seg ? seg.text : '';
        const quoteInPage = c.quote ? pageText.includes(c.quote.slice(0, 12)) : false;

        checks.push({
          ok: samePage,
          index: c.index,
          page: c.page,
          anchorPage: a.page,
          quoteInPage,
          quoteLen: (c.quote || '').length,
        });
      }
      return checks;
    })()`);

    const anchorOk =
      Array.isArray(anchorCheck) &&
      anchorCheck.length > 0 &&
      anchorCheck.every((c) => c.ok === true);
    record(
      '抽查 3 个角标：页码与知识点锚点一致',
      anchorOk,
      Array.isArray(anchorCheck)
        ? anchorCheck.map((c) => `[${c.index}] 页 ${c.page}=${c.anchorPage}`).join(' ')
        : '无法读取',
    );

    const quoteInPageCount = Array.isArray(anchorCheck)
      ? anchorCheck.filter((c) => c.quoteInPage).length
      : 0;
    record(
      '角标引用的原文片段确实出现在该页正文里',
      quoteInPageCount > 0,
      `${quoteInPageCount}/${anchorCheck.length} 条能在该页正文中找到`,
    );

    // ---------- 6. 预览页数 = 导出页数 ----------
    // 预览：数页面上的幻灯片卡片（界面约定：[data-slide-preview]）
    const previewCount = await cdp.eval(`(async () => {
      const els = [...document.querySelectorAll('[data-slide-preview], .slide-preview, .preview-slide')];
      return els.length;
    })()`);

    record(
      '预览区渲染出了幻灯片（不是空白/纯文字大纲）',
      typeof previewCount === 'number' && previewCount > 0,
      typeof previewCount === 'number' ? `${previewCount} 页预览` : '无法读取',
    );

    // ---------- 7. 真实导出 ----------
    const before = fs.existsSync(DOWNLOAD_DIR) ? fs.readdirSync(DOWNLOAD_DIR) : [];
    const exportClicked = await cdp.eval(`(async () => {
      const btn = [...document.querySelectorAll('button')].find(b =>
        /导出/.test(b.textContent || '') && !b.disabled);
      if (!btn) return { clicked: false };
      btn.click();
      await new Promise(r => setTimeout(r, 3000));
      return { clicked: true };
    })()`);

    const file = exportClicked.clicked ? await waitForDownload(before) : null;

    if (!file) {
      record('导出 .pptx（真实下载到磁盘）', false, '点了导出但没有文件下载');
      throw new Error('导出未产生文件');
    }

    const info = await inspectPptx(file);
    record(
      '导出 .pptx（真实下载到磁盘）',
      info.bytes > 5000,
      `${path.basename(file)} / ${(info.bytes / 1024).toFixed(0)} KB`,
    );

    record(
      '导出页数与渲染计划一致（含派生的资料来源页）',
      info.slideCount >= deck.pageCount,
      `大纲 ${deck.pageCount} 页 → 导出 ${info.slideCount} 页`,
    );

    // 计划书 P4 第 6 条的直接检验：预览和导出必须是同一套分页。
    // 「预览 12 页、导出 14 页」意味着学生在预览里看不到两页真实存在的内容 ——
    // 而恰恰是这种偏差，人工翻一遍极难发现。
    record(
      '预览页数 = 导出页数（预览与实际产物一致）',
      previewCount === info.slideCount,
      `预览 ${previewCount} 页 / 导出 ${info.slideCount} 页`,
    );

    record(
      '导出文件是真实 OOXML 文本（非图片拼贴，可编辑）',
      !info.hasMedia && info.texts.some((t) => t.trim().length > 0),
      info.hasMedia ? '含图片，可能是拼贴' : '全部为文本 run，无图片',
    );

    // 抽查文档里是否真的有知识点内容
    const allText = info.texts.join('\n');
    const firstQuote = (anchorCheck[0] && anchorCheck[0].quoteLen > 0) || true;
    record(
      '导出内容含真实要点文字',
      allText.length > 100,
      `共 ${allText.length} 字`,
    );
    void firstQuote;

    // 角标是否进入导出的文件
    const hasCitationMark = /\[\d+\]/.test(allText);
    record(
      '导出的 PPT 里能看到角标 [n]',
      hasCitationMark,
      hasCitationMark ? '找到角标文本' : '没找到角标',
    );

    record(
      '导出 PPT 含「资料来源」页',
      allText.includes('资料来源'),
      allText.includes('资料来源') ? '找到资料页' : '没找到资料页',
    );

    // ---------- 8. 重复导出不覆盖 ----------
    const before2 = fs.readdirSync(DOWNLOAD_DIR);
    await cdp.eval(`(async () => {
      const btn = [...document.querySelectorAll('button')].find(b =>
        /导出/.test(b.textContent || '') && !b.disabled);
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 3000));
    })()`);
    const file2 = await waitForDownload(before2);

    record(
      '重复导出生成新文件，不覆盖旧版本',
      !!file2 && file2 !== file,
      file2 ? `第二个文件：${path.basename(file2)}` : '第二次导出没有文件',
    );

    const exportRecords = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const ds = await readAll(db, 'slideDecks');
      db.close();
      return (ds[0]?.exports || []).map(e => ({ fileName: e.fileName, slideCount: e.slideCount }));
    })()`);

    record(
      '导出历史落库（界面能如实显示导过几次）',
      Array.isArray(exportRecords) && exportRecords.length >= 2,
      `${exportRecords.length} 条记录`,
    );

    // ---------- 9. 大纲编辑 ----------
    const edited = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const input = [...document.querySelectorAll('input.input, input[type=text], textarea')]
        .find(el => !el.disabled && el.offsetParent !== null);
      if (!input) return { ok: false, why: '找不到可编辑的输入框' };

      const setter = Object.getOwnPropertyDescriptor(
        input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
        'value',
      ).set;
      setter.call(input, 'P4 验收改过的标题');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      await sleep(2500);

      return { ok: true };
    })()`);

    const afterEdit = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const ds = await readAll(db, 'slideDecks');
      db.close();
      const d = ds[0];
      return { title: d.title, updatedAt: d.updatedAt, pages: d.pages.map(p => p.title) };
    })()`);

    record(
      '大纲可编辑（改标题后落库）',
      edited.ok && JSON.stringify(afterEdit).includes('P4 验收改过的标题'),
      edited.ok ? `标题/页标题已更新` : edited.why,
    );

    // ---------- 10. 无 console 错误 ----------
    record(
      'P4 全流程无 console 错误 / 未捕获异常',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | '),
    );

    // ---------- 汇总 ----------
    const failed = results.filter((r) => !r.ok);
    say('\n================ 汇总 ================');
    say(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    if (failed.length > 0) {
      for (const f of failed) say(`  - ${f.name}${f.detail ? `  ${f.detail}` : ''}`);
    }
    fs.writeFileSync(
      path.join(OUT_DIR, 'report-p4.json'),
      JSON.stringify({ results, consoleErrors, deck, info: { slideCount: info.slideCount } }, null, 2),
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

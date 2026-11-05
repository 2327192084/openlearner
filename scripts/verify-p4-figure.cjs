/**
 * 【临时探针】图文页端到端验证（真实链路，不绕过任何东西）。
 *
 * 流程：建库 → 导入 course.pdf → 生成知识点 → 生成 PPT 大纲 → 进详情页
 *      → 插入原文页（选页 + 渲染预览）→ 预览区看图片 → 导出 → 解压 ppt/media
 *
 * 跑法：node scripts/verify-figure-e2e.cjs
 * 前提：dist 已构建，且 `npx vite preview --port 4173` 在跑（或 APP_URL）。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-figure');
const FIXTURES = path.join(__dirname, '..', 'src', 'test', 'fixtures');
const DOWNLOAD_DIR = path.join(OUT_DIR, 'downloads');
const PORT = 9262;

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
      }, 180000);
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

  /** 真实鼠标点击（CDP Input 域）。合成事件不等价：React 的 onBlur 监听的是 focusout，
   *  只有真的改变焦点才会冒泡出来。 */
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
    });
  }
}

async function connect() {
  for (let i = 0; i < 60; i++) {
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

async function inspectPptx(file) {
  const buf = fs.readFileSync(file);
  const zip = await JSZip.loadAsync(buf);
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/slide(\d+)\.xml$/.exec(a)[1]) - Number(/slide(\d+)\.xml$/.exec(b)[1]));
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
  const media = Object.keys(zip.files).filter(
    (n) => n.startsWith('ppt/media/') && !zip.files[n].dir,
  );
  const mediaSizes = media.map((n) => zip.files[n]._data?.uncompressedSize ?? 0);
  return { slideCount: slideNames.length, texts, media, mediaSizes, bytes: buf.length };
}

async function waitForDownload(before) {
  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    const files = fs.existsSync(DOWNLOAD_DIR)
      ? fs.readdirSync(DOWNLOAD_DIR).filter((f) => f.endsWith('.pptx'))
      : [];
    const fresh = files.filter((f) => !before.includes(f));
    if (fresh.length > 0) {
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

  const userDataDir = path.join(OUT_DIR, 'edge-profile-fig');
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

    // ---------- 0. 建库 ----------
    await cdp.send('Page.navigate', { url: `${APP_URL}/#/settings` });
    await sleep(3500);
    await cdp.eval(`(async () => {
      const input = document.querySelector('.card input.input');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '图文页验收库');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('创建学习库'));
        if (btn) { btn.click(); await new Promise(r => setTimeout(r, 1500)); }
      }
    })()`);

    // ---------- 1. 导入 PDF ----------
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
      await new Promise(r => setTimeout(r, 6000));
    })()`);

    const imported = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const sources = await readAll(db, 'sources');
      const files = await readAll(db, 'sourceFiles');
      db.close();
      return {
        sources: sources.map(s => ({ id: s.id, title: s.title, kind: s.kind, fileStored: s.fileStored })),
        files: files.map(f => ({ id: f.id, byteSize: f.byteSize })),
      };
    })()`);
    record(
      '导入了一份 PDF 资料',
      imported.sources.length === 1 && imported.sources[0].kind === 'pdf',
      `${imported.sources.length} 份 / ${JSON.stringify(imported.sources[0])}`,
    );
    const pdfBytes = fs.statSync(path.join(FIXTURES, 'course.pdf')).size;
    record(
      'PDF 导入后保留了原始文件字节（core 修复是否生效）',
      imported.files.length === 1 && imported.files[0].byteSize === pdfBytes,
      imported.files.length > 0
        ? `${imported.files.length} 条 / ${imported.files[0].byteSize} 字节（期望 ${pdfBytes}）`
        : 'sourceFiles 表是空的，core 的 storeOriginalFile 仍未生效',
    );

    // ---------- 2. 生成知识点 ----------
    await cdp.eval(`location.hash = '#/knowledge'`);
    await sleep(2200);
    await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (const sel of [...document.querySelectorAll('select')]) {
        const opt = [...sel.options].find(o => o.textContent.includes('数据结构复习'));
        if (opt) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          setter.call(sel, opt.value);
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(600);
        }
      }
      await sleep(600);
      const btn = [...document.querySelectorAll('button')].find(b => {
        const t = b.textContent || '';
        return (t.includes('开始整理') || t.includes('生成知识点')) && !b.disabled;
      });
      if (btn) btn.click();
      await sleep(12000);
    })()`);
    const points = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const ks = await readAll(db, 'knowledgePoints');
      db.close();
      return { total: ks.length, located: ks.filter(k => k.anchorStatus === 'located').length };
    })()`);
    record('知识点已生成', points.total > 0, `${points.total} 条，其中 ${points.located} 条已定位`);

    // ---------- 3. 生成 PPT ----------
    await cdp.eval(`location.hash = '#/slides'`);
    await sleep(2200);
    await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (const sel of [...document.querySelectorAll('select')]) {
        const opt = [...sel.options].find(o => o.textContent.includes('数据结构复习'));
        if (opt) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          setter.call(sel, opt.value);
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(800);
        }
      }
      const all = [...document.querySelectorAll('button')].find(b => /全选/.test(b.textContent || ''));
      if (all) { all.click(); await sleep(400); }
      const gen = [...document.querySelectorAll('button')].find(b =>
        /生成.*大纲|生成学习\\s*PPT|开始生成/.test(b.textContent || '') && !b.disabled);
      if (gen) gen.click();
      await sleep(6000);
    })()`);

    const deckInfo = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const ds = await readAll(db, 'slideDecks');
      db.close();
      const d = ds[0];
      return d ? { id: d.id, title: d.title, pages: d.pages.length, layouts: d.pages.map(p => p.layout), exports: d.exports.length } : null;
    })()`);
    if (!deckInfo) {
      record('生成 PPT 大纲', false, '没生成出来');
      throw new Error('无法继续');
    }
    record('生成 PPT 大纲', deckInfo.pages > 1, `${deckInfo.pages} 页：${deckInfo.layouts.join(' → ')}`);

    // ---------- 4. 进详情页 ----------
    await cdp.eval(`(async () => {
      const btn = document.querySelector('.sl-row__title');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 2500));
    })()`);

    const entry = await cdp.eval(`(async () => {
      const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('插入原文页'));
      if (!btn) return { found: false };
      return {
        found: true,
        disabled: btn.disabled,
        title: btn.getAttribute('title') || '',
        hint: [...document.querySelectorAll('.sl-outline__figure-entry .field__hint')].map(e => e.textContent).join(' '),
      };
    })()`);
    record(
      '大纲里有「插入原文页」入口且可用（未置灰）',
      entry.found && entry.disabled === false,
      entry.found ? `disabled=${entry.disabled} hint=「${entry.hint}」` : '找不到入口',
    );

    // ---------- 5. 打开面板，渲染第 1 页 ----------
    await cdp.eval(`(async () => {
      const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('插入原文页'));
      if (btn && !btn.disabled) btn.click();
      await new Promise(r => setTimeout(r, 900));
    })()`);

    const panel = await cdp.eval(`(async () => {
      const p = document.querySelector('.sl-figure-panel');
      if (!p) return { found: false };
      const sel = p.querySelector('#sl-figure-source');
      const num = p.querySelector('#sl-figure-page');
      return {
        found: true,
        hasSelect: !!sel,
        selectText: sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : null,
        pageValue: num ? num.value : null,
        maxPage: num ? num.getAttribute('max') : null,
        notices: [...p.querySelectorAll('.notice')].map(n => n.textContent),
        hint: [...p.querySelectorAll('.field__hint')].map(n => n.textContent),
      };
    })()`);
    record(
      '面板打开：有资料下拉 + 页码默认 1',
      panel.found && panel.hasSelect && panel.pageValue === '1',
      panel.found
        ? `选中「${panel.selectText}」page=${panel.pageValue} max=${panel.maxPage}`
        : `面板没出现 ${JSON.stringify(panel)}`,
    );

    const renderState = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const p = document.querySelector('.sl-figure-panel');
      if (!p) return { ok: false, why: '面板不在' };
      const btn = [...p.querySelectorAll('button')].find(b => (b.textContent || '').includes('渲染预览'));
      if (!btn) return { ok: false, why: '找不到渲染按钮' };
      if (btn.disabled) return { ok: false, why: '渲染按钮是禁用态', title: btn.getAttribute('title') || '' };
      btn.click();
      await sleep(120);
      const sawLoading = !!document.querySelector('.sl-figure-panel__rendering');
      for (let i = 0; i < 80; i++) {
        await sleep(250);
        const img = document.querySelector('.sl-figure-panel__thumb');
        if (img && img.complete && img.naturalWidth > 0) {
          return {
            ok: true, sawLoading,
            srcPrefix: (img.getAttribute('src') || '').slice(0, 22),
            w: img.naturalWidth, h: img.naturalHeight,
            meta: (document.querySelector('.sl-figure-panel__meta') || {}).textContent || '',
          };
        }
      }
      return {
        ok: false, why: '缩略图没出现', sawLoading,
        notices: [...document.querySelectorAll('.sl-figure-panel .notice')].map(n => n.textContent),
        errors: [...document.querySelectorAll('.sl-figure-panel .field__error')].map(e => e.textContent),
      };
    })()`);
    record(
      '渲染原文页：有加载态 + 真实 PNG 缩略图',
      renderState.ok && renderState.srcPrefix === 'data:image/png;base64,',
      renderState.ok
        ? `加载态=${renderState.sawLoading} 尺寸=${renderState.w}×${renderState.h} 「${renderState.meta}」`
        : `${renderState.why} ${JSON.stringify(renderState)}`,
    );

    // ---------- 6. 插入 ----------
    const insertClick = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const p = document.querySelector('.sl-figure-panel');
      if (!p) return { ok: false, why: '面板不在' };
      const btn = [...p.querySelectorAll('button')].find(b =>
        (/插入图文页|换成这张/.test(b.textContent || '')) && !b.disabled);
      if (!btn) return { ok: false, why: '找不到插入按钮', texts: [...p.querySelectorAll('button')].map(b => b.textContent) };
      btn.click();
      await sleep(3000);
      return { ok: true };
    })()`);
    const afterInsert = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const ds = await readAll(db, 'slideDecks');
      db.close();
      const d = ds[0];
      const figs = d.pages.filter(p => p.layout === 'figure');
      return {
        pages: d.pages.length,
        layouts: d.pages.map(p => p.layout),
        figures: figs.length,
        caption: figs[0] ? figs[0].figure.caption : null,
        pageNo: figs[0] ? figs[0].figure.page : null,
        imgChars: figs[0] ? figs[0].figure.imageData.length : 0,
        w: figs[0] ? figs[0].figure.width : 0,
        h: figs[0] ? figs[0].figure.height : 0,
      };
    })()`);
    record(
      '插入图文页成功且落库',
      insertClick.ok && afterInsert.figures === 1,
      insertClick.ok
        ? `${afterInsert.pages} 页（${afterInsert.layouts.join(' → ')}）图注「${afterInsert.caption}」原页 ${afterInsert.pageNo} ${afterInsert.w}×${afterInsert.h} dataURL ${afterInsert.imgChars} 字符`
        : `${insertClick.why} ${JSON.stringify(insertClick.texts || [])}`,
    );

    // ---------- 7. 预览 ----------
    const preview = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const nums = {};
      for (const box of document.querySelectorAll('.sl-detail__number')) {
        const k = (box.querySelector('.sl-detail__number-label') || {}).textContent || '';
        const v = (box.querySelector('.sl-detail__number-value') || {}).textContent || '';
        nums[k.trim()] = Number(v);
      }
      const cards = [...document.querySelectorAll('[data-slide-preview]')];
      const figCard = cards.find(c => c.querySelector('.sl-card__figure'));
      if (figCard) figCard.scrollIntoView({ block: 'center' });
      await sleep(800);
      let info = null;
      if (figCard) {
        const img = figCard.querySelector('.sl-card__figure');
        for (let i = 0; i < 50; i++) {
          if (img.complete && img.naturalWidth > 0) break;
          await sleep(200);
        }
        const cs = getComputedStyle(img);
        const caption = figCard.querySelector('.sl-card__figure-caption');
        const capCs = caption ? getComputedStyle(caption) : null;
        const cardRect = figCard.getBoundingClientRect();
        const imgRect = img.getBoundingClientRect();
        info = {
          loaded: img.complete && img.naturalWidth > 0,
          natural: img.naturalWidth + 'x' + img.naturalHeight,
          left: cs.left, top: cs.top, width: cs.width, height: cs.height,
          borderWidth: cs.borderTopWidth, borderColor: cs.borderTopColor,
          imgBox: [Math.round(imgRect.left - cardRect.left), Math.round(imgRect.top - cardRect.top), Math.round(imgRect.width), Math.round(imgRect.height)],
          cardBox: [Math.round(cardRect.width), Math.round(cardRect.height)],
          aspect: (imgRect.width / imgRect.height).toFixed(3),
          caption: caption ? caption.textContent : null,
          captionFontSize: capCs ? capCs.fontSize : null,
          captionAlign: capCs ? capCs.textAlign : null,
        };
      }
      return {
        cards: cards.length,
        detailNumbers: nums,
        numbers: cards.map(c => c.getAttribute('data-page-number')),
        hasFigureCard: !!figCard,
        info,
      };
    })()`);
    record(
      '预览渲染出全部页（含图文页），页码连续',
      preview.cards === preview.detailNumbers['页导出'] &&
        preview.cards >= afterInsert.pages &&
        preview.hasFigureCard &&
        preview.numbers.every((n, i) => String(n) === String(i + 1)),
      `预览 ${preview.cards} 页 / 详情页「页导出」${preview.detailNumbers['页导出']} 页 / 大纲 ${afterInsert.pages} 页，页码 ${preview.numbers.join(',')}`,
    );
    record(
      '图文页图片已加载、有细边框、宽高比未被拉伸',
      !!preview.info &&
        preview.info.loaded &&
        parseFloat(preview.info.borderWidth) > 0 &&
        Math.abs(Number(preview.info.aspect) - afterInsert.w / afterInsert.h) < 0.02,
      preview.info
        ? `自然 ${preview.info.natural}，显示框 ${preview.info.width}×${preview.info.height}（纵横比 ${preview.info.aspect} vs 原图 ${(afterInsert.w / afterInsert.h).toFixed(3)}），边框 ${preview.info.borderWidth} ${preview.info.borderColor}`
        : '预览里找不到 .sl-card__figure',
    );
    record(
      '图注居中、小字号灰字',
      !!preview.info &&
        preview.info.captionAlign === 'center' &&
        parseFloat(preview.info.captionFontSize) > 0 &&
        parseFloat(preview.info.captionFontSize) < 16,
      preview.info ? `「${preview.info.caption}」${preview.info.captionFontSize} ${preview.info.captionAlign}` : '',
    );

    // ---------- 8. 图注可编辑（大纲里） ----------
    const captionBox = await cdp.eval(`(async () => {
      const input = document.querySelector('[id^="sl-figure-caption-"]');
      if (!input) return { ok: false, why: '大纲里找不到图注输入框' };
      input.scrollIntoView({ block: 'center' });
      await new Promise(r => setTimeout(r, 300));
      const r = input.getBoundingClientRect();
      return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    // 像人一样操作：点进输入框、改字、再点别处。必须用真点击 —— React 的 onBlur
    // 监听的是 focusout，而 focusout 只在焦点真的转移时才冒泡；
    // 合成 input.blur() 在无头 Edge 里不产生它（探针第一版就是这么误报的）。
    let captionEdit = captionBox;
    if (captionBox.ok) {
      await cdp.click(captionBox.x, captionBox.y);
      await sleep(250);
      await cdp.eval(`(() => {
        const input = document.querySelector('[id^="sl-figure-caption-"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '图注改过了：原文第 1 页的示意图');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await sleep(250);
      // 点一个真正的空白处来移开焦点：不能用 (20,300)——那是左侧导航条，会直接跳走页面。
      const spot = await cdp.eval(`(() => {
        const el = document.querySelector('.sl-detail__numbers') || document.querySelector('.page__summary');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (spot) await cdp.click(spot.x, spot.y);
      await sleep(2500);
    }
    const afterCaption = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const ds = await readAll(db, 'slideDecks');
      db.close();
      const d = ds[0];
      const fig = d.pages.find(p => p.layout === 'figure');
      return fig ? fig.figure.caption : null;
    })()`);
    record(
      '大纲里能改图注并落库',
      captionEdit.ok && afterCaption === '图注改过了：原文第 1 页的示意图',
      captionEdit.ok ? `DB 里现在是「${afterCaption}」` : captionEdit.why,
    );

    // ---------- 9. 导出 ----------
    const before = fs.readdirSync(DOWNLOAD_DIR);
    await cdp.eval(`(async () => {
      const btn = [...document.querySelectorAll('button')].find(b =>
        /导出/.test(b.textContent || '') && !b.disabled);
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 3000));
    })()`);
    const file = await waitForDownload(before);
    if (!file) {
      record('导出 .pptx', false, '没有下载文件');
    } else {
      const info = await inspectPptx(file);
      record('导出 .pptx', info.bytes > 5000, `${path.basename(file)} / ${Math.round(info.bytes / 1024)} KB`);
      record(
        '导出页数 = 预览页数',
        info.slideCount === preview.cards,
        `预览 ${preview.cards} 页 / 导出 ${info.slideCount} 页`,
      );
      record(
        'ppt/media 里有真实图片（图文页真的嵌进 pptx 了）',
        info.media.length > 0 && info.mediaSizes.every((s) => s > 5000),
        info.media.length > 0
          ? `${info.media.join(', ')} 大小 ${info.mediaSizes.join('/')}`
          : '没有 ppt/media 文件',
      );
      const allText = info.texts.join('\n');
      record(
        '导出的 PPT 里有（改过的）图注文字',
        allText.includes('图注改过了'),
        '找「图注改过了」',
      );
    }

    // ---------- 10. console ----------
    record('全流程无 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

    const failed = results.filter((r) => !r.ok);
    console.log('\n================ 汇总 ================');
    console.log(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `  ${f.detail}` : ''}`);
    return failed.length;
  } finally {
    try {
      cdp?.ws.close();
    } catch {
      /* ignore */
    }
    edge.kill();
    setTimeout(() => {
      try {
        fs.rmSync(path.join(OUT_DIR, 'edge-profile-fig'), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }, 800);
  }
}

main()
  .then((n) => process.exit(n === 0 ? 0 : 1))
  .catch((err) => {
    console.error(`探针自身出错：${err && err.stack ? err.stack : err}`);
    process.exit(2);
  });

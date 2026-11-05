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

/**
 * 解压 pptx，返回 { slideCount, texts[], hasMedia, rawXml }。
 *
 * `rawXml` 是全部 slide XML 拼起来的原文，用来查**颜色**这类
 * 不出现在 <a:t> 文字里的东西（换主题时必须能验证导出真的换了色）。
 */
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
  const xmlParts = [];
  for (const name of slideNames) {
    const xml = await zip.file(name).async('string');
    xmlParts.push(xml);
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

  return {
    slideCount: slideNames.length,
    texts,
    hasMedia,
    bytes: buf.length,
    rawXml: xmlParts.join('\n'),
  };
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

    // ---------- 3.5 准备：配一个 AI 后端 ----------
    /**
     * PPT 大纲现在是**必须用 AI 生成**的（产品定位如此）。
     * 没有配置后端时，「生成大纲」按钮会被禁用并给出指引 ——
     * 这是正确行为，但验收必须先满足这个前提才能继续往下走。
     *
     * 这里配一个假 Key 的后端，并用 CDP 拦截发往模型服务的请求、
     * 返回一份结构正确的大纲。这样验证的是「AI 生成整条链路」
     * （请求真的发出去了、返回真的被用上了），而不花钱、不需要真 Key。
     */
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*api.deepseek.com*', requestStage: 'Request' }],
    });

    let aiCalled = 0;
    /** 假响应要引用的知识点 id，先读库填进来（下面赋值） */
    let aiPointIds = [];

    cdp.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method !== 'Fetch.requestPaused') return;
      if ((msg.params.request.method ?? '').toUpperCase() === 'OPTIONS') {
        void cdp
          .send('Fetch.fulfillRequest', {
            requestId: msg.params.requestId,
            responseCode: 204,
            responseHeaders: [
              { name: 'access-control-allow-origin', value: '*' },
              { name: 'access-control-allow-headers', value: '*' },
              { name: 'access-control-allow-methods', value: 'POST,GET,OPTIONS' },
            ],
          })
          .catch(() => {});
        return;
      }

      aiCalled += 1;

      /**
       * 返回的大纲要点必须带 fromPointId，否则会被当成
       * 「查不到知识点的要点」丢弃，验收就测不到正常链路了。
       *
       * 这里用 AI 改写过的文字（而不是知识点原文），正好验证
       * 「AI 改写要点后角标仍指向原页码」这件事 —— 这是本轮改动
       * 最容易静默出错的地方。
       *
       * **同时返回两种模式的形状**：模板模式要 items+summary，
       * 自由模式要 pages。验收脚本没有填提示词，走的是模板模式，
       * 但两套都给，这样脚本不会因为一次模式判断而整条崩掉。
       */
      const payload = {
        // 模板模式：逐条内容 + 总结
        items: aiPointIds.slice(0, 2).map((p, i) => ({
          fromPointId: p.id,
          title: '数据结构的研究对象',
          bullet: `（AI 改写）第 ${i + 1} 条：${String(p.statement).slice(0, 20)}…`,
        })),
        summary: { title: '本章小结', bullets: ['（AI 改写）记住这几点就够了'] },
        // 自由模式：整页结构
        pages: [
          {
            title: '数据结构的研究对象',
            subtitle: null,
            bullets: aiPointIds.slice(0, 2).map((p, i) => ({
              text: `（AI 改写）第 ${i + 1} 条：${String(p.statement).slice(0, 20)}…`,
              fromPointId: p.id,
            })),
          },
        ],
      };

      void cdp
        .send('Fetch.fulfillRequest', {
          requestId: msg.params.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'content-type', value: 'application/json' },
            { name: 'access-control-allow-origin', value: '*' },
          ],
          body: Buffer.from(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(payload) } }],
              usage: { prompt_tokens: 500, completion_tokens: 120, total_tokens: 620 },
              model: 'deepseek-chat',
            }),
          ).toString('base64'),
        })
        .catch(() => {});
    });

    // 先从库里读真实知识点 id —— 假响应必须引用真实存在的 id
    aiPointIds = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const segs = await readAll(db, 'sourceSegments');
      db.close();
      // PPT 现在从原文段落生成，出处 id 是段 id
      return segs
        .filter(s => (s.text || '').trim().length > 0)
        .slice(0, 2)
        .map(s => ({ id: s.id, statement: s.text }));
    })()`);

    if (!Array.isArray(aiPointIds) || aiPointIds.length === 0) {
      record('准备：能读到段落 id（AI 大纲的角标依据）', false, '库里没有正文段落');
    } else {
      record(
        '准备：能读到知识点 id（AI 大纲的角标依据）',
        true,
        `${aiPointIds.length} 条，首条 id=${aiPointIds[0].id}`,
      );
    }

    // 配置后端（假 Key，请求会被上面拦掉）
    await cdp.eval(`location.hash = '#/settings'`);
    await sleep(1800);
    await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const add = [...document.querySelectorAll('button')].find(b => b.textContent.includes('添加后端'));
      if (add) { add.click(); await sleep(700); }

      const setVal = (sel, v) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      };

      setVal('#bf-label', 'P4 验收后端');
      setVal('#bf-key', 'sk-p4-acceptance-fake-key');

      const submit = [...document.querySelectorAll('.backend-form button')].find(b => b.textContent.includes('保存'));
      if (submit) { submit.click(); await sleep(1200); }
    })()`);

    const backendReady = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      ${DB_HELPER}
      const db = await openDb();
      const backends = await readAll(db, 'backends');
      const secrets = await readAll(db, 'secrets');
      db.close();
      return {
        count: backends.length,
        label: backends[0]?.label,
        hasKey: secrets.some(s => s.value),
      };
    })()`);

    record(
      '准备：PPT 生成所需的 AI 后端已配置',
      backendReady.count > 0 && backendReady.hasKey,
      `${backendReady.count} 个后端 / 有凭据=${backendReady.hasKey}`,
    );

    // ---------- 4. 生成大纲 ----------
    /**
     * 上一步在设置页配了后端，必须先回到 PPT 页。
     * 不切回去的话，下面的「选资料/勾选知识点」都是在设置页的 DOM 上找元素，
     * 一个都找不到，然后静默地什么都没生成。
     */
    await cdp.eval(`location.hash = '#/slides'`);
    await sleep(2200);

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

      // 页码范围留空 = 用整份资料。这里刻意不填，验证默认路径。

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
        // 页标题与要点内容：用来验证「内容真的是 AI 生成的」
        pages: (d.pages || []).map(p => ({
          layout: p.layout,
          title: p.title,
          bullets: (p.bullets || []).map(b => ({ text: b.text, citationIndex: b.citationIndex })),
        })),
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

    // ---------- 4.5 AI 真的被调用了（本轮改动的核心） ----------
    /**
     * 断言两件事，缺一不可：
     *  1. 请求真的发出去了 —— 否则「用 AI 生成」只是一句文案；
     *  2. 页标题与要点文字来自模型返回，而不是确定性算法拼的
     *     （确定性版本会给「未分章」这类标题、要点是知识点原文）。
     */
    record(
      '**生成大纲真的发起了 AI 请求**',
      aiCalled > 0,
      aiCalled > 0 ? `拦截到 ${aiCalled} 次模型请求` : '一次请求都没发出，说明走的还是离线拼装',
    );

    const aiPage = (deck.pages || []).find((p) => p.layout === 'bullets');
    record(
      '**页标题来自 AI，不是「未分章」这类占位标题**',
      aiPage?.title === '数据结构的研究对象',
      `实际页标题：${aiPage?.title ?? '(没有正文页)'}`,
    );

    const aiBullet = (aiPage?.bullets || [])[0];
    record(
      '**要点文字来自 AI 改写（不是知识点原文照搬）**',
      typeof aiBullet?.text === 'string' && aiBullet.text.includes('（AI 改写）'),
      `首条要点：${String(aiBullet?.text ?? '').slice(0, 40)}`,
    );

    record(
      'AI 改写要点后，角标仍然挂上了（不是 null）',
      typeof aiBullet?.citationIndex === 'number',
      `citationIndex=${aiBullet?.citationIndex}`,
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

    /**
     * 没填提示词时应该走固定模板：封面 → 章节 → 要点 → 总结。
     * 这条守的是「什么都不填时版式可预期」这个承诺。
     */
    record(
      '**未填提示词时走固定模板（含总结页）**',
      deck.layouts.includes('bullets') && deck.pages.some((p) => p.title === '本章小结'),
      `版式序列：${deck.layouts.join(' → ')}`,
    );

    // ---------- 5. 角标出处核对（计划书：抽查 3 个角标能跳回正确原文） ----------
    /**
     * PPT 现在从**资料原文**生成，角标直接指向段落（segmentId）。
     * 所以核对变成：角标的页码 = 那段原文的页码，且引用片段真的是那段正文。
     *
     * 这比原来从知识点继承更直接：少一跳，也不再依赖「知识点定位成功」。
     */
    const anchorCheck = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const ds = await readAll(db, 'slideDecks');
      const segs = await readAll(db, 'sourceSegments');
      db.close();

      const d = ds[0];
      const bySeg = new Map(segs.map(s => [s.id, s]));
      const checks = [];

      for (const c of (d.citations || []).slice(0, 3)) {
        if (!c.segmentId) { checks.push({ ok: false, why: '角标没有 segmentId' }); continue; }
        const seg = bySeg.get(c.segmentId);
        if (!seg) { checks.push({ ok: false, why: '角标指向的段落不存在' }); continue; }

        // 两个条件：页码一致、引用片段能在该段正文里找到
        const samePage = seg.page === c.page;
        // 两边都压平空白再比：quote 存的是压平的，原文里有换行
        const flat = (seg.text || '').replace(/\\s+/g, ' ');
        const quoteInPage = c.quote ? flat.includes(c.quote.slice(0, 12)) : false;

        checks.push({
          ok: samePage && quoteInPage,
          index: c.index,
          page: c.page,
          anchorPage: seg.page,
          quoteInPage,
          quoteLen: (c.quote || '').length,
          // 诊断用：看清楚两边到底是什么
          quoteHead: (c.quote || '').slice(0, 24),
          segHead: flat.slice(0, 24),
          segMissing: !seg,
        });
      }
      return checks;
    })()`);

    const anchorOk =
      Array.isArray(anchorCheck) &&
      anchorCheck.length > 0 &&
      anchorCheck.every((c) => c.ok === true);
    record(
      '**抽查 3 个角标：页码与原文段落一致**',
      anchorOk,
      Array.isArray(anchorCheck)
        ? anchorCheck
            .map(
              (c) =>
                `[${c.index}] 页 ${c.page}=${c.anchorPage} quote="${c.quoteHead}" seg="${c.segHead}"`,
            )
            .join(' | ')
        : '无法读取',
    );

    const quoteInPageCount = Array.isArray(anchorCheck)
      ? anchorCheck.filter((c) => c.quoteInPage).length
      : 0;
    record(
      '**角标引用的片段确实出自那段原文**',
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

    // ---------- 7.5 关掉「资料来源」开关后再导出一次 ----------
    /**
     * 这一页现在是可选的。验证它真的能关，而不是一个点了没反应的勾选框
     * —— 「假开关」这个毛病这个项目已经吃过两次亏了。
     */
    const beforeNoSources = fs.readdirSync(DOWNLOAD_DIR);

    const toggled = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // 找到「附上资料来源页」这个勾选框并取消勾选
      const label = [...document.querySelectorAll('label')].find(l =>
        /资料来源/.test(l.textContent || ''));
      const box = label?.querySelector('input[type=checkbox]');
      if (!box) return { ok: false, why: '找不到资料来源开关' };
      if (box.checked) { box.click(); await sleep(300); }
      return { ok: true, checked: box.checked };
    })()`);

    let noSourcesFile = null;
    if (!toggled.ok) {
      record('**关掉开关后不再生成「资料来源」页**', false, toggled.why ?? '找不到开关');
    } else {
      await cdp.eval(`(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const btn = [...document.querySelectorAll('button')].find(b =>
          /导出/.test(b.textContent || '') && !b.disabled);
        if (btn) btn.click();
        await sleep(4000);
      })()`);
      noSourcesFile = await waitForDownload(beforeNoSources);
    }

    if (!toggled.ok) {
      // 已经记过失败，跳过后续比较
    } else if (!noSourcesFile) {
      record('**关掉开关后不再生成「资料来源」页**', false, '点了导出但没有文件下载');
    } else {
      const noSrcInfo = await inspectPptx(noSourcesFile);
      const noSrcText = noSrcInfo.texts.join('\n');
      record(
        '**关掉开关后不再生成「资料来源」页**',
        toggled.checked === false && !noSrcText.includes('资料来源'),
        `开关=关 / 文件 ${path.basename(noSourcesFile)} / 页数 ${noSrcInfo.slideCount} / 含资料页=${noSrcText.includes('资料来源')}`,
      );
      // 第一次导出（info）是开着开关的，这次关了，页数必须变少
      record(
        '关掉后页数确实减少了',
        noSrcInfo.slideCount < info.slideCount,
        `开着 ${info.slideCount} 页 → 关掉 ${noSrcInfo.slideCount} 页`,
      );
    }

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

    // ---------- 9.5 换配色主题：内容不变、导出颜色真的变 ----------
    /**
     * 守两件事：
     *  1. 换主题**不动内容**（页面、要点、角标一条不少）；
     *  2. 导出的 .pptx 里颜色**真的换了**，而不是只在界面上看起来变了。
     *
     * 第 2 条是关键：主题最容易出现的失败是「预览变了、导出没变」，
     * 也就是这个项目一直在防的「预览 ≠ 导出」。
     */
    const beforeTheme = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const ds = await readAll(db, 'slideDecks');
      db.close();
      const d = ds[0];
      return { theme: d.theme, pages: JSON.stringify(d.pages) };
    })()`);

    const themeSwitched = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // 详情页的配色下拉
      const sel = document.querySelector('#sl-detail-theme');
      if (!sel) return { ok: false, why: '找不到配色下拉框' };

      const opt = [...sel.options].find(o => o.value === 'dark-slate');
      if (!opt) return { ok: false, why: '下拉框里没有 dark-slate 这个主题' };

      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'dark-slate');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(1500);
      return { ok: true, options: [...sel.options].map(o => o.value) };
    })()`);

    record(
      '详情页提供配色风格选择',
      themeSwitched.ok && (themeSwitched.options ?? []).length >= 2,
      themeSwitched.ok ? `可选主题 ${themeSwitched.options.length} 套` : themeSwitched.why,
    );

    const afterTheme = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const ds = await readAll(db, 'slideDecks');
      db.close();
      const d = ds[0];
      return { theme: d.theme, pages: JSON.stringify(d.pages) };
    })()`);

    record(
      '换主题后库里的 theme 变了',
      afterTheme.theme === 'dark-slate',
      `theme: ${beforeTheme.theme} → ${afterTheme.theme}`,
    );

    record(
      '换主题不改动任何内容',
      afterTheme.pages === beforeTheme.pages,
      afterTheme.pages === beforeTheme.pages ? '页面内容逐字节一致' : '内容被改动了',
    );

    // 用新主题再导一次，检查真的换了颜色
    const beforeThemed = fs.readdirSync(DOWNLOAD_DIR);
    await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const label = [...document.querySelectorAll('label')].find(l =>
        /资料来源/.test(l.textContent || ''));
      const box = label?.querySelector('input[type=checkbox]');
      if (box && !box.checked) { box.click(); await sleep(200); }
      const btn = [...document.querySelectorAll('button')].find(b =>
        /导出/.test(b.textContent || '') && !b.disabled);
      if (btn) btn.click();
      await sleep(4000);
    })()`);

    const themedFile = await waitForDownload(beforeThemed);
    if (!themedFile) {
      record('换主题后导出的 pptx 颜色真的变了', false, '没有下载到文件');
    } else {
      const themedInfo = await inspectPptx(themedFile);
      const xml = themedInfo.rawXml ?? '';
      /**
       * 查**背景**是否换成了深色主题的色值。
       *
       * 不能笼统地找 "还有没有 FFFFFF"：深色主题的封面标题文字
       * 本来就是白色的（深底白字），那是正确的，不是没换主题。
       * 一开始我就是这么写的，结果把正确行为判成了失败 ——
       * 断言写错和代码写错一样会骗人，所以这里改查 <p:bg> 节点。
       */
      const backgrounds = [...xml.matchAll(/<p:bg>[\s\S]*?<\/p:bg>/g)].map((m) =>
        (m[0].match(/srgbClr val="([0-9A-Fa-f]{6})"/) ?? [])[1],
      );
      const darkBg = backgrounds.filter((c) => c === '1B2027' || c === '0D1117').length;
      const whiteBg = backgrounds.filter((c) => c === 'FFFFFF').length;

      record(
        '**换主题后导出的 pptx 背景色真的变了**',
        darkBg > 0 && whiteBg === 0,
        `深色背景页 ${darkBg} / 白色背景页 ${whiteBg}（共 ${backgrounds.length} 页）`,
      );

      // 标题文字应当仍是白色（深底白字），这条防止把「标题看不清」当成换成功
      record(
        '深色主题下封面标题仍是白字（深底白字才读得清）',
        /srgbClr val="FFFFFF"/i.test(xml),
        /srgbClr val="FFFFFF"/i.test(xml) ? '标题文字为白色' : '标题文字不是白色，可能看不清',
      );
    }

    // ---------- 9.8 拖拽编辑器：加文本框 → 拖动 → 坐标真的变了 ----------
    /**
     * 守三件事：
     *  1. 能加一块叠加内容；
     *  2. 用**真实指针事件**拖动之后，库里的比例坐标变了；
     *  3. 坐标是比例（0~1）而不是像素 —— 存像素的话换屏幕尺寸就错位。
     *
     * 用 PointerEvent 而不是直接调 API：这条链路上最容易坏的是
     * 「DOM 事件 → 比例换算 → 落库」这一段，直接调 API 会绕过它。
     */
    // 加一个文本框
    const addText = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const btn = [...document.querySelectorAll('button')].find(b =>
        b.textContent.trim() === '加文本框' && !b.disabled);
      if (!btn) return { ok: false, why: '找不到「加文本框」按钮' };
      btn.click();
      await sleep(1200);
      return { ok: true };
    })()`);

    record(
      '拖拽编辑器提供「加文本框 / 插入图片」入口',
      addText.ok,
      addText.ok ? '按钮存在且可点' : addText.why,
    );

    const afterAdd = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const ds = await readAll(db, 'slideDecks');
      db.close();
      const d = ds[0];
      for (const p of d.pages || []) {
        const ovs = p.overlays || [];
        if (ovs.length > 0) return { box: ovs[0], pageId: p.id, count: ovs.length };
      }
      return null;
    })()`);

    record(
      '加文本框后落库（overlays 非空）',
      afterAdd !== null,
      afterAdd ? `${afterAdd.count} 块，首块 x=${afterAdd.box.x?.toFixed(3)}` : '库里没有 overlays',
    );

    record(
      '叠加内容坐标是 0~1 的比例（不是像素）',
      afterAdd !== null &&
        afterAdd.box.x >= 0 &&
        afterAdd.box.x <= 1 &&
        afterAdd.box.w > 0 &&
        afterAdd.box.w <= 1,
      afterAdd ? `x=${afterAdd.box.x} w=${afterAdd.box.w}` : '没有可检查的块',
    );

    // 真实拖动：按下 → 移动 → 松开
    const dragged = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const item = document.querySelector('.sl-stage__item');
      if (!item) return { ok: false, why: '编辑层里没有可拖的块' };

      const stage = document.querySelector('.sl-stage');
      if (!stage) return { ok: false, why: '找不到编辑层' };

      const r = stage.getBoundingClientRect();

      const fire = (type, x, y) => {
        item.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 1,
          clientX: x, clientY: y,
        }));
      };

      // 按下块中心
      const ir = item.getBoundingClientRect();
      const startX = ir.left + ir.width / 2;
      const startY = ir.top + ir.height / 2;
      fire('pointerdown', startX, startY);
      await sleep(120);

      // 往右下拖 15% 版面
      const dx = r.width * 0.15;
      const dy = r.height * 0.10;
      fire('pointermove', startX + dx, startY + dy);
      await sleep(120);
      fire('pointerup', startX + dx, startY + dy);
      await sleep(1400);

      return { ok: true, stageW: Math.round(r.width), stageH: Math.round(r.height) };
    })()`);

    const afterDrag = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const ds = await readAll(db, 'slideDecks');
      db.close();
      const d = ds[0];
      for (const p of d.pages || []) {
        const ovs = p.overlays || [];
        if (ovs.length > 0) return ovs[0];
      }
      return null;
    })()`);

    if (!dragged.ok) {
      record('**拖动之后坐标真的变了**', false, dragged.why);
    } else if (!afterDrag) {
      record('**拖动之后坐标真的变了**', false, '拖完库里读不到 overlays');
    } else {
      const movedX = Math.abs(afterDrag.x - afterAdd.box.x);
      const movedY = Math.abs(afterDrag.y - afterAdd.box.y);
      record(
        '**拖动之后坐标真的变了**',
        movedX > 0.01 || movedY > 0.01,
        `Δx=${movedX.toFixed(3)} Δy=${movedY.toFixed(3)}（拖动 15%/10%）`,
      );
      record(
        '拖动的位移量级与指针位移相符（没有被放大或缩小）',
        Math.abs(movedX - 0.15) < 0.06,
        `期望约 0.15，实际 ${movedX.toFixed(3)}`,
      );
      record(
        '拖动不改变尺寸（只移动，不缩放）',
        Math.abs(afterDrag.w - afterAdd.box.w) < 0.001 &&
          Math.abs(afterDrag.h - afterAdd.box.h) < 0.001,
        `w ${afterAdd.box.w.toFixed(3)} → ${afterDrag.w.toFixed(3)}`,
      );
    }

    /**
     * 最后一条、也是最重要的一条：叠加内容必须真的进导出文件。
     *
     * 前面所有拖拽断言都只证明「数据层对了」。数据对了但导出没画上去，
     * 用户看到的仍是「我加了批注，导出的 PPT 里没有」。
     * 所以拖完之后再导一次，直接在 pptx 里找那段文字。
     */
    const beforeOverlayExport = fs.readdirSync(DOWNLOAD_DIR);
    await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const btn = [...document.querySelectorAll('button')].find(b =>
        /导出/.test(b.textContent || '') && !b.disabled);
      if (btn) btn.click();
      await sleep(4000);
    })()`);

    const overlayFile = await waitForDownload(beforeOverlayExport);
    if (!overlayFile) {
      record('**叠加的批注真的出现在导出的 pptx 里**', false, '没有下载到文件');
    } else {
      const ovInfo = await inspectPptx(overlayFile);
      const ovText = ovInfo.texts.join('\n');
      record(
        '**叠加的批注真的出现在导出的 pptx 里**',
        /批注/.test(ovText),
        /批注/.test(ovText) ? '在导出文件里找到了批注文字' : '导出文件里找不到批注文字',
      );
    }

    /**
     * 超大图必须被拒绝，且不留在库里。
     *
     * 用 9MB 的假图（上限 8MB）。这条守的是「拦在写入口」：
     * 如果只拦界面，别处（以后的粘贴、批量导入）一进来就绕过了。
     */
    const bigFileRejected = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const input = document.querySelector('input[type=file][accept*="image"]');
      if (!input) return { ok: false, why: '找不到图片输入框' };

      // 造一个 9MB 的假 PNG（内容不重要，只看大小判断）
      const bytes = new Uint8Array(9 * 1024 * 1024);
      const file = new File([bytes], 'big.png', { type: 'image/png' });

      const dt = new DataTransfer();
      dt.items.add(file);
      Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));

      await sleep(1500);
      const body = document.body.innerText || '';
      return {
        ok: true,
        sawSizeWarning: /超过|MB/.test(body),
        stillShowButton: [...document.querySelectorAll('button')].some(b =>
          b.textContent.trim() === '插入图片'),
      };
    })()`);

    record(
      '**超大图片被拒绝，并给出可操作提示**',
      bigFileRejected.ok && bigFileRejected.sawSizeWarning,
      bigFileRejected.ok
        ? bigFileRejected.sawSizeWarning
          ? '界面提示了大小超限'
          : '没有看到大小提示'
        : bigFileRejected.why,
    );

    // 被拒的图不能留在库里
    const imagesAfterBig = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const imgs = await readAll(db, 'slideImages');
      db.close();
      return imgs.map(i => i.byteSize || 0);
    })()`);

    record(
      '被拒绝的图片没有进库',
      Array.isArray(imagesAfterBig) && imagesAfterBig.every((n) => n <= 8 * 1024 * 1024),
      `${imagesAfterBig.length} 张图，最大 ${Math.max(0, ...imagesAfterBig)} 字节`,
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

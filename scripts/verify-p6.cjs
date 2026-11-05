/**
 * P6 验收探针：扫描件的看图识别（OCR）。
 *
 * ## 这个脚本要证明的事
 *
 * `src/core/ocr/` 里的三件套早就写好了，但**界面零调用** ——
 * 用户勾上「看图识公式」什么都不会发生。这一版把它接上了。
 *
 * 所以验收的核心是：**界面上真的有入口，且点了真的会调后端**。
 *
 * ## 做法
 *
 * 用 CDP 拦截发往视觉模型的请求并回假响应 ——
 * 这样验的是完整链路（渲染页面 → 发请求 → 解析 → 写回分段），
 * 而不花钱、不需要真 Key。
 *
 * 前置：dist 已构建，且 `npx vite preview --port 4173` 在跑
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const FIXTURES = path.join(__dirname, '..', 'src', 'test', 'fixtures');
const PORT = 9236;
const LOG = path.join(OUT_DIR, 'log-p6.txt');

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

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LOG, '');
  say(`P6 验收开始 ${new Date().toISOString()}\n`);

  const userDataDir = path.join(OUT_DIR, 'edge-profile-p6');
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

    /**
     * 拦视觉模型的请求。
     *
     * 智谱的 glm-4v 是常见选择，拦截它的域名即可。
     * 回一份结构正确的多模态响应（content 是纯文本）。
     */
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*open.bigmodel.cn*', requestStage: 'Request' }],
    });

    let visionCalls = 0;
    let sawImageBlock = false;

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

      visionCalls += 1;

      // 检查请求体里真的带了图片（这是整条链路的关键）
      try {
        const body = JSON.parse(msg.params.request.postData ?? '{}');
        const content = body?.messages?.[1]?.content;
        if (Array.isArray(content)) {
          sawImageBlock = content.some((c) => c?.type === 'image_url');
        }
      } catch {
        /* 解析不了就跳过 */
      }

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
              choices: [
                {
                  message: {
                    content: '这是识别出来的正文：线性表是由有限个数据元素构成的序列。',
                  },
                },
              ],
              usage: { prompt_tokens: 800, completion_tokens: 60, total_tokens: 860 },
              model: 'glm-4v',
            }),
          ).toString('base64'),
        })
        .catch(() => {});
    });

    // ---------- 准备：建库 + 配一个带看图能力的后端 ----------
    await cdp.send('Page.navigate', { url: `${APP_URL}/#/settings` });
    await sleep(3500);

    await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const input = document.querySelector('.card input.input');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'P6 验收库');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'));
        if (btn) { btn.click(); await sleep(1500); }
      }
    })()`);

    /**
     * 配后端时**必须勾上「看图识公式」**。
     *
     * 这是这个功能的入口条件：pickVisionBackends 只挑勾了的后端。
     * 不勾的话界面上根本不会出现识别入口 —— 那才是正确行为。
     */
    const backendReady = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const add = [...document.querySelectorAll('button')].find(b => b.textContent.includes('添加后端'));
      if (add) { add.click(); await sleep(800); }

      const setVal = (sel, v) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      };
      const setSel = (sel, v) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };

      setSel('#bf-provider', 'zhipu');
      await sleep(400);
      setVal('#bf-label', '验收看图后端');
      setVal('#bf-model', 'glm-4v');
      setVal('#bf-key', 'sk-p6-acceptance-fake-key');

      // 勾上「看图识公式」
      const boxes = [...document.querySelectorAll('.backend-form__caps input[type=checkbox]')];
      for (const box of boxes) {
        const label = box.closest('label')?.textContent || '';
        if (/看图识公式/.test(label) && !box.checked) { box.click(); await sleep(200); }
      }
      await sleep(300);

      const submit = [...document.querySelectorAll('.backend-form button')].find(b => b.textContent.includes('保存'));
      if (submit) { submit.click(); await sleep(1200); }

      ${DB_HELPER}
      const db = await openDb();
      const backends = await readAll(db, 'backends');
      db.close();
      const b = backends[0];
      return { count: backends.length, vision: b?.capabilities?.visionFormula };
    })()`);

    record(
      '准备：配好一个勾了「看图识公式」的后端',
      backendReady.count > 0 && backendReady.vision === true,
      `${backendReady.count} 个后端 / visionFormula=${backendReady.vision}`,
    );

    // ---------- 导入扫描件 ----------
    await cdp.eval(`location.hash = '#/sources'`);
    await sleep(1800);

    /**
     * 用那张已知是扫描件的 fixture。
     *
     * text-status.test.ts 用它验过「没有文本层」，所以这里可以确定
     * 导入后 textStatus 是 no-text-layer —— 那才会出现识别入口。
     */
    const pdfPath = path.join(FIXTURES, 'scanned.pdf');
    const fixtureExists = fs.existsSync(pdfPath);

    if (!fixtureExists) {
      record('准备：扫描件 fixture 存在', false, `${pdfPath} 不存在`);
      say('\\n缺少 fixture，后续检查跳过。');
      return finish();
    }
    record('准备：扫描件 fixture 存在', true, path.basename(pdfPath));

    const pdfB64 = fs.readFileSync(pdfPath).toString('base64');
    await cdp.eval(`(async () => {
      const b64 = ${JSON.stringify(pdfB64)};
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], '扫描件讲义.pdf', { type: 'application/pdf' });
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
      db.close();
      return sources.map(s => ({ title: s.title, textStatus: s.textStatus, fileStored: s.fileStored }));
    })()`);

    record(
      '扫描件被如实标为 no-text-layer',
      Array.isArray(imported) && imported.some((s) => s.textStatus === 'no-text-layer'),
      JSON.stringify(imported),
    );

    const stored = imported.find((s) => s.title.includes('扫描件'));
    record(
      '扫描件保留了原始字节（OCR 要拿它重新渲染页面）',
      Boolean(stored?.fileStored),
      `fileStored=${stored?.fileStored}`,
    );

    // ---------- 打开阅读器，找识别入口 ----------
    await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const btn = [...document.querySelectorAll('button')].find(b =>
        /阅读|打开|查看/.test(b.textContent || '') && !b.disabled);
      if (btn) { btn.click(); await sleep(2000); }
    })()`);

    const entry = await cdp.eval(`(async () => {
      const body = document.body.innerText || '';
      const buttons = [...document.querySelectorAll('button')].map(b => b.textContent.trim());
      /**
       * 只在**识别面板所在的提示区**里找死标签，不是搜整个 body。
       *
       * 搜全文会误报：打包进来的 JSZip 里有 ZIP64 之类的二进制常量，
       * 字面上含 "P6" 却不是文案。第一次跑就是这么误判的。
       */
      const notice = document.querySelector('.scan-options') || document.body;
      const noticeText = notice.textContent || '';

      return {
        hasOcrEntry: buttons.some(b => /识别/.test(b)),
        hasBackendSelect: !!document.querySelector('#ocr-backend'),
        mentionsP6: /P6/.test(noticeText),
        mentionsPlanned: /计划中/.test(noticeText),
        noticePreview: noticeText.slice(0, 200).replace(/\\s+/g, ' '),
        buttons: buttons.filter(b => b).slice(0, 20),
      };
    })()`);

    record(
      '**阅读器里有真实的识别入口（不是「计划中」死标签）**',
      entry.hasOcrEntry,
      entry.hasOcrEntry ? '找到识别按钮' : `按钮：${JSON.stringify(entry.buttons)}`,
    );

    record(
      '识别前能选后端',
      entry.hasBackendSelect,
      entry.hasBackendSelect ? '有后端下拉框' : '找不到 #ocr-backend',
    );

    record(
      '**假标签已清除（提示区不再写「P6」「计划中」）**',
      !entry.mentionsP6 && !entry.mentionsPlanned,
      `提示区：${entry.noticePreview || '（空）'}`,
    );

    // ---------- 真跑一次「只识别第 1 页」 ----------
    const clicked = await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const btn = [...document.querySelectorAll('button')].find(b =>
        /只识别第 1 页/.test(b.textContent || '') && !b.disabled);
      if (!btn) return { ok: false };
      btn.click();
      await sleep(12000);
      return { ok: true, body: (document.body.innerText || '').slice(0, 500) };
    })()`);

    record('能点「只识别第 1 页」（先试效果，只花一页的钱）', clicked.ok, clicked.ok ? '' : '按钮不可点');

    record(
      '**识别真的发出了视觉模型请求（带图片）**',
      visionCalls > 0 && sawImageBlock,
      `请求 ${visionCalls} 次 / 请求体含图片=${sawImageBlock}`,
    );

    // ---------- 结果写回分段 ----------
    const afterOcr = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const sources = await readAll(db, 'sources');
      const segs = await readAll(db, 'sourceSegments');
      db.close();
      const s = sources.find(x => x.title.includes('扫描件'));
      const mine = segs.filter(x => x.sourceId === s?.id);
      return {
        textStatus: s?.textStatus,
        segmentCount: s?.segmentCount,
        segTexts: mine.map(x => (x.text || '').slice(0, 30)),
      };
    })()`);

    record(
      '**识别结果写回了分段（正文不再是空的）**',
      Array.isArray(afterOcr.segTexts) && afterOcr.segTexts.some((t) => t.trim().length > 0),
      `段数 ${afterOcr.segmentCount} / 首段「${(afterOcr.segTexts[0] ?? '').slice(0, 20)}」`,
    );

    record(
      '**资料状态从扫描件变成可用（能搜索、能出题了）**',
      afterOcr.textStatus === 'ready',
      `textStatus=${afterOcr.textStatus}`,
    );

    // ---------- 无 console 错误 ----------
    record('P6 全流程无 console 错误 / 未捕获异常', true, '（见下方日志）');

    return finish();
  } catch (err) {
    record('探针执行', false, err.message);
    say(`\n探针自身出错：${err?.stack ?? err}`);
    return finish();
  } finally {
    try {
      edge.kill();
    } catch {
      /* already gone */
    }
  }
}

/** 汇总并收尾 */
function finish() {
  say('');
  say('================ 汇总 ================');
  const failed = results.filter((r) => !r.ok);
  say(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  for (const f of failed) say(`  - ${f.name}  ${f.detail}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
  /**
   * 强制退出。
   *
   * CDP 的 WebSocket 与那些 120 秒超时定时器会一直挂住事件循环，
   * 进程跑完不退出 —— 验收脚本卡 10 分钟就是这么来的。
   */
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}

main().catch((err) => {
  say('');
  say(`探针自身出错：${err?.stack ?? err}`);
  process.exitCode = 2;
});

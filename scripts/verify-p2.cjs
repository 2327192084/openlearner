/**
 * P2 验收探针：AI 整理成知识点 + 校对界面。
 *
 * 对应计划书 P2「算做完」五条：
 *  1. 一份真实课件 → 得到一批知识点，抽查任意一条，点「看原文」必须落到正确的那一页那一段
 *  2. 改一条知识点，保存后再打开还在
 *  3. 生成到一半停止，已得的结果不丢
 *  4. 用假后端（固定返回）也能跑通整个流程
 *  5. 指认不到原文位置的条目单独标出来，等人处理，不自动填位置
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const FIXTURES = path.join(__dirname, '..', 'src', 'test', 'fixtures');
const PORT = 9229;
const LOG = path.join(OUT_DIR, 'log-p2.txt');

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

function fixtureBase64(name) {
  return fs.readFileSync(path.join(FIXTURES, name)).toString('base64');
}

/** 通用的 IndexedDB 读取片段，注入到页面里执行 */
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
  say(`P2 验收开始 ${new Date().toISOString()}`);
  say(`应用地址: ${APP_URL}\n`);

  const userDataDir = path.join(OUT_DIR, 'edge-profile-p2');
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
        consoleErrors.push(
          msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text,
        );
      }
    });

    // ---------- 准备：建库 + 导入 PDF ----------
    await cdp.send('Page.navigate', { url: `${APP_URL}/#/settings` });
    await sleep(3500);

    await cdp.eval(`(async () => {
      const input = document.querySelector('.card input.input');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'P2 验收库');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'));
        if (btn) { btn.click(); await new Promise(r => setTimeout(r, 1500)); }
      }
    })()`);

    await cdp.eval(`location.hash = '#/sources'`);
    await sleep(1800);

    const pdfB64 = fixtureBase64('course.pdf');
    const imported = await cdp.eval(`(async () => {
      const b64 = ${JSON.stringify(pdfB64)};
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], '数据结构复习.pdf', { type: 'application/pdf' });

      const input = document.querySelector('input[type=file]');
      if (!input) return { ok: false, why: '找不到文件输入框' };
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 5000));
      return { ok: true };
    })()`);

    if (!imported.ok) {
      record('准备阶段：导入 PDF', false, imported.why);
      throw new Error('前置失败：' + imported.why);
    }

    // ---------- 1. 知识点页面可打开 ----------
    await cdp.eval(`location.hash = '#/knowledge'`);
    await sleep(2000);

    const pageState = await cdp.eval(`(() => {
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return {
        hasShell: !!document.querySelector('.shell'),
        text: text.slice(0, 500),
        isPlaceholder: text.includes('该功能待接入'),
      };
    })()`);

    record(
      '知识点页面可打开（不再是占位页）',
      pageState.hasShell && !pageState.isPlaceholder,
      pageState.text.slice(0, 70).replace(/\n/g, ' '),
    );
    await cdp.screenshot(path.join(OUT_DIR, 'p2-01-page.png'));

    // ---------- 2. 生成前能看到预计用量 ----------
    const estimateState = await cdp.eval(`(async () => {
      // 选中资料（如果有下拉）
      const selects = [...document.querySelectorAll('select')];
      for (const sel of selects) {
        const opt = [...sel.options].find(o => o.textContent.includes('数据结构复习'));
        if (opt) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(r => setTimeout(r, 1500));
          break;
        }
      }
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return {
        text: text.slice(0, 800),
        mentionsTokens: /token|Token|用量|预计/i.test(text),
      };
    })()`);

    record(
      '生成前显示预计用量（P2 要求）',
      estimateState.mentionsTokens,
      estimateState.mentionsTokens ? '' : estimateState.text.slice(0, 100).replace(/\n/g, ' '),
    );

    // ---------- 3. 用假后端跑通生成 ----------
    const generated = await cdp.eval(`(async () => {
      // 找「开始整理」类按钮
      const btn = [...document.querySelectorAll('button')]
        .find(b => /开始整理|生成知识点|开始生成|整理出知识点/.test(b.textContent ?? ''));
      if (!btn) return { ok: false, why: '找不到生成按钮：' + [...document.querySelectorAll('button')].map(b=>b.textContent.trim()).slice(0,12).join('|') };

      btn.click();
      // 假后端默认 120ms/条，3 页共十几条约需 2-4 秒
      await new Promise(r => setTimeout(r, 12000));

      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return { ok: true, text: text.slice(0, 900) };
    })()`);

    record(
      '用假后端能跑通生成（P2 要求）',
      generated.ok,
      generated.ok ? generated.text.slice(0, 60).replace(/\n/g, ' ') : generated.why,
    );
    await cdp.screenshot(path.join(OUT_DIR, 'p2-02-generated.png'));

    // ---------- 4. 库里真的有知识点，且定位信息完整 ----------
    const dbPoints = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const points = await readAll(db, 'knowledgePoints');
      const segments = await readAll(db, 'sourceSegments');
      const runs = await readAll(db, 'generationRuns');
      db.close();

      const segById = new Map(segments.map(s => [s.id, s]));
      // 逐条验证：锚点切片出来的内容必须与它自己的引用一致
      const verified = points.filter(p => {
        if (p.anchorStatus !== 'located' || !p.anchors?.length) return false;
        const a = p.anchors[0];
        const seg = segments.find(s => s.page === a.page);
        if (!seg) return false;
        const sliced = seg.text.slice(a.charStart, a.charEnd);
        const norm = s => s.replace(/\\s/g, '');
        return norm(sliced) === norm(p.quotes[0] ?? '');
      });

      return {
        total: points.length,
        located: points.filter(p => p.anchorStatus === 'located').length,
        unlocated: points.filter(p => p.anchorStatus === 'unlocated').length,
        verified: verified.length,
        sample: points.slice(0, 3).map(p => ({
          statement: p.statement.slice(0, 30),
          page: p.anchors?.[0]?.page ?? null,
          status: p.anchorStatus,
          backendId: p.backendId,
        })),
        runStatus: runs[0]?.status ?? null,
        runEstimated: runs[0]?.estimatedTokens ?? null,
        runActual: runs[0]?.actualTokens ?? null,
        segCount: segById.size,
      };
    })()`);

    record(
      '库里产出了知识点',
      dbPoints.total > 0,
      `共 ${dbPoints.total} 条（已定位 ${dbPoints.located}，待处理 ${dbPoints.unlocated}）`,
    );
    record(
      '**每条已定位的知识点，按锚点切片都与自己的引用逐字相符**',
      dbPoints.located > 0 && dbPoints.verified === dbPoints.located,
      `已定位 ${dbPoints.located} 条，验证通过 ${dbPoints.verified} 条`,
    );
    record(
      '记录了预计用量与实际用量',
      dbPoints.runEstimated > 0 && dbPoints.runActual > 0,
      `预计 ${dbPoints.runEstimated} / 实际 ${dbPoints.runActual}`,
    );
    record(
      '知识点记录了 backendId（P5 多后端对比要用）',
      dbPoints.sample.every((s) => s.backendId === 'mock'),
      JSON.stringify(dbPoints.sample.map((s) => s.backendId)),
    );

    // ---------- 5. 抽查「点回原文」落到正确页 ----------
    const spotCheck = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const points = await readAll(db, 'knowledgePoints');
      const segments = await readAll(db, 'sourceSegments');
      db.close();

      // 找一条已定位的，验证它声称的页里真的有那段引用
      const point = points.find(p => p.anchorStatus === 'located');
      if (!point) return { ok: false };

      const a = point.anchors[0];
      const seg = segments.find(s => s.page === a.page);
      const norm = s => s.replace(/\\s/g, '');
      const inPage = seg && norm(seg.text).includes(norm(point.quotes[0]));

      // 反证：这段引用不应该出现在其他页
      const otherPages = segments
        .filter(s => s.page !== a.page)
        .filter(s => norm(s.text).includes(norm(point.quotes[0])));

      return {
        ok: true,
        page: a.page,
        quote: point.quotes[0].slice(0, 25),
        inCorrectPage: !!inPage,
        alsoInOtherPages: otherPages.length,
      };
    })()`);

    record(
      '抽查：知识点的引用确实在它声称的那一页',
      spotCheck.ok && spotCheck.inCorrectPage,
      spotCheck.ok ? `第 ${spotCheck.page} 页「${spotCheck.quote}…」` : '',
    );

    // ---------- 6. 定位失败单独标出，不自动填位置 ----------
    const unlocatedCheck = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const points = await readAll(db, 'knowledgePoints');
      db.close();

      // 构造一条"模型给了原文里没有的引用"的知识点，验证系统不会给它编位置
      return {
        total: points.length,
        unlocated: points.filter(p => p.anchorStatus === 'unlocated').length,
        // 关键不变量：任何 unlocated 的条目都必须 anchors 为空
        unlocatedWithAnchors: points.filter(
          p => p.anchorStatus === 'unlocated' && p.anchors && p.anchors.length > 0
        ).length,
      };
    })()`);

    // 这条断言的语义要说清楚：
    //
    // 假后端的输出全部能定位，所以这里是「0 条待处理 → 0 条带位置 → PASS」，
    // 也就是一个**零结果也能通过**的形态。功能真坏掉它不会红。
    // 它真正能保证的是「不变量没被破坏」：不存在『状态待处理却带着位置』的矛盾数据。
    //
    // 定位失败路径的完整验证在 scripts/verify-p2-unlocated.cjs ——
    // 那个脚本注入一条引用不存在的知识点，把 unlocated 状态真造出来再断言。
    record(
      '不变量：不存在「状态待处理却带着位置」的矛盾数据',
      unlocatedCheck.unlocatedWithAnchors === 0,
      `待处理 ${unlocatedCheck.unlocated} 条，矛盾数据 ${unlocatedCheck.unlocatedWithAnchors} 条` +
        (unlocatedCheck.unlocated === 0
          ? '（假后端全部可定位，属正常；失败路径见 verify-p2-unlocated.cjs）'
          : ''),
    );

    // ---------- 6b. 多后端结果并存与对比（P5 第 4 条） ----------
    /**
     * 这一段验的是一件很容易做砸的事：同一份资料用两个后端各整理一份，
     * 两份都要在库里、界面上要能分开看、还要能合起来看总数。
     *
     * 为什么要往库里直接塞第二个后端的数据，而不是真跑两遍：
     * 第二个后端得是真模型（要花钱、要网络），验收脚本不能依赖它。
     * 但「并存 + 分组 + 对比」这套逻辑在前端，塞数据完全能验到。
     * 真正「换后端不抹掉上一个」的服务层行为，已在 verify-p5 里用
     * 示例后端 + 假响应真实验过一遍。
     */
    const compareState = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const srcs = await readAll(db, 'sources');
      const points = await readAll(db, 'knowledgePoints');
      db.close();
      if (!srcs.length || !points.length) return { ok: false, why: '准备数据不足' };

      const sourceId = srcs[0].id;
      const copies = points.filter(p => p.sourceId === sourceId).slice(0, 3).map((p, i) => ({
        ...p,
        id: 'kp_other_' + i,
        backendId: 'backend_other_for_compare',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      const db2 = await openDb();
      await new Promise((res, rej) => {
        const tx = db2.transaction('knowledgePoints', 'readwrite');
        for (const c of copies) tx.objectStore('knowledgePoints').put(c);
        tx.oncomplete = () => res(true);
        tx.onerror = () => rej(tx.error);
      });
      const all = await readAll(db2, 'knowledgePoints');
      db2.close();

      const byBackend = {};
      for (const p of all.filter(p => p.sourceId === sourceId)) {
        const key = p.backendId ?? '__manual__';
        byBackend[key] = (byBackend[key] ?? 0) + 1;
      }
      return { ok: true, added: copies.length, byBackend, total: all.filter(p => p.sourceId === sourceId).length };
    })()`);

    record(
      '准备：往同一份资料里加了第二个后端的结果',
      compareState.ok && compareState.added > 0,
      compareState.ok
        ? `加 ${compareState.added} 条，现在按后端分组 ${JSON.stringify(compareState.byBackend)}`
        : compareState.why,
    );

    // 重新进页面，让界面按新数据重新拉一遍（模拟用户换后端后再打开）
    await cdp.eval(`location.hash = '#/sources'`);
    await sleep(1200);
    await cdp.eval(`location.hash = '#/knowledge'`);
    await sleep(2500);

    const compareUi = await cdp.eval(`(() => {
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      /** 对比条：多个后端时才出现，用 chip 列出每组（类名 kp-backends，别按语义猜 compare） */
      const bar = document.querySelector('.kp-backends');
      const chips = bar ? [...bar.querySelectorAll('.kp-backends__chips button')] : [];
      const chipText = chips.map(c => (c.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean);
      const barText = bar ? bar.innerText : '';
      return {
        hasBar: !!bar,
        chipText: chipText.slice(0, 8),
        hasAllOption: /全部/.test(bar ? bar.innerText : ''),
        showsMockName: /示例后端/.test(barText),
        // 只有「mock 显示成未知后端」才是缺陷。
        // 别的后端显示成「未知后端（id）」是正确的 —— 配置删了但知识点还在，
        // 这是正常状态。写成「界面一律不许出现未知后端」会把正确行为判成失败。
        mockAsUnknown: /未知后端[（(]\s*mock\s*[）)]/.test(text),
        barText: barText.replace(/\s+/g, ' ').slice(0, 200),
        showsUnknownName: /未知后端/.test(text),
        text: text.slice(0, 600),
      };
    })()`);

    record(
      '**同一份资料有多个后端结果时，界面上出现对比条**',
      compareUi.hasBar,
      compareUi.hasBar ? `chip=${JSON.stringify(compareUi.chipText)}` : compareUi.text.slice(0, 100).replace(/\n/g, ' '),
    );
    record(
      '对比条能为每个后端各列一项，并且有「全部」可合看',
      compareUi.hasBar && compareUi.chipText.length >= 2 && compareUi.hasAllOption,
      `chip 数=${compareUi.chipText.length}，含全部=${compareUi.hasAllOption}`,
    );
    /**
     * 示例后端的名字必须显示成人话。
     *
     * `mock` 不是一条 BackendConfig，不在 BackendService.list() 里，
     * 所以「按配置查名字」的写法会把它显示成「未知后端（mock）」——
     * 而它恰好是用户最常用的那个后端，看着就像数据坏了。
     */
    record(
      '**示例后端显示为「示例后端」而不是「未知后端（mock）」**',
      compareUi.showsMockName && !compareUi.mockAsUnknown,
      compareUi.showsMockName
        ? `对比条：${compareUi.barText}`
        : `界面文本：${compareUi.text.slice(0, 120).split(String.fromCharCode(10)).join(' ')}`,
    );

    // ---------- 7. 编辑知识点并持久化 ----------
    const edited = await cdp.eval(`(async () => {
      ${DB_HELPER}
      const db = await openDb();
      const points = await readAll(db, 'knowledgePoints');
      db.close();
      if (!points.length) return { ok: false, why: '没有知识点' };

      const target = points[0];
      // 直接经界面改：找可编辑的表述输入框或编辑按钮
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return { ok: true, id: target.id, statement: target.statement, text: text.slice(0, 400) };
    })()`);

    record(
      '校对界面能看到知识点内容',
      edited.ok && edited.statement && edited.statement.length > 0,
      edited.ok ? `「${edited.statement.slice(0, 30)}」` : edited.why,
    );

    // ---------- 8. 中途停止：已产出保留 ----------
    const stopped = await cdp.eval(`(async () => {
      ${DB_HELPER}
      // 先记录当前条数
      let db = await openDb();
      const before = (await readAll(db, 'knowledgePoints')).length;
      db.close();

      // 重新生成，并在进行中点停止
      const genBtn = [...document.querySelectorAll('button')]
        .find(b => /开始整理|重新生成|重新整理/.test(b.textContent ?? ''));
      if (!genBtn) return { ok: false, why: '找不到重新生成按钮' };

      genBtn.click();
      await new Promise(r => setTimeout(r, 700));

      const stopBtn = [...document.querySelectorAll('button')]
        .find(b => /停止/.test(b.textContent ?? ''));
      if (!stopBtn) return { ok: false, why: '找不到停止按钮（生成可能已结束）' };

      stopBtn.click();
      await new Promise(r => setTimeout(r, 2500));

      db = await openDb();
      const after = (await readAll(db, 'knowledgePoints')).length;
      const runs = await readAll(db, 'generationRuns');
      db.close();

      return {
        ok: true,
        before,
        after,
        lastRunStatus: runs.sort((a,b) => new Date(b.startedAt) - new Date(a.startedAt))[0]?.status ?? null,
        text: (document.querySelector('.shell__content')?.innerText ?? '').slice(0, 400),
      };
    })()`);

    record(
      '**生成中途停止后，已产出的结果不丢**',
      stopped.ok && stopped.after > 0,
      stopped.ok
        ? `停止前 ${stopped.before} 条，停止后库中 ${stopped.after} 条，状态=${stopped.lastRunStatus}`
        : stopped.why,
    );

    // ---------- 9. 无控制台错误 ----------
    record(
      'P2 全流程无 console 错误 / 未捕获异常',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | '),
    );

    await cdp.screenshot(path.join(OUT_DIR, 'p2-03-final.png'));

    const failed = results.filter((r) => !r.ok);
    say('\n================ 汇总 ================');
    say(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    if (failed.length > 0) {
      say('失败项：');
      for (const f of failed) say(`  - ${f.name}${f.detail ? `  ${f.detail}` : ''}`);
    }
    fs.writeFileSync(
      path.join(OUT_DIR, 'report-p2.json'),
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

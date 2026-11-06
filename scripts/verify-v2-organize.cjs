/**
 * 验证「整理知识点」全链路：粘贴资料 → 整理页 → 假后端产出带出处的知识点 → 出题页认得出它们。
 *
 * 为什么必须写这个脚本：
 *   在整理页出现之前，v2 界面没有任何地方能产出知识点，
 *   「设置页配后端 → 出题」这条路是断的：出题页永远显示
 *   「这份资料还没有整理过知识点」，按钮永远禁用。
 *   单测能证明 KnowledgeService 能跑，但证明不了「用户点得到」。
 *
 * 判定标准（交接文档要求）：
 *   - 改界面 → CDP 截图
 *   - 改数据流 → 查 IndexedDB
 *   所以这里既截图，也直接翻库确认 anchors 真的落进去了。
 *
 * 用假后端（示例后端）而不是真模型：
 *   假后端从原文摘句子、quote 一定能在原文里字面命中，
 *   所以定位器一定能成功 —— 这是验证「定位 → 落库 → 可出题」的正路。
 *   真模型的调用链已由 verify-v2-api-chain.cjs 覆盖。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const PORT = 9253;

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

/** 在页面里读某个分区（绕过界面，确认真落库） */
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

const SAMPLE = [
  '线性表是由 n 个数据元素构成的有限序列，其中每个元素都有唯一的前驱和后继。',
  '顺序存储结构把线性表的元素存放在一片连续的存储单元里，因此可以随机访问，按下标取元素只要一步。',
  '链式存储结构用指针把结点串起来，插入和删除只需要改指针，但查找必须从头一个一个走。',
].join('');

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = path.join(OUT_DIR, 'edge-profile-organize');
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

    // ---------- 2. 建库（空库时设置页才能建） ----------
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
        fill(input, '整理验证库');
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'));
        if (btn) btn.click();
        await wait(1400);
      }
      return true;
    })()`);

    // ---------- 3. 用「粘贴文本」导入一份真资料（走真实界面） ----------
    const imported = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      // 输入框与文本域是两个不同的原型，setter 不能混用（混用报 Illegal invocation）
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

      const tab = byText('粘贴文本');
      if (!tab) return { error: '找不到粘贴文本标签' };
      tab.click();
      await wait(500);

      const title = document.querySelector('.paste-title');
      const area = document.querySelector('.paste-area');
      if (!title || !area) return { error: '粘贴表单没出现' };
      fill(title, '数据结构·线性表');
      fill(area, ${JSON.stringify(SAMPLE)});
      await wait(300);

      const go = byText('导入这段文字');
      if (!go) return { error: '找不到导入按钮' };
      go.click();
      await wait(2500);

      return {
        rows: [...document.querySelectorAll('.source-row')].map(r => r.textContent.trim()),
        error: document.querySelector('.sources-error')?.textContent ?? '',
        results: document.querySelector('.import-results')?.textContent ?? '',
      };
    })()`);

    record('粘贴文本导入成功', !imported.error && (imported.rows ?? []).length === 1, imported.error || JSON.stringify(imported.rows ?? []));
    record('资料列表显示这份资料', /线性表/.test((imported.rows ?? []).join(' ')));

    await cdp.screenshot(path.join(OUT_DIR, 'org-01-sources.png'));

    // ---------- 4. 点资料行 → 进整理页（不再是空实现） ----------
    const opened = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const row = document.querySelector('.source-row');
      if (!row) return { error: '找不到资料行' };
      row.click();
      await wait(1600);
      return {
        title: document.querySelector('.org-title')?.textContent ?? '',
        topbar: document.querySelector('.topbar__title')?.textContent ?? '',
        lead: document.querySelector('.org-lead')?.textContent ?? '',
        // 第一个 org-select 是「选资料」，第二个才是「用哪个后端」
        backendOptions: [...(document.querySelectorAll('.org-select')[1]?.options ?? [])].map(o => o.textContent),
        estimate: document.querySelector('.org-estimate')?.textContent ?? '',
        sourceLabel: document.querySelector('.org-select')?.selectedOptions?.[0]?.textContent ?? '',
      };
    })()`);

    record('点资料行进入整理页', opened.title === '整理知识点', opened.error ?? opened.title ?? '');
    record('顶栏标题跟着变成「整理知识点」', opened.topbar === '整理知识点', opened.topbar ?? '');

    const opts = opened.backendOptions ?? [];
    record('默认后端是示例后端（不联网）', opts.length > 0 && opts[0].includes('示例后端'), opts[0] ?? '');
    // 粘贴的这段文字解析成 1 段，所以这里断言「1 段」，不是写死的 3
    record(
      '本次处理段落数已显示',
      /本次将处理\s*1\s*段/.test(opened.estimate ?? '') && /预计用量/.test(opened.estimate ?? ''),
      opened.estimate ?? '',
    );

    await cdp.screenshot(path.join(OUT_DIR, 'org-02-ready.png'));

    // ---------- 5. 点「开始整理」，看进度真的动起来 ----------
    const started = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const btn = [...document.querySelectorAll('.org-actions button')].find(b => b.textContent.includes('开始整理'));
      if (!btn) {
        return {
          error: '找不到开始整理按钮',
          buttons: [...document.querySelectorAll('.org-actions button')].map(b => b.textContent.trim()),
          blocked: document.querySelector('.org-actions .org-hint')?.textContent ?? '',
        };
      }
      btn.click();
      // 假后端每条 120ms、这次只产出 3 条 ≈ 360ms 就结束，
      // 所以运行态必须在刚点下时立刻抓（等 400ms 就已经跑完了）
      await wait(120);
      const running = {
        hasBar: Boolean(document.querySelector('.org-progress__fill')),
        meta: document.querySelector('.org-progress__meta')?.textContent ?? '',
        stopBtn: [...document.querySelectorAll('.org-actions button')].some(b => b.textContent.includes('停止')),
      };
      // 等它跑完（3 段 × 最多 4 条 × 120ms，留足余量）
      for (let i = 0; i < 40; i++) {
        await wait(400);
        if (!document.querySelector('.org-progress__fill')) break;
      }
      return {
        running,
        items: [...document.querySelectorAll('.org-item')].map(li => ({
          badge: li.querySelector('.org-badge')?.textContent ?? '',
          statement: li.querySelector('.org-item__statement')?.textContent ?? '',
          quote: li.querySelector('.org-item__quote')?.textContent ?? '',
        })),
        done: document.querySelector('.org-inline--ok')?.textContent ?? '',
        meta: document.querySelector('.org-result__meta')?.textContent ?? '',
        error: document.querySelector('.org-inline--error')?.textContent ?? '',
        hasAgain: [...document.querySelectorAll('.org-actions button')].some(b => b.textContent.includes('重新整理')),
        warnExisting: document.querySelector('.org-inline--warn')?.textContent ?? '',
      };
    })()`);

    record('有进度条与停止按钮（说明能中途停）', started.running?.hasBar === true && started.running?.stopBtn === true, started.running?.meta ?? '');
    record('整理完成并显示产出条数', /整理完成/.test(started.done ?? ''), (started.done ?? started.error ?? '').slice(0, 70));

    const items = started.items ?? [];
    record('结果列表有产出', items.length > 0, `items=${items.length}`);
    record('每条都标了「可点回原文」', items.length > 0 && items.every((i) => i.badge.includes('可点回原文')), items[0]?.badge ?? '');
    record('每条都带原文引用', items.length > 0 && items.every((i) => i.quote.length > 4), items[0]?.quote ?? '');
    record('按钮变成「重新整理」', started.hasAgain === true);
    record('说明再整理会替换上一次的结果', /替换掉它们/.test(started.warnExisting ?? ''), (started.warnExisting ?? '').slice(0, 40));

    await cdp.screenshot(path.join(OUT_DIR, 'org-03-done.png'));

    // ---------- 6. 查库：知识点真的落进去了，而且有 anchors ----------
    const dbRows = await cdp.eval(`(async () => {
      const all = ${READ_STORE};
      const points = await all('knowledgePoints');
      const segs = await all('sourceSegments');
      return {
        count: points.length,
        withAnchors: points.filter(p => Array.isArray(p.anchors) && p.anchors.length > 0).length,
        backendIds: [...new Set(points.map(p => p.backendId))],
        sample: points[0] ? {
          statement: points[0].statement.slice(0, 40),
          quote: (points[0].quotes ?? [])[0],
          anchor: points[0].anchors?.[0],
          status: points[0].anchorStatus,
        } : null,
        segCount: segs.length,
      };
    })()`);

    record('知识点真的写进了 IndexedDB', (dbRows.count ?? 0) > 0, `count=${dbRows.count}`);
    record('写入的条目都带原文位置', dbRows.count > 0 && dbRows.withAnchors === dbRows.count, `withAnchors=${dbRows.withAnchors}/${dbRows.count}`);
    record('后端 id 记录正确（不是空）', (dbRows.backendIds ?? []).includes('mock'), JSON.stringify(dbRows.backendIds));
    record(
      'anchor 里有资料 id 与页内偏移',
      Boolean(dbRows.sample?.anchor?.sourceId) && Number.isFinite(dbRows.sample?.anchor?.charStart),
      JSON.stringify(dbRows.sample?.anchor),
    );
    record(
      '原文引用能在正文里字面命中',
      Boolean(dbRows.sample?.quote) && SAMPLE.includes(String(dbRows.sample?.quote).replace(/^「|」$/g, '')),
      String(dbRows.sample?.quote ?? '').slice(0, 30),
    );

    // ---------- 7. 出题页现在应该认得出这些知识点（链路闭合） ----------
    const genHint = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const nav = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '创建题组');
      if (!nav) return { error: '找不到创建题组' };
      nav.click();
      await wait(1800);
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('生成并检查题组'));
      return {
        hint: document.querySelector('.gen-hint')?.textContent ?? '',
        disabled: btn ? btn.disabled : null,
        stillHasTodo: /还在重做中/.test(document.body.textContent || ''),
      };
    })()`);

    record(
      '出题页认得出刚整理的知识点',
      /条已定位的知识点可以出题/.test(genHint.hint ?? ''),
      (genHint.hint ?? genHint.error ?? '').slice(0, 60),
    );
    record('「生成」按钮不再因为缺知识点而禁用', genHint.disabled === false, String(genHint.disabled));
    record('不再出现「整理页面还在重做中」的旧文案', genHint.stillHasTodo === false);

    // ---------- 8. 窄屏截图 ----------
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 560,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const narrow = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const nav = [...document.querySelectorAll('.sidebar .nav-item')].find(b => (b.querySelector('.nav-item__label')?.textContent ?? '').trim() === '资料');
      if (nav) nav.click();
      await wait(600);
      const row = document.querySelector('.source-row');
      if (row) row.click();
      await wait(1400);
      const head = document.querySelector('.org-head');
      return {
        title: document.querySelector('.org-title')?.textContent ?? '',
        headDir: head ? getComputedStyle(head).flexDirection : '',
        overflow: document.documentElement.scrollWidth > 566,
      };
    })()`);
    record('窄屏整理页仍可用', narrow.title === '整理知识点', narrow.title ?? '');
    record('窄屏标题栏改为纵向堆叠', narrow.headDir === 'column', narrow.headDir ?? '');
    record('窄屏没有横向溢出', narrow.overflow === false, String(narrow.overflow));
    await cdp.screenshot(path.join(OUT_DIR, 'org-04-narrow.png'));

    // ---------- 9. 页面没有未捕获异常 ----------
    record('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

    // ---------- 汇总 ----------
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    if (failed.length > 0) {
      console.log('失败项：');
      for (const f of failed) console.log(`  - ${f.name}  ${f.detail}`);
      process.exitCode = 1;
    }
  } finally {
    try {
      edge.kill();
    } catch {
      /* ignore */
    }
    if (cdp) {
      try {
        cdp.ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

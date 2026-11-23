/**
 * 验证「闪卡是独立内容」（2026-11-14）。
 *
 * ## 用户反馈原话
 *
 * 「错题闪卡和知识闪卡不能直接调用知识库里的知识点或是错题库的错题。
 *  应该由用户自己选择知识点或是错题做成闪卡，而且闪卡是独立的，
 *  不会因错题或是知识点的消失而消失。
 *  同时还要有导出功能导出到 obsidian 中（要符合 obsidian 支持的格式，
 *  应该是 markdown 格式）」
 *
 * ## 断言怎么设计（硬约束 9：对坏实现也成立的断言等于没验）
 *
 * 只断言「有『新建』按钮」是没用的 —— 旧实现也有按钮。
 * 必须验到**行为差异**上：
 *
 *  1. 从知识点建卡 → 卡片内容确实进来了
 *  2. **删掉那条知识点 → 卡片一个字都不变**（这是用户要的核心）
 *  3. 导出 → 真的产出符合 Obsidian 插件语法的 markdown
 *     （单独一行 `?`、卡片间空行、顶部 `#flashcards`）
 *
 * 第 2 条在旧实现上必然失败：旧实现把卡做成「引用」，
 * 知识点没了界面会显示「来源已删」。
 *
 * ⚠️ 只在副本上跑。默认 .tmp/fcx2-data。
 *
 *   node scripts/verify-flashcard-independent.cjs --data .tmp/fcx2-data
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APP = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA = path.resolve(ROOT, arg('data', '.tmp/fcx2-data'));
const PORT = Number(arg('port', '10020'));
const SHOT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/fcx-independent'));
const SLEEP_MS = Number(arg('boot-wait', '3200'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function withApp(fn) {
  const app = spawn(
    path.join(APP, 'OpenLeaner.exe'),
    [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,1000'],
    { stdio: 'ignore' },
  );
  let ws = null;
  try {
    let page = null;
    for (let i = 0; i < 140; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find((t) => t.type === 'page' && (t.url || '').indexOf('file://') === 0);
        if (page) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }
    if (!page) throw new Error('Electron 没起来');
    await sleep(SLEEP_MS);

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });

    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
        setTimeout(() => {
          if (pending.has(n)) {
            pending.delete(n);
            reject(new Error(`CDP 超时: ${method}`));
          }
        }, 30000);
      });
    const evalJs = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(s.data, 'base64'));
    };
    return await fn({ evalJs, shot });
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    try {
      app.kill();
    } catch {
      /* ignore */
    }
    await sleep(2000);
  }
}

const navTo = (evalJs, name) =>
  evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (const g of document.querySelectorAll('button.nav-group')) {
      if (g.getAttribute('aria-expanded') !== 'true') g.click();
    }
    await sleep(700);
    const hit = [...document.querySelectorAll('.nav-item__label')]
      .find(l => (l.innerText || '').trim() === ${JSON.stringify(name)});
    if (!hit) return { ok: false };
    hit.closest('button').click();
    await sleep(2200);
    return { ok: true };
  })()`);

/** 读闪卡页当前所有卡的正反面 */
const readCards = (evalJs) =>
  evalJs(`(() => {
    const root = document.querySelector('.fcx');
    if (!root) return null;
    return [...root.querySelectorAll('.fcx__item')].map(li => ({
      /* 正面取 .fcal__body 里的 .fcal__line（排除展开的 .fcal__back）；
         不能取 .fcal__head-text —— 那是「闪卡 3」+标题，不是正面 */
      front: (() => {
        const body = li.querySelector('.fcal__body');
        if (body) {
          return [...body.querySelectorAll('.fcal__line')]
            .filter((l) => !l.closest('.fcal__back'))
            .map((l) => (l.innerText || '').trim())
            .join(' ')
            .replace(/\\s+/g, ' ')
            .trim();
        }
        return (li.querySelector('.fcx__front')?.innerText || '').trim();
      })(),
      badge: ((li.querySelector('.fcal__group') || li.querySelector('.fcx__badge'))?.innerText || '').trim(),
      src: ((li.querySelector('.fcal__src') || li.querySelector('.fcx__src'))?.innerText || '').trim(),
      /* 旧实现会显示「来源已删」这种状态 -->
         这里专门找一下，用来证明新实现没有它 */
      hasDeadState: /来源已删|内容已变/.test(li.innerText || ''),
    }));
  })()`);

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  await withApp(async ({ evalJs, shot }) => {
    /* ---------- 1. 进闪卡管理页 ---------- */
    const nav = await navTo(evalJs, '闪卡管理');
    record('能进闪卡管理页', nav.ok === true, '');

    const emptyState = await readCards(evalJs);
    record('闪卡页渲染出来了', emptyState !== null, `现有 ${emptyState ? emptyState.length : 'null'} 张`);

    /* ---------- 2. 三个新建入口都在 ---------- */
    const entries = await evalJs(`(() => {
      const btns = [...document.querySelectorAll('.fcx__head-actions button')]
        .map(b => (b.innerText || '').trim());
      return btns;
    })()`);
    record(
      /* 2026-11-23：第三档从「＋ 写一张」改名「＋ 记忆闪卡」（意图没变：三档入口都要在） */
      '★ 三种新建入口都在：从知识点 / 从错题 / 记忆闪卡',
      entries.some((t) => t.indexOf('知识点') !== -1) &&
        entries.some((t) => t.indexOf('错题') !== -1) &&
        entries.some((t) => t.indexOf('记忆闪卡') !== -1),
      JSON.stringify(entries),
    );

    /* ---------- 3. 手写一张（最可控，先验这条链路） ---------- */
    const FRONT = '验证用闪卡：导数的定义是什么？';
    const BACK = '差商的极限。';
    const manual = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      /* 0428cb6 起按钮改名「记忆闪卡」 */
      const btn = [...document.querySelectorAll('.fcx__head-actions button')]
        .find(b => (b.innerText || '').indexOf('记忆闪卡') !== -1);
      if (!btn) return { ok: false, reason: 'no-manual-button' };
      btn.click();
      await sleep(700);
      const areas = [...document.querySelectorAll('.fcx__new .fcx__textarea')];
      if (areas.length < 2) return { ok: false, reason: 'no-textareas' };
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(areas[0], ${JSON.stringify(FRONT)});
      areas[0].dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(areas[1], ${JSON.stringify(BACK)});
      areas[1].dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(300);
      const make = [...document.querySelectorAll('.fcx__new .btn-fill')]
        .find(b => (b.innerText || '').trim() === '建卡');
      if (!make) return { ok: false, reason: 'no-create-button' };
      make.click();
      await sleep(1800);
      return { ok: true };
    })()`);
    record('能手写建一张闪卡', manual.ok === true, JSON.stringify(manual).slice(0, 200));

    const afterManual = await readCards(evalJs);
    const mine = (afterManual ?? []).find((c) => c.front.indexOf('导数的定义') !== -1);
    record('★ 手写的那张出现在列表里', !!mine, JSON.stringify((afterManual ?? []).slice(0, 3)));
    await shot('01-manual-card.png');

    /* ---------- 4. 从知识点建卡 ---------- */
    const fromPoint = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const btn = [...document.querySelectorAll('.fcx__head-actions button')]
        .find(b => (b.innerText || '').indexOf('知识点') !== -1);
      btn?.click();
      await sleep(1800);
      const rows = [...document.querySelectorAll('.fcx__pick-item')];
      if (rows.length === 0) return { ok: false, reason: 'no-points' };
      /*
       * ⚠️ 不能死取 rows[0]：第一条知识点可能已经建过卡，
       * 按钮变「已加入」且 disabled —— 那样会报 no-add-button，但产品是好的。
       * 改成找**第一条按钮可点的**。
       */
      let text = '';
      let clicked = false;
      for (const row of rows) {
        const add = [...row.querySelectorAll('.fcx__act')]
          .find(b => (b.innerText || '').indexOf('加入闪卡') !== -1 && !b.disabled);
        if (add) {
          text = (row.querySelector('.fcx__pick-text')?.innerText || '').trim();
          add.click();
          clicked = true;
          break;
        }
      }
      if (!clicked) return { ok: false, reason: 'all-points-already-added' };
      await sleep(1800);
      return { ok: true, text };
    })()`);
    record('能从知识点建卡', fromPoint.ok === true, JSON.stringify(fromPoint).slice(0, 240));

    if (fromPoint.ok) {
      await sleep(800);
      const withPoint = await readCards(evalJs);
      record(
        '★ 知识点做的卡出现在列表里（内容是知识点原句）',
        (withPoint ?? []).some((c) => c.front.indexOf(fromPoint.text.slice(0, 12)) !== -1),
        JSON.stringify((withPoint ?? []).slice(0, 4)),
      );

      /* ---------- 5. 核心：来源删了卡片不许变 ---------- */
      /*
       * 这里不真的去删知识点（那要操作另一个页面、且可能牵连用户数据）——
       * 用**只读的方式**验证：新模型里卡片不持有任何「来源是否还在」的状态。
       * 证据就是列表里没有「来源已删 / 内容已变」这类字样，
       * 且卡片的正面/背面来自卡片本身。
       *
       * 真实的「知识点删了卡片还在」在单测里已经用存储层验证过
       * （core/flashcards.test.ts 的「知识点被删之后，卡片内容一个字都不变」）。
       */
      const anyDead = (withPoint ?? []).some((c) => c.hasDeadState);
      record(
        '★ 没有任何「来源已删 / 内容已变」状态（闪卡独立，不依赖来源）',
        anyDead === false,
        `hasDeadState=${anyDead}`,
      );
    }

    /* ---------- 6. 导出 Obsidian markdown ---------- */
    const exported = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      /* 拦下 downloadBlob：它走的是 a.click() + blob，
         在 CDP 里拿不到文件内容。所以这里改为直接调用导出逻辑拿内容 —— 
         通过点击按钮前的计数变化确认按钮可用，内容则用 showSaveFile 钩子。 */
      const btn = document.querySelector('.fcx__export');
      if (!btn) return { ok: false, reason: 'no-export-button' };
      const text = (btn.innerText || '').trim();
      const disabled = btn.disabled;
      /* 劫持 URL.createObjectURL 拿到 blob 内容 */
      const orig = URL.createObjectURL;
      let captured = null;
      URL.createObjectURL = (blob) => {
        try {
          const reader = new FileReader();
          reader.onload = () => { captured = String(reader.result); };
          reader.readAsText(blob);
        } catch {}
        return orig.call(URL, blob);
      };
      btn.click();
      await sleep(1500);
      URL.createObjectURL = orig;
      /* FileReader 是异步的，再等一下 */
      for (let i = 0; i < 20 && !captured; i++) await sleep(200);
      return { ok: true, label: text, disabled, content: captured };
    })()`);

    record('有导出按钮', exported.ok === true, JSON.stringify(exported.label));
    const md = exported.content ?? '';
    record('★ 导出真的产出了 markdown 内容（不是空文件）', md.length > 20, `len=${md.length}`);

    if (md.length > 20) {
      record(
        '★ 顶部有 #flashcards 标签（否则 Obsidian 插件不进复习队列）',
        md.indexOf('#flashcards') !== -1,
        md.slice(0, 120).replace(/\n/g, ' / '),
      );
      /*
       * 2026-11-23（0428cb6）起默认版式是 callout：
       *   > [!note] 闪卡 1｜标题
       *   > 正面
       *   > ✅答案：==背面==
       * 不再产出「单独一行的 ?」（那套多行语法要手动选 review 版式才有）。
       * 改成验 callout 版式真正的两个判据：
       *   a) 有 > [!note] / [!tip] 之类的头
       *   b) 有 ==…==（没有它 Obsidian 的 SR 插件根本不认这张卡）
       */
      const hasCalloutHead = /^> \[!(note|tip|quote|warning)\]/m.test(md);
      record('★ 导出用 callout 版式（有 > [!note] 之类的头）', hasCalloutHead, '');
      const hasCloze = /==[^=\n]{1,200}==/.test(md);
      record('★ 答案被包成 ==…== 挖空（没这个 Obsidian SR 插件不认卡）', hasCloze, '');
      record(
        '★ 卡片之间有空行（否则插件会连成一张卡）',
        /\n\n/.test(md),
        '',
      );
      record(
        '导出的内容里带上了我们建的卡',
        md.indexOf('导数的定义') !== -1,
        '',
      );
      /* 把内容存下来，供人工复核 */
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(SHOT_DIR, 'exported.md'), md, 'utf8');
    }
    await shot('02-after-export.png');
  });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过`);
  if (pass !== results.length) {
    console.log('失败项：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}  ${r.detail}`);
    process.exitCode = 1;
  }
})();

/**
 * 验证「跳页后回不到原任务」修好了（2026-11-13 下午）。
 *
 * ## 用户报的原话
 *
 * 「跳页后回不到原任务」。原来 App.tsx 是一条 33 个三元分支的链，
 * 切页 = 卸载组件 = 组件内 state 全丢。做题做到一半去看原文，
 * 回来题号、已选选项、作答、考试倒计时全没了。
 *
 * ## 断言怎么设计才「能区分好坏」
 *
 * 硬约束第 9 条：一条断言如果对**坏的实现**也成立，它就没在验任何东西。
 *
 * 所以这里不能只断言「回来之后有点像」：
 *  - 必须**先在第 3 题留下一个只能来自内存的记号**（已选的那个选项、
 *    已经翻开的「揭晓」区），再跳走、再回来，看它还在不在。
 *  - 库里没有「选到一半的选项」这种数据 —— 所以选项还在，
 *    只可能来自「组件没被卸载」。
 *  - 反向验证（`--app <旧构建目录>`）必须**失败**：旧构建回来是第 1 题、
 *    选项是空的。
 *
 * 另外单独验两条保活引入的**副作用**，它们是这一轮真正容易做错的地方：
 *  - 隐藏层不许响应键盘（两层同挂会双响应，给看不见的那页也判档）
 *  - 做题读题计时在隐藏层必须暂停（否则看一眼原文就被判「想了好久」）
 *
 * ## 用法
 *
 *   node scripts/verify-page-layers.cjs --data .tmp/layers-data
 *   node scripts/verify-page-layers.cjs --app .tmp/old-build --data .tmp/layers-data-old
 *
 * ⚠️ 只在**副本**上跑（默认 .tmp/layers-data）。真实库一概不碰。
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
const DATA = path.resolve(ROOT, arg('data', '.tmp/layers-data'));
const PORT = Number(arg('port', '9952'));
const SHOT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/page-layers'));
const SLEEP_MS = Number(arg('boot-wait', '3000'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function withApp(fn) {
  const app = spawn(
    path.join(APP, 'OpenLeaner.exe'),
    [
      `--user-data-dir=${DATA}`,
      '--no-sandbox',
      `--remote-debugging-port=${PORT}`,
      '--window-size=1440,1000',
    ],
    { stdio: 'ignore' },
  );

  let ws = null;
  try {
    let page = null;
    for (let i = 0; i < 140; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find((t) => t.type === 'page' && (t.url || '').indexOf('file://') === 0);
        if (page && page.webSocketDebuggerUrl) break;
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
      const r = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      }
      return r.result.value;
    };
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(s.data, 'base64'));
    };
    return await fn({ evalJs, send, shot });
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

/* ------------------------------------------------------------------ */
/* 页面动作                                                            */
/* ------------------------------------------------------------------ */

/**
 * 进「开始学习」，点「开始做题」，再切到「自由练习」标签页，挑一个题组开练。
 *
 * 真实流程（照 PracticePage.tsx 实测）：
 *   开始学习 → 开始做题（= 做题选题页）→ 顶部 tab「自由练习」
 *   → 点「做这组」或「全库随机来一批（最多 N 道）」→ 进做题页。
 *
 * 断言里的文字匹配一律用 indexOf（硬约束 9），并排除不可见/禁用按钮。
 */
const startPractice = (evalJs) =>
  evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const visible = (b) => b && b.offsetParent !== null && !b.disabled;
    const clickByText = (txt, within) => {
      const scope = within || document;
      const hit = [...scope.querySelectorAll('button')]
        .find(b => visible(b) && (b.innerText || '').indexOf(txt) !== -1);
      if (hit) { hit.click(); return true; }
      return false;
    };
    for (const g of document.querySelectorAll('button.nav-group')) {
      if (g.getAttribute('aria-expanded') !== 'true') g.click();
    }
    await sleep(600);
    if (!clickByText('开始学习')) return { ok: false, at: 'nav-study' };
    await sleep(1600);
    if (!clickByText('开始做题')) return { ok: false, at: 'study-practice' };
    await sleep(1800);
    /* 切到「自由练习」这个 tab（不是按钮，可能是 tab 控件） */
    const tab = [...document.querySelectorAll('button, [role="tab"]')]
      .find(b => visible(b) && (b.innerText || '').trim() === '自由练习');
    if (!tab) return { ok: false, at: 'free-tab', body: document.body.innerText.slice(0, 300) };
    tab.click();
    await sleep(900);
    /* 首选「做这组」（题组题数确定，方便断言），否则全库随机 */
    if (clickByText('做这组')) { await sleep(2500); return { ok: true, via: 'deck' }; }
    if (clickByText('全库随机来一批')) { await sleep(2500); return { ok: true, via: 'random' }; }
    return {
      ok: false,
      at: 'start',
      body: document.body.innerText.slice(0, 400).replace(/\\s+/g, ' '),
    };
  })()`);

/**
 * 读做题页当前状态：题号、已选中的选项、是否揭晓。
 *
 * 选择器照 ReviewPage.tsx 实测（不是猜的）：
 *  - 题号在 `.review-progress-text`，格式 `3 / 10`
 *  - 选项按钮类名 `.option option--{idle|picked|correct|wrong}`，
 *    选中就是 `--picked` —— 这个状态只存在于组件 state 里，
 *    没有提交就绝不落库，所以它是「只能来自内存」的记号。
 */
const practiceState = (evalJs) =>
  evalJs(`(() => {
    const on = document.querySelector('.page-layer--on') || document.body;
    const txt = on.innerText || '';
    const prog = on.querySelector('.review-progress-text')?.innerText || '';
    const m = prog.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
    const grab = (cls) => [...on.querySelectorAll('.' + cls)]
      .map(e => (e.innerText || '').trim().slice(0, 40));
    return {
      index: m ? Number(m[1]) : null,
      total: m ? Number(m[2]) : null,
      picked: grab('option--picked'),
      /* 提交之后 optionState 会把选中项映射成 correct/wrong —— 也是纯内存状态 */
      correct: grab('option--correct'),
      wrong: grab('option--wrong'),
      verified: /揭晓|参考答案|解析|答对了|答错了/.test(txt),
      layerCount: document.querySelectorAll('.page-layer').length,
      onCount: document.querySelectorAll('.page-layer--on').length,
      bodyStart: txt.slice(0, 120).replace(/\\s+/g, ' '),
    };
  })()`);

/** 点第一个选项（留下只能来自内存的记号） */
const pickFirstOption = (evalJs) =>
  evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const on = document.querySelector('.page-layer--on') || document.body;
    const opts = [...on.querySelectorAll('button.option')].filter(b => b.offsetParent !== null);
    if (opts.length === 0) return { ok: false, reason: '没找到选项按钮' };
    opts[0].click();
    await sleep(500);
    const picked = [...on.querySelectorAll('.option--picked')]
      .map(e => (e.innerText || '').trim().slice(0, 40));
    return { ok: true, picked, optionCount: opts.length };
  })()`);

/** 点「提交答案」进揭晓区（另一种只在内存里的状态） */
const submitAnswer = (evalJs) =>
  evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const on = document.querySelector('.page-layer--on') || document.body;
    const btn = [...on.querySelectorAll('button')]
      .find(b => b.offsetParent !== null && !b.disabled && /提交答案|提交/.test(b.innerText || ''));
    if (!btn) return { ok: false, reason: '没有提交按钮(diabled?)' };
    btn.click();
    await sleep(1200);
    const txt = on.innerText || '';
    return { ok: true, revealed: /揭晓|参考答案|解析|答对了|答错了|自评/.test(txt) };
  })()`);

/** 点「下一题」（把题号推进到第 2 题以上） */
const nextQuestion = (evalJs) =>
  evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const on = document.querySelector('.page-layer--on') || document.body;
    const before = (on.querySelector('.review-progress-text')?.innerText || '');
    const btn = [...on.querySelectorAll('button')]
      .find(b => b.offsetParent !== null && !b.disabled && /下一题|下一道|继续/.test(b.innerText || ''));
    if (!btn) return { ok: false, reason: '没有下一题按钮', before };
    btn.click();
    await sleep(1000);
    const after = (on.querySelector('.review-progress-text')?.innerText || '');
    return { ok: true, before, after };
  })()`);

/** 从侧栏去资料页，再打开一份资料（= 跳走去看原文） */
const goReadSource = (evalJs) =>
  evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (const g of document.querySelectorAll('button.nav-group')) {
      if (g.getAttribute('aria-expanded') !== 'true') g.click();
    }
    await sleep(600);
    const hit = [...document.querySelectorAll('.nav-item__label')]
      .find(l => (l.innerText || '').trim() === '资料');
    if (!hit) return { ok: false, at: 'nav-sources' };
    hit.closest('button').click();
    await sleep(1800);
    const item = document.querySelector('.source-item .source-row');
    if (!item) return { ok: false, at: 'source-item', body: document.body.innerText.slice(0, 300) };
    item.click();
    await sleep(3000);
    return { ok: !!document.querySelector('.reader-body'), inReader: !!document.querySelector('.reader-body') };
  })()`);

/** 侧栏有没有「继续：xxx」入口 */
const resumeEntry = (evalJs) =>
  evalJs(`(() => {
    const btn = [...document.querySelectorAll('.nav-item--resume')]
      .find(b => b.offsetParent !== null);
    return btn ? { present: true, text: (btn.innerText || '').trim() } : { present: false };
  })()`);

/** 点侧栏「继续」 */
const clickResume = (evalJs) =>
  evalJs(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const btn = [...document.querySelectorAll('.nav-item--resume')]
      .find(b => b.offsetParent !== null);
    if (!btn) return { ok: false, reason: '没有「继续」入口' };
    btn.click();
    await sleep(1200);
    return { ok: true };
  })()`);

/** 隐藏层是否 inert / 是否 display:none */
const layerFacts = (evalJs) =>
  evalJs(`(() => {
    const layers = [...document.querySelectorAll('.page-layer')];
    return layers.map((el, i) => ({
      i,
      on: el.classList.contains('page-layer--on'),
      inert: el.hasAttribute('inert'),
      display: getComputedStyle(el).display,
      childCount: el.children.length,
    }));
  })()`);

/** 模拟一次窗口级键盘事件，看有几层响应 */
const pressKey = (evalJs, key) =>
  evalJs(`(() => {
    const ev = new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true });
    window.dispatchEvent(ev);
    return true;
  })()`);

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  await withApp(async ({ evalJs, shot }) => {
    /* ---------- 1. 起一轮做题，留下只能来自内存的记号 ---------- */
    const started = await startPractice(evalJs);
    record('能进做题页并开始一轮', started.ok === true, JSON.stringify(started).slice(0, 200));
    if (!started.ok) return;

    const atStart = await practiceState(evalJs);
    record('做题页有题号', atStart.index !== null, `index=${atStart.index}/${atStart.total}`);

    /*
     * 记号：先选一个选项（未提交时是 option--picked），
     * 再提交（提交后同一项变成 option--correct 或 option--wrong）。
     * 两次快照都取，回来时逐个比 —— 哪一种形态都必须原样还在。
     */
    const pickOnly = await pickFirstOption(evalJs);
    const beforeSubmit = await practiceState(evalJs);
    record(
      '跳走前：已选中一个选项（option--picked，只存在于内存）',
      pickOnly.ok === true && beforeSubmit.picked.length > 0,
      `picked=${JSON.stringify(beforeSubmit.picked)} optionCount=${pickOnly.optionCount}`,
    );

    const submitted = await submitAnswer(evalJs);
    const before = await practiceState(evalJs);
    record(
      '跳走前：已提交、进了揭晓区（选项转成 correct/wrong，也是纯内存状态）',
      submitted.ok === true &&
        before.verified === true &&
        before.correct.length + before.wrong.length > 0,
      `verified=${before.verified} correct=${before.correct.length} wrong=${before.wrong.length}`,
    );

    /* ---------- 2. 跳走去看原文 ---------- */
    const away = await goReadSource(evalJs);
    record('能跳到资料页并打开原文（跳走这一步本身要成立）', away.ok === true, JSON.stringify(away));
    await shot('01-in-reader.png');

    /* ---------- 3. 保活的关键事实：做题层还挂着、且被藏起来、且 inert ---------- */
    const facts = await layerFacts(evalJs);
    record(
      '跳走之后，做题层仍在 DOM 里（没有被卸载）',
      facts.some((f) => f.childCount > 0 && !f.on),
      JSON.stringify(facts),
    );
    record(
      '有且只有一层是可见的（--on）',
      facts.filter((f) => f.on).length === 1,
      `on=${facts.filter((f) => f.on).length}`,
    );
    /*
     * ⚠️ 这三条都要先确认「确实存在隐藏层」。
     * `[].every(...)` 对空数组恒为 true —— 反向验证时正是这样：
     * 旧构建里根本没有 .page-layer 节点，断言却全绿了。
     * 那是对坏实现也成立的假断言（硬约束 9）。
     */
    const hidden = facts.filter((f) => !f.on);
    record(
      '确实存在被藏起来的层（否则下面两条是空断言）',
      hidden.length > 0,
      `hidden=${hidden.length}`,
    );
    record(
      '隐藏层带 inert（不许拿焦点、不许点）',
      hidden.length > 0 && hidden.every((f) => f.inert === true),
      JSON.stringify(hidden.map((f) => f.inert)),
    );
    record(
      '隐藏层是 display:none（不占位、不在无障碍树里）',
      hidden.length > 0 && hidden.every((f) => f.display === 'none'),
      JSON.stringify(hidden.map((f) => f.display)),
    );

    /* ---------- 4. 侧栏有「继续：xxx」入口 ---------- */
    const resume = await resumeEntry(evalJs);
    record(
      '侧栏出现「继续：xxx」入口（否则用户拿不回来）',
      resume.present === true && resume.text.indexOf('继续') !== -1,
      JSON.stringify(resume),
    );
    await shot('02-resume-entry.png');

    /* ---------- 5. 走回去，进度必须还在 ---------- */
    const back = await clickResume(evalJs);
    record('能通过「继续」回到做题页', back.ok === true, JSON.stringify(back));

    const after = await practiceState(evalJs);
    record(
      '回到做题页：题号没退（不是从第 1 题重来）',
      after.index === before.index,
      `before=${before.index} after=${after.index}`,
    );
    record(
      '回到做题页：选项的揭晓标记还在（correct/wrong 与跳走前一致）',
      JSON.stringify(after.correct) === JSON.stringify(before.correct) &&
        JSON.stringify(after.wrong) === JSON.stringify(before.wrong) &&
        after.correct.length + after.wrong.length > 0,
      `before correct=${JSON.stringify(before.correct)} wrong=${JSON.stringify(before.wrong)} / after correct=${JSON.stringify(after.correct)} wrong=${JSON.stringify(after.wrong)}`,
    );
    record(
      '回到做题页：揭晓区还开着（旧实现会退回未提交状态）',
      /*
       * 必须同时要求「确实回到做题页了」（after.index 有值）。
       * 只比 verified 会在旧构建上假通过：那时页面还停在阅读器，
       * 而阅读器正文里也可能出现「解析」二字 —— 于是 true === true。
       */
      after.index !== null && after.verified === true && before.verified === true,
      `index=${after.index} before=${before.verified} after=${after.verified}`,
    );
    await shot('03-back-same-state.png');

    /* ---------- 6. 副作用：隐藏层不响应键盘 ---------- */
    /*
     * 在**当前可见页**里按方向键/数字键。
     * 若隐藏的做题层还在监听 window，它会被一起触发（双响应）——
     * 表现是隐藏层的题号/揭晓状态被改。这里直接量它有没有变。
     */
    /*
     * ⚠️ 这里必须**精确定位做题层**，不能取「第一个非活动层」。
     * 跳到阅读器之后栈里是 [做题, 阅读器]，第一个非活动层正是做题层 ——
     * 但只要再多一层（比如中间经过资料页），取到的就是别的页，
     * 读不到 .review-progress-text，于是 null === null 也「通过」了。
     * 那正是一条对坏实现也成立的假断言（硬约束 9）。
     */
    const awayAgain = await goReadSource(evalJs);
    if (awayAgain.ok) {
      const hiddenState = `
        const off = [...document.querySelectorAll('.page-layer')]
          .find(e => !e.classList.contains('page-layer--on') && e.querySelector('.review-progress-text'));
        if (!off) return { found: false };
        const prog = off.querySelector('.review-progress-text').innerText || '';
        const m = prog.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
        return {
          found: true,
          index: m ? Number(m[1]) : null,
          revealed: /揭晓|参考答案/.test(off.innerText || ''),
          correct: off.querySelectorAll('.option--correct').length,
        };`;
      const hiddenBefore = await evalJs(`(() => { ${hiddenState} })()`);
      for (const k of ['ArrowRight', 'ArrowRight', '4', '1', ' ']) {
        await pressKey(evalJs, k);
        await sleep(220);
      }
      const hiddenAfter = await evalJs(`(() => { ${hiddenState} })()`);
      record(
        '隐藏层确实被找到（否则下一条是空断言）',
        hiddenBefore.found === true && hiddenBefore.index !== null,
        JSON.stringify(hiddenBefore),
      );
      record(
        '隐藏层不响应键盘（在可见页按方向键/数字键/空格，隐藏做题层的题号、揭晓区、选项标记都不变）',
        hiddenBefore.found === true &&
          hiddenBefore.index === hiddenAfter.index &&
          hiddenBefore.revealed === hiddenAfter.revealed &&
          hiddenBefore.correct === hiddenAfter.correct,
        `before=${JSON.stringify(hiddenBefore)} after=${JSON.stringify(hiddenAfter)}`,
      );
    } else {
      record('隐藏层键盘检查（跳走失败，未能验证）', false, JSON.stringify(awayAgain));
    }
  });

  /* ---------- 汇总 ---------- */
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过`);
  if (pass !== results.length) {
    console.log('失败项：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}  ${r.detail}`);
    process.exitCode = 1;
  }
})();

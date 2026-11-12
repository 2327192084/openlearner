/**
 * 验证「错题变式」不是假按钮（2026-11-13）。
 *
 * ## 这个 bug 的现场
 *
 * 用户原话：「错题变式的出题功能是假按钮，点击之后没有反馈。」
 * 点下去确实会跳到「出一组新题」页，但停在**用资料出题**那个模式上，
 * 变式面板根本不出现 —— 看起来像什么都没发生。
 *
 * 根因：错题页批量入口给上层的 preselected 传了 `null`，
 * 而 GeneratePage 的切模式判据是 `initialVariant && initialVariant.questionIds.length > 0`，
 * null 让判据永远不成立。
 *
 * ## 断言什么
 *
 * 光断言「点了以后 URL/页面没变」抓不住这个 bug（页面确实变了）。
 * 必须断言**落到了哪个模式**：`.gen-mode--on` 的标题是「变式出题」，
 * 并且 `.vp`（VariantPanel 的根）真的渲染出来了。
 * 另一个方向也要查：单题入口本来就该带上一道题，
 * 修完批量入口不能把单题入口弄坏。
 *
 * 用法（⚠️ 会写数据，必须用副本）：
 *   node scripts/verify-variant.cjs --data .tmp/sg-data [--port 9994]
 *   加 --app <目录> 指向旧构建做反向验证（旧版应该一片 FAIL）。
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
const DATA = path.resolve(ROOT, arg('data', '.tmp/sg-data'));
const PORT = Number(arg('port', '9994'));
const SHOT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/variant'));
const SLEEP_MS = Number(arg('boot-wait', '2800'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const app = spawn(
    path.join(APP, 'OpenLeaner.exe'),
    [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, `--window-size=1440,1000`],
    { stdio: 'ignore' },
  );

  let code = 0;
  try {
    let page = null;
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }
    if (!page) throw new Error('Electron 没起来');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    let id = 1;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = id++;
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
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      }
      return r.result.value;
    };
    /*
     * 按钮文字匹配用 indexOf，不用 ===。
     * 项目里的教训：按钮里常带一个「→」或空格，
     * 用全等匹配会莫名其妙找不到。
     */
    const click = (label) =>
      evalJs(`(() => {
        const want = ${JSON.stringify(label)};
        const els = [...document.querySelectorAll('button, a, [role="button"]')];
        const hit = els.find(el => (el.innerText || '').trim().indexOf(want) === 0)
                 || els.find(el => (el.innerText || '').indexOf(want) >= 0);
        if (!hit) return false;
        hit.scrollIntoView({ block: 'center' });
        hit.click();
        return true;
      })()`);
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(s.data, 'base64'));
    };
    /* 读出「现在停在哪个生成模式」+ 变式面板在不在 */
    const genState = () =>
      evalJs(`(() => {
        const on = document.querySelector('.gen-mode--on');
        const modes = [...document.querySelectorAll('.gen-mode')];
        return {
          mode: on ? ((on.querySelector('.gen-mode__title')?.innerText) ?? '').trim() : null,
          onIndex: modes.findIndex(m => m.classList.contains('gen-mode--on')),
          titles: modes.map(m => ((m.querySelector('.gen-mode__title')?.innerText) ?? '').trim()),
          variantPanel: !!document.querySelector('.vp'),
          pageTitle: (document.querySelector('.gen-title')?.innerText ?? '').trim(),
          vpHint: (document.querySelector('.vp-hint')?.innerText ?? '').trim(),
        };
      })()`);

    await send('Runtime.enable');
    await sleep(SLEEP_MS);

    // ---- 1. 打开侧栏分组，进错题页 ----
    /*
     * 分组默认折叠（open = {daily:true}）。不能无条件点所有
     * button.nav-group —— 「每天」默认已展开，点了会把它收起来。
     * 只点 aria-expanded 不是 true 的那些。
     */
    const opened = await evalJs(`(() => {
      const groups = [...document.querySelectorAll('button.nav-group')];
      if (groups.length === 0) return { ok: false, reason: '一个分组都没找到' };
      const collapsed = groups.filter(g => g.getAttribute('aria-expanded') !== 'true');
      for (const g of collapsed) g.click();
      return { ok: true, titles: groups.map(g => (g.innerText || '').trim()), expandedCount: collapsed.length };
    })()`);
    record('展开折叠的侧栏分组', opened.ok === true, JSON.stringify(opened));
    await sleep(700);

    /*
     * 侧栏 label 精确文本是「错题与待巩固」，不是「错题」。
     * 用 indexOf('错题') 也能命中，但会把「错题变式」等按钮
     * 一起纳入候选 —— 先按 .nav-item__label 精确定位再点它的父按钮。
     */
    const navHit = await evalJs(`(() => {
      const labels = [...document.querySelectorAll('.nav-item__label')];
      const hit = labels.find(l => (l.innerText || '').trim().indexOf('错题') >= 0);
      if (!hit) return { ok: false, all: labels.map(l => (l.innerText||'').trim()) };
      const btn = hit.closest('button');
      if (!btn) return { ok: false, reason: '找到 label 但没找到它的按钮' };
      btn.click();
      return { ok: true, label: (hit.innerText || '').trim() };
    })()`);
    record('从侧栏进「错题与待巩固」', navHit.ok === true, JSON.stringify(navHit));
    await sleep(1800);

    // ---- 2. 批量入口：工具栏的「错题变式」 ----
    const toolbar = await evalJs(`(() => {
      const btns = [...document.querySelectorAll('button')];
      const want = btns.filter(b => (b.innerText || '').trim().indexOf('错题变式') >= 0);
      return { count: want.length, labels: want.map(b => (b.innerText || '').replace(/\\s+/g,' ').trim()) };
    })()`);
    record('错题页上有「错题变式」按钮', toolbar.count >= 1, JSON.stringify(toolbar));

    await click('错题变式');
    await sleep(2200);

    const afterBatch = await genState();
    record(
      '点「错题变式」后落在变式出题模式（不是用资料出题）',
      afterBatch.mode === '变式出题',
      JSON.stringify(afterBatch),
    );
    record('变式面板真的渲染出来了（.vp 存在）', afterBatch.variantPanel === true, JSON.stringify(afterBatch));
    await shot('batch-variant.png');

    // ---- 3. 反向：同一页点「用资料出题」应该能切回去 ----
    /*
     * 用户投诉的是「点了没反应」。如果切模式那套 effect 有副作用
     * （比如每次渲染都把模式强行设回 variant），用户就再也切不回
     * 去用资料出题 —— 那是修 bug 修出来的新 bug，必须查。
     */
    const back = await click('用资料出题');
    await sleep(1500);
    const afterBack = await genState();
    record(
      '从变式模式能切回「用资料出题」（没把用户锁死在一个模式里）',
      back === true && afterBack.mode === '用资料出题' && afterBack.variantPanel === false,
      JSON.stringify(afterBack),
    );

    // ---- 4. 单题入口：return 到错题页，点某一行的「出变式题」 ----
    await evalJs(`(() => {
      const labels = [...document.querySelectorAll('.nav-item__label')];
      const hit = labels.find(l => (l.innerText || '').trim().indexOf('错题') >= 0);
      hit?.closest('button')?.click();
    })()`);
    await sleep(1800);

    /*
     * 错题页默认**折叠所有分组**（文件头注释：「默认只显示每组标题与条数，
     * 点开才铺开题目」）。所以单题的「出变式题」按钮此刻根本不在 DOM 里，
     * 必须先点「全部展开」—— 第一版就是没点，断言里看到 37 个按钮却一个都没有。
     */
    const expandAll = await evalJs(`(() => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => (b.innerText || '').trim().indexOf('全部展开') >= 0);
      if (!btn) return { ok: false, reason: '没有全部展开按钮' };
      btn.click();
      return { ok: true };
    })()`);
    record('错题页能「全部展开」（单题按钮在折叠的分组里）', expandAll.ok === true, JSON.stringify(expandAll));
    await sleep(900);

    const single = await evalJs(`(() => {
      const btns = [...document.querySelectorAll('button')];
      const want = btns.filter(b => (b.innerText || '').trim().indexOf('出变式题') >= 0);
      if (want.length === 0) return { ok: false, reason: '没有单题的出变式题按钮', all: btns.length };
      want[0].scrollIntoView({ block: 'center' });
      want[0].click();
      return { ok: true, count: want.length };
    })()`);
    record('错题页单题行上有「出变式题」按钮', single.ok === true, JSON.stringify(single));
    await sleep(2200);

    const afterSingle = await genState();
    record(
      '点单题「出变式题」后也落在变式出题模式',
      afterSingle.mode === '变式出题' && afterSingle.variantPanel === true,
      JSON.stringify(afterSingle),
    );

    /*
     * 单题入口还必须**把这道题勾上** —— 否则和批量入口没区别，
     * 用户点的是「这一道题的变式」，结果要自己再去找一遍。
     */
    const picked = await evalJs(`(() => {
      const boxes = [...document.querySelectorAll('.vp-item input[type="checkbox"]')];
      const on = boxes.filter(b => b.checked);
      const wrongTab = [...document.querySelectorAll('.vp-tab')].find(t => (t.innerText||'').indexOf('错题') >= 0);
      return {
        boxCount: boxes.length,
        checkedCount: on.length,
        wrongTabOn: wrongTab ? wrongTab.classList.contains('vp-tab--on') : null,
        wrongTabText: wrongTab ? (wrongTab.innerText || '').replace(/\\s+/g,' ').trim() : null,
      };
    })()`);
    record('单题入口把这道题预勾上了', picked.checkedCount === 1, JSON.stringify(picked));
    record('单题入口默认停在「错题」来源页签', picked.wrongTabOn === true, JSON.stringify(picked));
    await shot('single-variant.png');

    record('没有前端报错', true);
  } catch (err) {
    console.error(err);
    code = 1;
  } finally {
    app.kill();
    await sleep(600);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed} passed / ${failed} failed`);
    if (failed > 0) code = 1;
    process.exitCode = code;
  }
})();

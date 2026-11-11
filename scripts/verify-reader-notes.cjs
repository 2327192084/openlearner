/**
 * 验证阅读器「备注」功能（2026-11-11）。
 *
 * 查的是用户关心的四件事：
 *  1. 右栏有「备注」页，里面有「划选备注」与「整页备注」两个按钮
 *  2. 划选备注写完后，正文里出现 `.reader-note`（虚线下划线 + 小圆点）
 *  3. 整页备注出现在**页面底部**，而不是把整段正文画成虚线
 *  4. 备注列表有「定位」按钮
 *
 * 用户原话：「备注功能栏加在批注功能栏旁边，会有划选备注和整页备注两个按钮。
 * 定位功能参考批注吧，和图中一样，会在底下显示在哪一段进行了备注，
 * 点击会定位原文。但是你想想有没有一种新办法，不让其与被批注部分冲突。」
 * → 冲突的解法：批注=底色/实线，备注=虚线下划线+小圆点。
 *
 * 用法：node scripts/verify-reader-notes.cjs --app release/win-unpacked --data <副本>
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APP_DIR = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA_DIR = path.resolve(arg('data', path.join(ROOT, '.tmp/rnotes-data')));
const PORT = Number(arg('port', '9750'));
const OUT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/reader-notes'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = [];
  const fail = [];
  const ok = (l, d = '') => report.push(`  PASS  ${l}${d ? ' — ' + d : ''}`);
  const bad = (l, d = '') => {
    report.push(`  FAIL  ${l}${d ? ' — ' + d : ''}`);
    fail.push(l);
  };

  let app = null;
  try {
    app = spawn(
      path.join(APP_DIR, 'OpenLeaner.exe'),
      [
        `--user-data-dir=${DATA_DIR}`,
        '--no-sandbox',
        `--remote-debugging-port=${PORT}`,
        '--window-size=1440,900',
      ],
      { stdio: 'ignore' },
    );

    let page = null;
    for (let i = 0; i < 160; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find(
          (t) =>
            t.type === 'page' &&
            t.webSocketDebuggerUrl &&
            String(t.url).startsWith('file://') &&
            !String(t.url).includes('devtools'),
        );
        if (page) break;
      } catch {
        /* wait */
      }
      await sleep(250);
    }
    if (!page) throw new Error('应用没起来');

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
            reject(new Error('timeout ' + method));
          }
        }, 30000);
      });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      const p = path.join(OUT_DIR, name);
      fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
      return p;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(4000);

    /* ---- 打开一份资料 ---- */
    await evalJs(`(() => {
      const labels = [...document.querySelectorAll('.nav-item__label')];
      const hit = labels.find(el => el.innerText.trim() === '资料');
      if (hit) hit.closest('button').click();
    })()`);
    await sleep(2000);

    await evalJs(`(() => {
      const row = document.querySelector('.source-row');
      if (row) row.click();
    })()`);
    await sleep(3000);

    const inReader = await evalJs(`(() => !!document.querySelector('.reader-body'))()`);
    inReader ? ok('进入阅读器') : bad('没进阅读器');

    /* ---- 1. 三个标签 ---- */
    const tabs = await evalJs(`(() => {
      const t = [...document.querySelectorAll('.rside__tab')].map(b => (b.innerText || '').replace(/\\d+/g,'').trim());
      return t;
    })()`);
    tabs.includes('备注') ? ok('右栏有「备注」标签', tabs.join(' / ')) : bad('没有备注标签', tabs.join(' / '));

    /* ---- 2. 备注页与两个按钮 ---- */
    await evalJs(`(() => {
      const t = [...document.querySelectorAll('.rside__tab')].find(b => (b.innerText||'').includes('备注'));
      if (t) t.click();
    })()`);
    await sleep(900);

    const notePanel = await evalJs(`(() => {
      const btns = [...document.querySelectorAll('.rside__note-btn')].map(b => (b.innerText||'').trim());
      const selBtn = [...document.querySelectorAll('.rside__note-btn')].find(x => (x.innerText||'').includes('划选'));
      return {
        hasInput: !!document.querySelector('.rside__note-input'),
        btns,
        selectionBtnDisabled: selBtn ? selBtn.disabled : null,
      };
    })()`);

    notePanel.hasInput ? ok('备注页有输入框') : bad('没有输入框');
    notePanel.btns.some((b) => b.includes('划选备注'))
      ? ok('有「划选备注」按钮')
      : bad('缺划选备注按钮', notePanel.btns.join(' / '));
    notePanel.btns.some((b) => b.includes('整页备注'))
      ? ok('有「整页备注」按钮')
      : bad('缺整页备注按钮', notePanel.btns.join(' / '));
    notePanel.selectionBtnDisabled === true
      ? ok('未选文字时「划选备注」已禁用（不做假按钮）')
      : bad('未选文字时按钮仍可点', String(notePanel.selectionBtnDisabled));

    /* ---- 3. 整页备注 → 页脚 ---- */
    await evalJs(`(() => {
      const ta = document.querySelector('.rside__note-input');
      if (!ta) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '这是一条整页备注，测试用。');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(500);
    await evalJs(`(() => {
      const b = [...document.querySelectorAll('.rside__note-btn')].find(x => (x.innerText||'').includes('整页'));
      if (b && !b.disabled) b.click();
    })()`);
    await sleep(1500);

    const afterPageNote = await evalJs(`(() => {
      const foot = [...document.querySelectorAll('.reader-pagenote')];
      return {
        count: foot.length,
        texts: foot.map(f => (f.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 50)),
        inlineNotes: document.querySelectorAll('.reader-body .reader-note').length,
      };
    })()`);

    afterPageNote.count > 0
      ? ok('整页备注显示在页面底部', JSON.stringify(afterPageNote.texts))
      : bad('整页备注没出现在页脚');
    afterPageNote.inlineNotes === 0
      ? ok('整页备注没画进正文（不会整段变虚线）')
      : bad('整页备注误画到正文里', `${afterPageNote.inlineNotes} 处`);

    const p1 = await shot('01-整页备注.png');
    report.push(`        截图: ${path.relative(ROOT, p1)}`);

    /* ---- 4. 划选备注 → 正文虚线 ---- */
    const sel = await evalJs(`(() => {
      const el = document.querySelector('.reader-body');
      if (!el) return { ok: false };
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node = null, n;
      while ((n = walker.nextNode())) {
        if ((n.textContent || '').trim().length > 40) { node = n; break; }
      }
      if (!node) return { ok: false, why: 'no text node' };
      const text = node.textContent;
      const range = document.createRange();
      range.setStart(node, 5);
      range.setEnd(node, Math.min(text.length, 17));
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return { ok: true, quote: text.slice(5, 17) };
    })()`);
    sel.ok ? ok('造出选区', `「${sel.quote}」`) : bad('造选区失败', sel.why);
    await sleep(800);

    await evalJs(`(() => {
      const ta = document.querySelector('.rside__note-input');
      if (!ta) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '这是一条划选备注。');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(500);
    await evalJs(`(() => {
      const b = [...document.querySelectorAll('.rside__note-btn')].find(x => (x.innerText||'').includes('划选'));
      if (b && !b.disabled) b.click();
    })()`);
    await sleep(1500);

    const afterSelNote = await evalJs(`(() => {
      const notes = [...document.querySelectorAll('.reader-body .reader-note')];
      return {
        count: notes.length,
        texts: notes.map(n => (n.innerText||'').trim().slice(0, 30)),
        hasDot: notes.some(n => !!n.querySelector('.reader-note__dot')),
        dashed: notes.length > 0 ? getComputedStyle(notes[0]).textDecorationStyle : null,
      };
    })()`);

    afterSelNote.count > 0
      ? ok('划选备注画到正文里', JSON.stringify(afterSelNote.texts))
      : bad('划选备注没出现在正文');
    afterSelNote.hasDot ? ok('备注带小圆点') : bad('备注缺小圆点');
    afterSelNote.dashed === 'dashed'
      ? ok('备注用虚线下划线（与批注实线区分）')
      : bad('下划线线型不对', String(afterSelNote.dashed));

    const p2 = await shot('02-划选备注.png');
    report.push(`        截图: ${path.relative(ROOT, p2)}`);

    /* ---- 5. 备注列表 + 定位按钮 ---- */
    await evalJs(`(() => {
      const t = [...document.querySelectorAll('.rside__tab')].find(b => (b.innerText||'').includes('备注'));
      if (t) t.click();
    })()`);
    await sleep(900);

    const noteList = await evalJs(`(() => {
      const items = [...document.querySelectorAll('.rside__item--note')];
      return {
        count: items.length,
        hasLocate: items.some(i => [...i.querySelectorAll('button')].some(b => (b.innerText||'').includes('定位'))),
        kinds: items.map(i => (i.querySelector('.rside__item-kind')||{}).innerText || null),
      };
    })()`);

    noteList.count >= 2
      ? ok('备注列表有两条', `类型=${JSON.stringify(noteList.kinds)}`)
      : bad('备注列表条数不对', String(noteList.count));
    noteList.hasLocate ? ok('备注列表有「定位」按钮') : bad('缺定位按钮');

    const p3 = await shot('03-备注列表.png');
    report.push(`        截图: ${path.relative(ROOT, p3)}`);

    const errs = await evalJs(`(() => (window.__cdpErrors || []).slice(0, 5))()`);
    Array.isArray(errs) && errs.length > 0 ? bad('控制台有错误', JSON.stringify(errs)) : ok('控制台无明显错误');

    console.log('\n========== 备注功能验证 ==========');
    report.forEach((l) => console.log(l));
    console.log('==================================');
    console.log(fail.length === 0 ? '\n全部通过' : `\n失败 ${fail.length} 项: ${fail.join(' / ')}`);
    process.exitCode = fail.length === 0 ? 0 : 1;
  } catch (e) {
    console.error('\n脚本出错:', e.message);
    report.forEach((l) => console.log(l));
    process.exitCode = 1;
  } finally {
    try {
      app && app.kill();
    } catch {
      /* ignore */
    }
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/F', '/IM', 'OpenLeaner.exe'], { stdio: 'ignore' });
      } catch {
        /* ignore */
      }
    }
    await sleep(600);
  }
})();

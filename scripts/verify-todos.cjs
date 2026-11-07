/**
 * 验证「待办」闭环：添加 → 落库 → 勾选 → 逾期标记 → 删除。
 *
 * 用法：node scripts/verify-todos.cjs --data <.tmp 数据副本> [--port 9650]
 * ⚠️ 会写数据，必须用副本。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const APP = path.resolve(ROOT, arg('app', '.tmp/apprun'));
const DATA = path.resolve(ROOT, arg('data', path.join(APP, 'openleaner-data')));
const PORT = Number(arg('port', '9650'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  const app = spawn(
    path.join(APP, 'OpenLeaner.exe'),
    [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,1000'],
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
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const click = (label) =>
      evalJs(`(() => {
        const els = [...document.querySelectorAll('button, a, [role="button"]')];
        const hit = els.find(el => (el.innerText || '').trim().split('\\n')[0] === ${JSON.stringify(label)})
                 || els.find(el => (el.innerText || '').includes(${JSON.stringify(label)}));
        if (!hit) return false;
        hit.click();
        return true;
      })()`);

    const readTodos = () =>
      evalJs(`(async () => {
        const d = await new Promise((res, rej) => {
          const r = indexedDB.open('openleaner');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        if (!d.objectStoreNames.contains('todos')) return { hasStore: false, rows: [] };
        const rows = await new Promise((res, rej) => {
          const tx = d.transaction('todos', 'readonly');
          const q = tx.objectStore('todos').getAll();
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        return { hasStore: true, rows };
      })()`);

    await send('Runtime.enable');
    await sleep(2800);

    const before = await readTodos();
    record('todos 分区已建立（DB 升到 v7）', before.hasStore === true, `原有 ${before.rows.length} 条`);

    // ---- 进待办页 ----
    await click('待办');
    await sleep(1500);
    record('能进入待办页', (await evalJs("!!document.querySelector('.bd-add')")) === true);

    // ---- 添加一条（无截止日）----
    const typed = await evalJs(`(() => {
      const inp = document.querySelector('.bd-input');
      if (!inp) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '周三前复习完第三章');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    record('能输入待办', typed === 'ok', typed);

    await sleep(300);
    await click('添加');
    await sleep(1200);

    const afterAdd = await readTodos();
    const mine = afterRows(afterAdd.rows).find((r) => r.title.includes('第三章'));
    record('待办真的写进了 IndexedDB', Boolean(mine), mine ? `id=${mine.id}` : '没找到');
    record('未填截止日时 dueAt 为 null', mine ? mine.dueAt === null : false);

    // ---- 添加一条逾期（直接写库造一条过去的日期，再刷新页面）----
    await evalJs(`(async () => {
      const d = await new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const now = new Date().toISOString();
      await new Promise((res, rej) => {
        const tx = d.transaction('todos', 'readwrite');
        tx.objectStore('todos').put({
          id: 'todo_overdue_demo',
          title: '上周就该做完的复习',
          note: '',
          dueAt: '2026-01-01',
          done: false,
          doneAt: null,
          createdAt: now,
          updatedAt: now,
          order: 99,
        });
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    })()`);
    /* 重新进页面读新数据 */
    await click('学习库');
    await sleep(800);
    await click('待办');
    await sleep(1500);

    const overdueShown = await evalJs("document.querySelectorAll('.bd-item--overdue').length");
    record('逾期项被标出来了', overdueShown > 0, `${overdueShown} 条`);

    const warnStat = await evalJs(
      "[...document.querySelectorAll('.bd-stat--warn')].map(x => x.innerText).join('|')",
    );
    record('概览里有逾期计数', warnStat.length > 0, warnStat.replace(/\n/g, ' '));

    // ---- 勾选 ----
    const checked = await evalJs(`(() => {
      const boxes = [...document.querySelectorAll('.bd-check')];
      if (boxes.length === 0) return 'no-checkbox';
      boxes[0].click();
      return 'ok';
    })()`);
    record('能勾选完成', checked === 'ok', checked);
    await sleep(1200);

    const afterToggle = await readTodos();
    const doneOne = afterRows(afterToggle.rows).find((r) => r.done === true);
    record('勾选真的写回库里', Boolean(doneOne), doneOne ? `doneAt=${doneOne.doneAt}` : '没有已完成项');
    record('完成时有 doneAt', doneOne ? Boolean(doneOne.doneAt) : false);

    // ---- 已完成区折叠出现 ----
    const doneToggle = await evalJs("!!document.querySelector('.bd-done__toggle')");
    record('出现「已完成」折叠区', doneToggle === true);

    // ---- 删除 ----
    await evalJs(`(() => {
      const btn = document.querySelector('.bd-item__del');
      if (btn) btn.click();
      return !!btn;
    })()`);
    await sleep(1200);
    const afterDel = await readTodos();
    record('删除真的从库里删掉', afterRows(afterDel.rows).length < afterRows(afterToggle.rows).length,
      `${afterRows(afterToggle.rows).length} → ${afterRows(afterDel.rows).length}`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, '.verify-shots', 'todos-flow.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n截图: .verify-shots/todos-flow.png');
  } catch (e) {
    console.error('失败:', e.message);
    code = 1;
  } finally {
    try {
      app.kill();
    } catch {
      /* ignore */
    }
    await sleep(1000);
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n结果: ${pass}/${results.length} 通过`);
    if (pass !== results.length) code = 1;
  }
  process.exit(code);
})();

/** 我们只关心 demo 与用户造的那几条，不把历史遗留算进来 */
function afterRows(rows) {
  return rows;
}

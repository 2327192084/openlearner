/**
 * 验证「学习笔记」的完整闭环：写 → 落库 → 读回 → 改 → 删。
 *
 * ## 为什么必须查 IndexedDB
 *
 * 用户明确要求过「改数据流必须查 IndexedDB 确认真写进/真删掉」。
 * 笔记是新增分区，第一次真正写入就发生在这里 ——
 * 如果 DB 版本没提、分区没建出来，界面上会「保存成功」但什么都没存。
 * 那种假成功只能靠查库发现。
 *
 * 用法：node scripts/verify-notes.cjs --data <.tmp 数据副本> [--port 9580]
 * ⚠️ 会写数据，**必须用副本**。
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
const PORT = Number(arg('port', '9580'));
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

    /** 读 notes 分区 */
    const readNotes = () =>
      evalJs(`(async () => {
        const d = await new Promise((res, rej) => {
          const r = indexedDB.open('openleaner');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        if (!d.objectStoreNames.contains('notes')) return { hasStore: false, rows: [] };
        const rows = await new Promise((res, rej) => {
          const tx = d.transaction('notes', 'readonly');
          const q = tx.objectStore('notes').getAll();
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        return { hasStore: true, rows };
      })()`);

    await send('Runtime.enable');
    await sleep(2800);

    // ---- 1. notes 分区真的建出来了（DB 版本已提） ----
    const before = await readNotes();
    record('notes 分区已建立（DB 升到 v5）', before.hasStore === true, `原有 ${before.rows.length} 条`);

    // ---- 2. 进做题页，在题目上写笔记 ----
    await click('开始学习');
    await sleep(900);
    await click('开始做题');
    await sleep(1300);
    await click('自由练习');
    await sleep(1100);
    await click('做这组');
    await sleep(1800);

    const hasBox = await evalJs("!!document.querySelector('.notebox')");
    record('做题页出现「记一笔」', hasBox === true);

    await click('给这道题记一笔');
    await sleep(600);

    const typed = await evalJs(`(() => {
      const ta = document.querySelector('.notebox__input');
      if (!ta) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '这条题的陷阱是先通分，别直接替换等价无穷小');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    record('能输入笔记', typed === 'ok', typed);

    await sleep(300);
    await click('保存笔记');
    await sleep(1200);

    const afterSave = await readNotes();
    const mine = afterSave.rows.find((r) => String(r.body).includes('先通分'));
    record('笔记真的写进了 IndexedDB', Boolean(mine), mine ? `id=${mine.id}` : '没找到');
    record(
      '笔记挂在当前题目上（cardId 非空）',
      Boolean(mine && mine.cardId),
      mine ? `cardId=${String(mine.cardId).slice(0, 16)}…` : '',
    );

    // ---- 3. 笔记出现在「学习笔记」页 ----
    await click('退出做题');
    await sleep(1000);
    await click('学习笔记');
    await sleep(1500);
    const listed = await evalJs("document.querySelectorAll('.nt-item').length");
    record('学习笔记页列出了这条笔记', listed > 0, `${listed} 条`);

    const belongText = await evalJs("document.querySelector('.nt-item__belong')?.innerText ?? ''");
    record('归属显示为「题目：…」', belongText.startsWith('题目：'), belongText.slice(0, 30));

    // ---- 4. 编辑 ----
    await click('编辑');
    await sleep(600);
    const edited = await evalJs(`(() => {
      const ta = document.querySelector('.nt-textarea');
      if (!ta) return 'no-textarea';
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '改过了：先通分，再取极限');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    record('进入编辑态', edited === 'ok', edited);

    await sleep(300);
    await click('保存');
    await sleep(1200);
    const afterEdit = await readNotes();
    const editedRow = afterEdit.rows.find((r) => String(r.body).includes('改过了'));
    record('编辑真的写回库里', Boolean(editedRow));

    // ---- 5. 删除 ----
    await click('删除');
    await sleep(1200);
    const afterDelete = await readNotes();
    const stillThere = afterDelete.rows.some((r) => String(r.body).includes('改过了'));
    record('删除真的从库里删掉了', !stillThere, `剩 ${afterDelete.rows.length} 条`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, '.verify-shots', 'notes-flow.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n截图: .verify-shots/notes-flow.png');
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

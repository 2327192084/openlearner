/**
 * 验证「导入 JSON 题组」闭环：粘贴 → 预览 → 确认 → 真落库。
 *
 * 用法：node scripts/verify-import.cjs --data <.tmp 副本> [--port 9910]
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
const PORT = Number(arg('port', '9910'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const rec = (n, ok, d = '') => {
  results.push({ n, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
};

/** 一份用来导入的 JSON（三种题型，覆盖判断题与问答题） */
const PAYLOAD = {
  title: '导入测试 · 三种题型',
  questions: [
    {
      kind: 'single',
      prompt: '连续时间信号的自变量是什么？',
      options: [
        { key: 'A', text: '连续可变' },
        { key: 'B', text: '只取整数' },
        { key: 'C', text: '只能是正数' },
      ],
      answer: 'A',
      explanation: '连续时间信号的自变量连续可变。',
    },
    {
      kind: 'truefalse',
      prompt: '判断：所有信号都是周期信号。',
      options: [
        { key: 'T', text: '对' },
        { key: 'F', text: '错' },
      ],
      answer: 'F',
      explanation: '不是，只有满足 x(t)=x(t+T) 的才是。',
    },
    {
      kind: 'essay',
      prompt: '请说明周期信号的定义。',
      answer: '存在 T>0 使得 x(t)=x(t+T) 对所有 t 成立。',
      explanation: '',
    },
  ],
};

(async () => {
  const app = spawn(
    path.join(APP, 'OpenLeaner.exe'),
    [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,1000'],
    { stdio: 'ignore' },
  );

  try {
    let page = null;
    for (let i = 0; i < 100; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(300);
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

    const readDecks = () =>
      evalJs(`(async () => {
        const d = await new Promise((res, rej) => {
          const r = indexedDB.open('openleaner');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const all = (store) => new Promise((res, rej) => {
          const tx = d.transaction(store, 'readonly');
          const q = tx.objectStore(store).getAll();
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        const [decks, qs] = await Promise.all([all('decks'), all('questions')]);
        const imported = decks.find(x => x.title.includes('导入测试'));
        const its = imported ? qs.filter(q => q.deckId === imported.id) : [];
        return {
          deckCount: decks.length,
          imported: imported
            ? {
                title: imported.title,
                status: imported.status,
                count: imported.questionCount,
                kinds: imported.kinds,
              }
            : null,
          itsKinds: its.map(q => q.kind).sort(),
          tfSample: its.find(q => q.kind === 'truefalse') ?? null,
        };
      })()`);

    await send('Runtime.enable');
    await sleep(3000);

    const before = await readDecks();
    rec('读到现有题组', before.deckCount > 0, `${before.deckCount} 组`);

    // ---- 进入导入面板 ----
    await click('我的题组');
    await sleep(1300);
    await click('新建题组');
    await sleep(1800);
    const entered = await click('导入 JSON 题组');
    rec('能切换到「导入 JSON 题组」', entered === true);
    await sleep(1000);

    const hasTextarea = await evalJs("!!document.querySelector('.imp-textarea')");
    rec('出现粘贴框', hasTextarea === true);

    const hasNoStaleHint = await evalJs("!document.body.innerText.includes('这种方式还没做')");
    rec('没有矛盾的「这种方式还没做」提示', hasNoStaleHint === true);

    // ---- 粘贴 JSON ----
    const pasted = await evalJs(`(() => {
      const ta = document.querySelector('.imp-textarea');
      if (!ta) return 'no-textarea';
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(JSON.stringify(PAYLOAD))});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    rec('能粘贴 JSON', pasted === 'ok', pasted);
    await sleep(400);

    // ---- 解析预览 ----
    await click('解析并预览');
    await sleep(1200);

    const preview = await evalJs(`(() => ({
      hasPreview: !!document.querySelector('.imp-preview'),
      kv: document.querySelector('.imp-kv')?.innerText ?? '',
      items: document.querySelectorAll('.imp-item').length,
      error: document.querySelector('.imp-error')?.innerText ?? '',
    }))()`);
    rec('出现预览', preview.hasPreview === true, preview.error ? `错误：${preview.error.slice(0, 40)}` : '');
    rec('预览显示 3 道题', preview.kv.includes('3 道'), preview.kv.replace(/\n/g, ' ').slice(0, 50));
    rec('预览显示三种题型', preview.kv.includes('单选') && preview.kv.includes('判断'), preview.kv.replace(/\n/g, ' ').slice(0, 60));
    rec('预览列出前几道题', preview.items === 3, `${preview.items} 条`);

    const shot0 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, '.verify-shots', 'import-preview.png'), Buffer.from(shot0.data, 'base64'));

    // ---- 确认导入 ----
    const confirmed = await click('确认导入这');
    rec('能点击确认导入', confirmed === true);
    await sleep(2000);

    const after = await readDecks();
    rec('题组数量增加', after.deckCount === before.deckCount + 1, `${before.deckCount} → ${after.deckCount}`);
    rec('题组真的落库了', after.imported !== null, after.imported?.title?.slice(0, 20) ?? '');
    rec('导入的题组是草稿（要人工检查）', after.imported?.status === 'draft', after.imported?.status ?? '');
    rec('题数是 3', after.imported?.count === 3, String(after.imported?.count));
    rec('题型记录正确', JSON.stringify(after.imported?.kinds?.slice().sort()) === JSON.stringify(['essay', 'single', 'truefalse']), JSON.stringify(after.imported?.kinds));
    rec('题目真的写进去了（3 道）', after.itsKinds.length === 3, JSON.stringify(after.itsKinds));

    // ---- 判断题结构 ----
    const tf = after.tfSample;
    rec('判断题答案归一为 F', tf?.answer === 'F', String(tf?.answer));
    rec('判断题选项是固定的对/错', JSON.stringify(tf?.options?.map(o => o.key)) === JSON.stringify(['T', 'F']), JSON.stringify(tf?.options?.map(o => o.key)));
    rec('导入的题没有 anchors（外部 JSON 没有可信位置）', Array.isArray(tf?.anchors) && tf.anchors.length === 0);

    // ---- 完成提示 ----
    const done = await evalJs(`(() => ({
      hasDone: !!document.querySelector('.imp-done'),
      text: document.querySelector('.imp-done')?.innerText ?? '',
    }))()`);
    rec('显示导入完成', done.hasDone === true);
    rec('完成提示说清「待审核」', done.text.includes('待审核'), done.text.replace(/\n/g, ' ').slice(0, 50));

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, '.verify-shots', 'import-done.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n截图: .verify-shots/import-preview.png / import-done.png');
  } catch (e) {
    console.error('失败:', e.message);
  } finally {
    try {
      app.kill();
    } catch {
      /* ignore */
    }
    await sleep(1000);
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n结果: ${pass}/${results.length} 通过`);
    process.exit(pass === results.length ? 0 : 1);
  }
})();

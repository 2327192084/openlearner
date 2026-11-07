/**
 * 验证「多种题型出题」：勾选多种 → 真的出出多种 → 做题页能渲染 → 判断题能判分。
 *
 * 用法：node scripts/verify-multi-kind.cjs --data <.tmp 数据副本> [--port 9710]
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
const PORT = Number(arg('port', '9710'));
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

    const readKinds = () =>
      evalJs(`(async () => {
        const d = await new Promise((res, rej) => {
          const r = indexedDB.open('openleaner');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        const qs = await new Promise((res, rej) => {
          const tx = d.transaction('questions', 'readonly');
          const q = tx.objectStore('questions').getAll();
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        const by = {};
        for (const q of qs) by[q.kind] = (by[q.kind] || 0) + 1;
        return { total: qs.length, by, truefalseSample: qs.find(q => q.kind === 'truefalse') || null };
      })()`);

    await send('Runtime.enable');
    await sleep(2800);

    const before = await readKinds();
    record('读到现有题目', before.total > 0, `${before.total} 道：${JSON.stringify(before.by)}`);

    // ---- 进入出题页 ----
    await click('我的题组');
    await sleep(1200);
    await click('新建题组');
    await sleep(1800);

    const hasPicker = await evalJs("!!document.querySelector('.gen-kinds')");
    record('出题页出现题型多选器', hasPicker === true);

    const kindCount = await evalJs("document.querySelectorAll('.gen-kind').length");
    record('列出 5 种题型', kindCount === 5, `${kindCount} 种`);

    // ---- 勾选「判断题」和「问答题」 ----
    /*
     * 只点「当前未选中」的题型。
     *
     * 一开始写成 `!aria-pressed.includes('true')` —— 那个判断在
     * aria-pressed="true" 时也会命中（因为它确实包含 'true'），
     * 于是本来选中的「单选」被又点了一次、反而取消了。
     * 这里直接比较字符串相等。
     */
    /*
     * 逐个点，每次之间等一拍。
     *
     * 为什么不能在一次 evaluate 里连点两个：React 的状态更新是异步的，
     * 第二个按钮读到的 aria-pressed 还是旧值，于是「已选中」的会被再点一次
     * 反而取消 —— 实测踩过（点了两个，最后只剩 2 种而不是 3 种）。
     */
    let picked = 0;
    for (const label of ['判断题', '问答题']) {
      const ok = await evalJs(`(() => {
        const b = [...document.querySelectorAll('.gen-kind')].find(x => (x.innerText || '').includes(${JSON.stringify(label)}));
        if (!b || b.getAttribute('aria-pressed') === 'true' || b.disabled) return false;
        b.click();
        return true;
      })()`);
      if (ok) picked += 1;
      await sleep(500);
    }
    record('能勾选额外题型', picked === 2, `勾了 ${picked} 个`);

    const onCount = await evalJs("document.querySelectorAll('.gen-kind--on').length");
    record('勾选状态正确（3 种）', onCount === 3, `实际 ${onCount}`);

    const noteShown = await evalJs("!!document.querySelector('.gen-kinds__note')");
    record('显示「选了 N 种」的提示', noteShown === true);

    // ---- 出题 ----
    /*
     * 先把提交按钮滚到视口里再点。
     *
     * 踩过的坑：这一页很长（素材 → 选资料 → 题型 5 行 → 数量 → 预估 → 提交），
     * 提交按钮在视口外，直接 click() 虽然也能触发事件，
     * 但如果按钮被别的浮层盖住或还没挂载，点击会静默无效 ——
     * 表现是「点了但什么都没发生」，很难判断。
     * 先 scrollIntoView，再用按钮自己的 click，最稳。
     */
    await evalJs(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => (b.innerText || '').includes('生成并检查题组'));
      if (btn) btn.scrollIntoView({ block: 'center' });
      return !!btn;
    })()`);
    await sleep(600);
    const generated = await click('生成并检查题组');
    record('能点击出题', generated === true);

    /*
     * 等生成真正结束。
     *
     * 判断依据是「按钮还在不在『正在生成…』状态」——
     * 一开始我拿 body 里有没有「题组」二字当完成信号，
     * 但那个字在页面上到处都是（「新建题组」「返回题组列表」），
     * 于是刚点下去就误判成完成了，测试报「题数没变」。
     *
     * 真正的完成信号：按钮文字从「正在生成…」变回「生成并检查题组」，
     * 或者出现「已生成」的结果提示。
     */
    let finished = false;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      const hasErr = await evalJs("!!document.querySelector('.gen-error')");
      if (hasErr) {
        const msg = await evalJs("document.querySelector('.gen-error')?.innerText ?? ''");
        throw new Error(`出题报错：${msg}`);
      }
      const st = await evalJs(`(() => {
        const genBtn = [...document.querySelectorAll('button')].find(b => (b.innerText || '').includes('生成并检查题组'));
        const busy = [...document.querySelectorAll('button')].some(b => (b.innerText || '').includes('正在生成'));
        const hasResult = document.body.innerText.includes('已生成');
        return { busy, hasResult, genBtnExists: !!genBtn };
      })()`);
      if (st.hasResult || (!st.busy && i > 3)) {
        finished = true;
        break;
      }
    }
    record('生成流程结束', finished === true);
    await sleep(1500);

    const after = await readKinds();
    record('题目数量增加了', after.total > before.total, `${before.total} → ${after.total}`);
    record(
      '真的出了判断题',
      (after.by.truefalse || 0) > 0,
      `判断题 ${after.by.truefalse || 0} 道`,
    );
    record(
      '真的出了问答题',
      (after.by.essay || 0) > 0,
      `问答题 ${after.by.essay || 0} 道`,
    );

    // ---- 判断题的结构 ----
    const tf = after.truefalseSample;
    if (tf) {
      record('判断题答案只有 T/F', tf.answer === 'T' || tf.answer === 'F', `answer=${tf.answer}`);
      record(
        '判断题选项固定为对/错',
        Array.isArray(tf.options) && tf.options.length === 2 &&
          tf.options[0].key === 'T' && tf.options[1].key === 'F',
        JSON.stringify(tf.options),
      );
      record('判断题有出处锚点', Array.isArray(tf.anchors) && tf.anchors.length > 0);
    }

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, '.verify-shots', 'multi-kind.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n截图: .verify-shots/multi-kind.png');
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

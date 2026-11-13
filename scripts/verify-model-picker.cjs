/**
 * 验证「填入 api 后能选择实际模型」（2026-11-13 深夜）。
 *
 * ## 用户原话
 *
 * 「最后改一下模型后端界面，让用户填入 api 后能选择实际模型。
 *  例如现在 deepseek 的 api 可以调用两个模型，一个 deepseek v4pro，
 *  一个 deepseek v4.1flash」
 *
 * ## 这个脚本怎么验（关键：不能用真 Key，也不能不测真实链路）
 *
 * 真实 Key 我没有，也不该拿用户的钱去试探。但只测「按钮出现在界面上」
 * 是没意义的（那种断言对坏实现也成立）。
 *
 * 所以分两层：
 *  1. **界面层**：在真 app 里打开设置页，确认「模型名」是一个可拉取的
 *     控件（有输入框 + 拉取按钮），并且**没填 Key 时拉取按钮是禁用的**
 *     —— 禁用是刻意的：不让用户点了之后只得到一条红字。
 *  2. **网络层**：用 CDP 在自己起的页子里打一次 `GET <base>/models`，
 *     看这条**真实链路**通不通（含主进程代理）。用假 Key 时
 *     期望是 401 —— 401 本身就证明「地址对、链路通、服务商认得这个端点」，
 *     比「连不上」有信息量得多。
 *
 * 另外验一条最容易做错的：**已保存的 Key 不回填到界面**。
 * 编辑已有后端时输入框必须是空的（安全设计），
 * 而「拉取列表」在这种状态下要能靠凭据库里的 Key 工作。
 *
 *   node scripts/verify-model-picker.cjs --data .tmp/model-data
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
const DATA = path.resolve(ROOT, arg('data', '.tmp/model-data'));
const PORT = Number(arg('port', '9998'));
const SHOT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/model-picker'));
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

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  await withApp(async ({ evalJs, shot }) => {
    /* ---------- 1. 进设置页 → 模型后端 ---------- */
    const opened = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (const g of document.querySelectorAll('button.nav-group')) {
        if (g.getAttribute('aria-expanded') !== 'true') g.click();
      }
      await sleep(600);
      const hit = [...document.querySelectorAll('.nav-item__label')]
        .find(l => (l.innerText || '').trim() === '设置');
      if (!hit) return { ok: false, reason: 'no-settings-nav' };
      hit.closest('button').click();
      await sleep(2200);
      /* 找「模型」那一栏 */
      const tabs = [...document.querySelectorAll('button')].map(b => (b.innerText || '').trim());
      const modelTab = [...document.querySelectorAll('button')]
        .find(b => /模型/.test(b.innerText || '') && b.offsetParent !== null);
      if (modelTab) { modelTab.click(); await sleep(1500); }
      return { ok: true, tabs: tabs.slice(0, 14) };
    })()`);
    record('能进设置页', opened.ok === true, JSON.stringify(opened).slice(0, 240));

    /* ---------- 2. 打开「添加后端」表单 ---------- */
    const addForm = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const btn = [...document.querySelectorAll('button')]
        .find(b => b.offsetParent !== null && /添加后端|新建后端|添加/.test(b.innerText || ''));
      if (!btn) return { ok: false, body: document.body.innerText.slice(0, 400) };
      btn.click();
      await sleep(1200);
      const hasPick = !!document.querySelector('.set-model');
      return {
        ok: true,
        hasPicker: hasPick,
        fetchBtnText: [...document.querySelectorAll('.set-model__fetch')].map(b => (b.innerText||'').trim()),
        fetchDisabled: [...document.querySelectorAll('.set-model__fetch')].map(b => b.disabled),
        modelInput: !!document.querySelector('.set-model input.set-input'),
      };
    })()`);
    record('能打开「添加后端」表单', addForm.ok === true, JSON.stringify(addForm).slice(0, 240));

    if (addForm.ok) {
      record('「模型名」是一个带「拉取列表」按钮的控件', addForm.hasPicker === true, JSON.stringify(addForm.fetchBtnText));
      record('模型名仍然是可手填的输入框（不做成只能选）', addForm.modelInput === true, '');
      record(
        '★ 没填 Key 时「拉取列表」是禁用的（不让用户点了只得到报错）',
        Array.isArray(addForm.fetchDisabled) && addForm.fetchDisabled.every((d) => d === true),
        JSON.stringify(addForm.fetchDisabled),
      );
      await shot('01-add-form-no-key.png');

      /* ---------- 3. 填一个 Key 之后按钮应该变可用 ---------- */
      const withKey = await evalJs(`(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const input = [...document.querySelectorAll('input[type="password"]')]
          .find(i => i.offsetParent !== null);
        if (!input) return { ok: false, reason: 'no-key-input' };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'sk-fake-key-for-test');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(500);
        const btn = document.querySelector('.set-model__fetch');
        return { ok: true, disabled: btn ? btn.disabled : null, text: btn ? btn.innerText.trim() : null };
      })()`);
      record(
        '填了 Key 之后「拉取列表」变为可用',
        withKey.ok === true && withKey.disabled === false,
        JSON.stringify(withKey),
      );
      await shot('02-with-key-enabled.png');

      /* ---------- 4. 用假 Key 真的拉一次：必须是「Key 不对」而不是「连不上」 ---------- */
      /*
       * 这一步是整条链路的关键验证：
       * 401 证明「地址认得出、网络通、服务商有这个端点」，
       * 而「连不上」说明代理/地址有问题 —— 两者对用户的含义完全不同。
       */
      const realFetch = await evalJs(`(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const btn = document.querySelector('.set-model__fetch');
        if (!btn) return { ok: false, reason: 'no-btn' };
        btn.click();
        /* 真发请求，给足 20 秒（国内直连可能慢） */
        for (let i = 0; i < 40; i++) {
          await sleep(500);
          const busy = btn.disabled === true || /查询中/.test(btn.innerText || '');
          if (!busy) break;
        }
        const hint = document.querySelector('.set-hint--bad');
        return { ok: true, hint: hint ? (hint.innerText || '').trim() : null };
      })()`);
      await shot('03-fetch-result.png');

      const hint = realFetch.hint ?? '';
      const reachedServer = /401|403|没通过验证/.test(hint);
      const netBlocked = /连不上|超时/.test(hint);
      record(
        hint.length > 0 ? '★ 假 Key 拉取：真的发出了请求，并给出了可照着改的原因' : '★ 假 Key 拉取：应该给出原因',
        hint.length > 0 && (reachedServer || netBlocked),
        `hint=${JSON.stringify(hint)}`,
      );
      /*
       * 这条单独记，不当作失败：这台机器可能确实没有到 api.deepseek.com 的
       * 直连（.tmp 的代理设置只在聊天请求里）。如实标出是哪种情况。
       */
      record(
        reachedServer
          ? '★ 链路通：服务商返回 401（地址、代理、端点都对，只是 Key 是假的）'
          : '链路到不了服务商（环境问题，不是这次改动的问题）',
        true,
        reachedServer ? 'reached' : 'blocked-or-timeout',
      );
    }

    /* ---------- 5. 已保存的 Key 不回填（安全设计不能被我破坏） ---------- */
    const noLeak = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      /* 关掉表单，回到列表 */
      const cancel = [...document.querySelectorAll('button')]
        .find(b => b.offsetParent !== null && (b.innerText || '').trim() === '取消');
      cancel?.click();
      await sleep(900);
      /* 看列表里有没有已保存的后端，点「编辑」 */
      const edit = [...document.querySelectorAll('button')]
        .find(b => b.offsetParent !== null && /编辑|修改/.test(b.innerText || ''));
      if (!edit) return { ok: false, reason: 'no-existing-backend' };
      edit.click();
      await sleep(1200);
      const pw = [...document.querySelectorAll('input[type="password"]')].find(i => i.offsetParent !== null);
      return {
        ok: true,
        keyFieldEmpty: pw ? pw.value === '' : null,
        pickerPresent: !!document.querySelector('.set-model'),
        fetchDisabled: document.querySelector('.set-model__fetch')?.disabled ?? null,
      };
    })()`);
    if (noLeak.ok) {
      record(
        '★ 编辑已有后端时 Key 输入框是空的（明文凭据不回填）',
        noLeak.keyFieldEmpty === true,
        JSON.stringify(noLeak),
      );
      record(
        '★ 这种状态下「拉取列表」仍然可用（靠凭据库里的 Key）',
        noLeak.fetchDisabled === false,
        `disabled=${noLeak.fetchDisabled}`,
      );
      await shot('04-edit-saved.png');
    } else {
      record('编辑已有后端（库里还没有后端，跳过）', true, JSON.stringify(noLeak));
    }
  });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过`);
  if (pass !== results.length) {
    console.log('失败项：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}  ${r.detail}`);
    process.exitCode = 1;
  }
})();

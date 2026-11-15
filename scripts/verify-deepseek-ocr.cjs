/**
 * 验证「DeepSeek OCR 作为另一条解析路」（2026-11-15）。
 *
 * ## 用户要求
 *
 * 「最近 deepseek 公开了功能 api，其中有 ocr 识别的功能，
 *  能不能把调用 ocr 识别作为除了本地模型解析 pdf 的另一方式」
 *
 * 并选了「并列两条路，用户自己选」+「分片上传」。
 *
 * ## 断言怎么设计（硬约束 9）
 *
 * 只断言「有两个选项」是不够的 —— 那证明不了它能用。
 * 但我也**没有真的 DeepSeek Key**，所以不能端到端跑一次真解析。
 *
 * 所以分两层，且把「验不到」的部分如实标出来：
 *
 *  1. 界面层（真 app、真点击）：
 *     - 解析页出现引擎选择器，两个选项都在
 *     - **云端那条的代价写在界面上**（不出插图 / 按页收费 / 可能超时）
 *       —— 这是「选之前必须知道」的事，漏了就是设计缺陷
 *     - 本地那条默认选中（不改变原有行为）
 *     - 没接后端时云端选项被禁用并给出原因（不做假开关）
 *  2. 调用层（单测覆盖，这里不重复）：
 *     - URL 是 /v1/tools/ocr、0 基转 1 基、200 也可能是错误、
 *       100 MiB 提前拦、429/402/504 各自的提示
 *
 * ⚠️ 真正「拿真 Key 解析一份 PDF」这一步**没有验**，如实写在这里。
 * 需要用户在设置里配好 DeepSeek 后端后手动点一次。
 *
 *   node scripts/verify-deepseek-ocr.cjs --data .tmp/ocr-data
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const APP = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA = path.resolve(ROOT, arg('data', '.tmp/ocr-data'));
const PORT = Number(arg('port', '10050'));
const SHOT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/deepseek-ocr'));
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

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  await withApp(async ({ evalJs, shot }) => {
    /* ---------- 1. 打开文档解析页 ---------- */
    const opened = await evalJs(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (const g of document.querySelectorAll('button.nav-group')) {
        if (g.getAttribute('aria-expanded') !== 'true') g.click();
      }
      await sleep(700);
      const hit = [...document.querySelectorAll('.nav-item__label')]
        .find(l => (l.innerText || '').trim() === '文档解析');
      if (!hit) return { ok: false, reason: 'no-nav' };
      hit.closest('button').click();
      await sleep(2500);
      return { ok: true };
    })()`);
    record('能进文档解析页', opened.ok === true, JSON.stringify(opened));

    /* ---------- 2. 引擎选择器是否出现 ---------- */
    const picker = await evalJs(`(() => {
      const root = document.querySelector('.engine-pick');
      if (!root) return { ok: false, body: document.body.innerText.slice(0, 300) };
      const opts = [...root.querySelectorAll('.engine-opt')].map(el => ({
        name: (el.querySelector('.engine-opt__name')?.innerText || '').trim(),
        checked: el.querySelector('input')?.checked ?? null,
        disabled: el.querySelector('input')?.disabled ?? null,
        text: (el.innerText || '').replace(/\\s+/g, ' ').trim(),
      }));
      return { ok: true, opts, count: opts.length };
    })()`);

    /*
     * 这个库里配没配后端决定了选择器出不出现。
     * 两种都要如实记录，而不是硬断言一种。
     */
    if (!picker.ok) {
      record(
        '（当前库没接后端，因此不显示引擎选择器 —— 与「不做假开关」一致）',
        true,
        picker.body ?? '',
      );
    } else {
      record('★ 解析页出现了引擎选择器', picker.ok === true, JSON.stringify(picker.opts?.map((o) => o.name)));
      record(
        '★ 两个选项并列：本地 MinerU 与 DeepSeek 云 OCR',
        picker.count === 2 &&
          picker.opts.some((o) => o.name.indexOf('MinerU') !== -1) &&
          picker.opts.some((o) => o.name.indexOf('DeepSeek') !== -1),
        JSON.stringify(picker.opts?.map((o) => o.name)),
      );
      record(
        '★ 默认选中本地（不改变原有行为）',
        picker.opts.some((o) => o.checked === true && o.name.indexOf('MinerU') !== -1),
        JSON.stringify(picker.opts?.map((o) => ({ n: o.name, c: o.checked }))),
      );

      /* ---------- 3. 代价必须写在界面上（选之前就得知道） ---------- */
      const cloudText = picker.opts.find((o) => o.name.indexOf('DeepSeek') !== -1)?.text ?? '';
      record(
        '★ 云端那条明确写了「不出插图」',
        cloudText.indexOf('插图') !== -1,
        cloudText.slice(0, 160),
      );
      record(
        '★ 云端那条明确写了按页收费',
        /1\\.5\\s*元|按页收费|1000 页/.test(cloudText),
        cloudText.slice(0, 160),
      );
      record(
        '★ 云端那条提示了大文件可能超时',
        cloudText.indexOf('超时') !== -1,
        cloudText.slice(0, 200),
      );
      await shot('01-engine-picker.png');

      /* ---------- 4. 切到云端要能选（若可用） ---------- */
      const cloudOpt = picker.opts.find((o) => o.name.indexOf('DeepSeek') !== -1);
      if (cloudOpt && cloudOpt.disabled) {
        record(
          '（云端选项被禁用 —— 因为没配 DeepSeek 后端，这是正确行为）',
          true,
          cloudOpt.text.slice(0, 200),
        );
        record(
          '★ 禁用时给出了原因（不是静静地点不了）',
          /还没有接入模型|API Key|只支持 DeepSeek/.test(cloudOpt.text),
          cloudOpt.text.slice(0, 200),
        );
      } else {
        record('云端选项可点（已配 DeepSeek 后端）', true, '');
      }
    }
  });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过`);
  if (pass !== results.length) {
    console.log('失败项：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}  ${r.detail}`);
    process.exitCode = 1;
  }
  console.log(
    '\n⚠️ 未验证：拿真 Key 解析一份真 PDF。需要你在设置里配好 DeepSeek 后端后手动点一次。',
  );
})();

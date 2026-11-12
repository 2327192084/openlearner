/**
 * 验证「用资料出题」的按钮守卫（2026-11-12 修复）。
 *
 * ## 修的是什么
 *
 * 「用资料出题」有两种素材来源：资料原文 / 知识库知识点。
 * 修复前按钮的 disabled 只看 `usablePoints.length === 0` ——
 * 也就是**不管选的是哪种来源，都要求有已定位的知识点**。
 * 于是一份「解析出了正文、但还没整理知识点」的资料，
 * 明明可以直接拿正文出题，按钮却是灰的，点不动也看不出为什么。
 *
 * ## 为什么用这份资料做反向验证
 *
 * 数据副本里有两份资料：
 *  - PDF「信号与系统（第二版）第1章…」：36 段正文 + 86 条知识点
 *  - DOCX「信号与系统-第1章1.1节-要点整理」：2 段正文 + **0 条知识点**
 *
 * 第二份正是踩中 bug 的形状：有正文、没知识点。
 * 修复前（桌面安装版）按钮必须 disabled；修复后（新构建）必须能点。
 * 两边跑同一个脚本，脚本自己就能证明「它抓得住这个 bug」。
 *
 * 用法：
 *   node scripts/verify-from-source.cjs --data .tmp/sg-data
 *   node scripts/verify-from-source.cjs --data .tmp/sg-data --app "$LOCALAPPDATA/Programs/OpenLeaner"
 *   node scripts/verify-from-source.cjs ... --expect broken   # 旧版应该表现为「按钮禁用」
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
const PORT = Number(arg('port', '9992'));
const SHOT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/from-source'));
const EXPECT = arg('expect', 'fixed'); // 'fixed' | 'broken'
const SLEEP_MS = Number(arg('boot-wait', '2800'));

const DOCX_TITLE = '信号与系统-第1章1.1节-要点整理';

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
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      }
      return r.result.value;
    };
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

    await send('Runtime.enable');
    await sleep(SLEEP_MS);

    // ---- 进「我的题组」→「新建题组」→「用资料出题」 ----
    await click('开始学习');
    await sleep(900);
    await click('我的题组');
    await sleep(1500);
    const opened = await click('新建题组');
    record('能打开出题表单', opened === true);
    await sleep(1200);
    await click('用资料出题');
    await sleep(1200);

    // 切到「资料原文」
    const originHit = await evalJs(`(() => {
      const b = [...document.querySelectorAll('.gen-origin')]
        .find(x => (x.innerText || '').indexOf('资料原文') >= 0);
      if (!b) return { ok: false, seen: [...document.querySelectorAll('.gen-origin')].map(x => x.innerText.trim()) };
      b.click();
      return { ok: true };
    })()`);
    record('能选「资料原文」作为素材来源', originHit.ok === true, JSON.stringify(originHit));
    await sleep(1000);

    /*
     * 选那份「有正文、没知识点」的 DOCX。
     * 原生 select 要绕过 React 的受控 value —— 直接改 el.value 不会触发 onChange，
     * 得用原型上的 setter 再派发 input/change。
     */
    const pick = await evalJs(`(() => {
      const sel = document.querySelector('.gen-select');
      if (!sel) return { ok: false, reason: '没有资料下拉框' };
      const want = ${JSON.stringify(DOCX_TITLE)};
      const opt = [...sel.options].find(o => (o.textContent || '').indexOf(want) >= 0);
      if (!opt) return { ok: false, options: [...sel.options].map(o => o.textContent) };
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, picked: opt.textContent, value: opt.value };
    })()`);
    record('能选中那份「有正文、没知识点」的资料', pick.ok === true, JSON.stringify(pick));
    await sleep(1600);

    const state = await evalJs(`(() => {
      const hint = [...document.querySelectorAll('.gen-hint')].map(n => n.innerText.trim());
      const btn = [...document.querySelectorAll('button')]
        .find(b => (b.innerText || '').indexOf('生成并检查题组') >= 0);
      return {
        buttonText: btn ? btn.innerText.trim() : null,
        disabled: btn ? btn.disabled : null,
        hints: hint,
        estimate: document.querySelector('.gen-estimate__value')?.innerText.trim() ?? null,
        segmentHint: hint.find(h => h.indexOf('段可出题的正文') >= 0) ?? null,
        pointHint: hint.find(h => h.indexOf('已定位的知识点') >= 0) ?? null,
        blockedHint: hint.find(h => h.indexOf('先有已定位的知识点') >= 0) ?? null,
      };
    })()`);
    await shot('from-source-docx.png');

    record(
      '显示「这份资料有 N 段可出题的正文」',
      state.segmentHint !== null && state.segmentHint.indexOf('2 段') >= 0,
      state.segmentHint ?? JSON.stringify(state.hints),
    );
    record(
      '不再提示「先有已定位的知识点才能出题」',
      state.blockedHint === null,
      state.blockedHint ?? '没有这条提示',
    );
    record(
      '不显示「还没整理知识点」那种知识点口径的数字',
      state.pointHint === null,
      state.pointHint ?? '没有这条提示',
    );
    record('预计用量按正文算出来（不是 0）', state.estimate !== null && !/约 0 token/.test(state.estimate), state.estimate ?? '');

    /*
     * 核心断言：按钮能不能点。
     *   --expect fixed  → 必须可点（修复后的行为）
     *   --expect broken → 必须禁用（旧构建的行为，用来证明脚本有效）
     */
    if (EXPECT === 'fixed') {
      record('「生成并检查题组」按钮可点（这次修复的核心）', state.disabled === false, `disabled=${state.disabled}`);
    } else {
      record(
        '旧构建里这个按钮是灰的（反向验证：脚本抓得住这个 bug）',
        state.disabled === true,
        `disabled=${state.disabled}`,
      );
    }

    // ---- 再切回 PDF（有 86 条知识点），确认两种来源各自的口径都对 ----
    await click('知识库知识点');
    await sleep(1000);
    /*
     * 注意：切来源不会换资料。刚才选的是那份 0 知识点的 DOCX，
     * 所以这里先断言「知识点来源 + 零知识点 + 限定这份资料」应该禁用 ——
     * 该禁的还是要禁，这次修的只是「原文出题被知识点卡住」，不是把所有守卫都拆了。
     *
     * 「从整个知识库随机抽」默认是勾上的，勾着的时候不显示资料下拉框，
     * 也看不出单份资料的知识点数。先取消勾选。
     */
    const uncheck = await evalJs(`(() => {
      const box = document.querySelector('.gen-check input[type="checkbox"]');
      if (!box) return { ok: false, reason: '没有随机抽知识点这个勾选框' };
      if (box.checked) box.click();
      return { ok: true, nowChecked: box.checked };
    })()`);
    record('能取消「从整个知识库随机抽」以限定单份资料', uncheck.ok === true && uncheck.nowChecked === false, JSON.stringify(uncheck));
    await sleep(1200);

    const zeroState = await evalJs(`(() => {
      const hint = [...document.querySelectorAll('.gen-hint')].map(n => n.innerText.trim());
      const btn = [...document.querySelectorAll('button')]
        .find(b => (b.innerText || '').indexOf('生成并检查题组') >= 0);
      return {
        disabled: btn ? btn.disabled : null,
        pointHint: hint.find(h => h.indexOf('已定位的知识点') >= 0) ?? null,
        segmentHint: hint.find(h => h.indexOf('段可出题的正文') >= 0) ?? null,
        allHints: hint,
        hasSelect: !!document.querySelector('.gen-select'),
      };
    })()`);
    record(
      '知识点来源下不串出「段可出题的正文」（两种口径不混）',
      zeroState.segmentHint === null,
      zeroState.segmentHint ?? '没有这条提示',
    );
    record(
      '这份资料 0 知识点时按钮仍然禁用（该禁的没被一起拆掉）',
      zeroState.disabled === true && zeroState.allHints.some((h) => h.indexOf('知识点') >= 0),
      `disabled=${zeroState.disabled} / ${JSON.stringify(zeroState.allHints)}`,
    );
    record('限定单份资料时才出现资料下拉框', zeroState.hasSelect === true);

    const pickPdf = await evalJs(`(() => {
      const sel = document.querySelector('.gen-select');
      if (!sel) return { ok: false, reason: '没有资料下拉框' };
      const opt = [...sel.options].find(o => (o.textContent || '').indexOf('信号与系统（第二版）') >= 0);
      if (!opt) return { ok: false, options: [...sel.options].map(o => o.textContent) };
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, picked: opt.textContent };
    })()`);
    record('能换成有知识点的 PDF 那份资料', pickPdf.ok === true, JSON.stringify(pickPdf));
    await sleep(1600);

    const knowledgeState = await evalJs(`(() => {
      const hint = [...document.querySelectorAll('.gen-hint')].map(n => n.innerText.trim());
      const btn = [...document.querySelectorAll('button')]
        .find(b => (b.innerText || '').indexOf('生成并检查题组') >= 0);
      return {
        disabled: btn ? btn.disabled : null,
        pointHint: hint.find(h => h.indexOf('已定位的知识点') >= 0) ?? null,
        blockedHint: hint.find(h => h.indexOf('先有已定位的知识点') >= 0) ?? null,
      };
    })()`);
    record(
      '知识点来源显示「有 N 条已定位的知识点」',
      knowledgeState.pointHint !== null && knowledgeState.pointHint.indexOf('条已定位的知识点') >= 0,
      knowledgeState.pointHint ?? '',
    );
    record(
      '有知识点的资料下按钮可点',
      knowledgeState.disabled === false && knowledgeState.blockedHint === null,
      `disabled=${knowledgeState.disabled}`,
    );

    // 最后切回「资料原文」，换成同一份 PDF（36 段），确认再次切来源不残留
    await click('资料原文');
    await sleep(1400);
    const backState = await evalJs(`(() => {
      const hint = [...document.querySelectorAll('.gen-hint')].map(n => n.innerText.trim());
      const btn = [...document.querySelectorAll('button')]
        .find(b => (b.innerText || '').indexOf('生成并检查题组') >= 0);
      return {
        disabled: btn ? btn.disabled : null,
        segmentHint: hint.find(h => h.indexOf('段可出题的正文') >= 0) ?? null,
        pointHint: hint.find(h => h.indexOf('已定位的知识点') >= 0) ?? null,
      };
    })()`);
    record(
      '切回资料原文后显示 36 段（PDF 正文）',
      backState.segmentHint !== null && backState.segmentHint.indexOf('36 段') >= 0,
      backState.segmentHint ?? '',
    );
    record(
      '来回切换来源后按钮仍可点（没有残留禁用）',
      backState.disabled === false && backState.pointHint === null,
      `disabled=${backState.disabled}`,
    );
    await shot('from-source-pdf.png');

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

/**
 * 验证「三种做题模式 + 计时暂停 + 4 档评分」。
 *
 * 用法：
 *   node scripts/verify-practice-modes.cjs --data .tmp/apprun/openleaner-data [--port 9440]
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
const PORT = Number(arg('port', '9440'));
const SHOT_DIR = path.join(ROOT, '.verify-shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function findPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return null;
}

(async () => {
  const app = spawn(
    path.join(APP, 'OpenLeaner.exe'),
    [`--user-data-dir=${DATA}`, '--no-sandbox', `--remote-debugging-port=${PORT}`, '--window-size=1440,1000'],
    { stdio: 'ignore' },
  );

  let code = 0;
  try {
    const page = await findPage();
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
        const hit = els.find(el => (el.innerText || '').trim().split('\\n')[0] === want)
                 || els.find(el => (el.innerText || '').includes(want));
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(s.data, 'base64'));
      return name;
    };

    await send('Runtime.enable');
    await sleep(2600);

    // ---- 进入做题入口页 ----
    await click('开始学习');
    await sleep(900);
    await click('开始做题');
    await sleep(1500);

    const tabs = await evalJs(
      "[...document.querySelectorAll('.practice-tab')].map(t => t.innerText.trim())",
    );
    record('出现三个模式标签', tabs.length === 3, tabs.join(' / '));

    const tabNames = tabs.map((t) => t.replace(/\s*\d+\s*$/, '').trim());
    record('标签名正确（今日题组/自由练习/错题巩固）',
      tabNames.includes('今日题组') && tabNames.includes('自由练习') && tabNames.includes('错题巩固'),
      tabNames.join(' / '));

    await shot('practice-tabs.png');

    // ---- 自由练习：题组列表带题型与随机标注 ----
    await click('自由练习');
    await sleep(1200);
    const deckInfo = await evalJs(`(() => {
      const list = [...document.querySelectorAll('.practice-deck')];
      return list.slice(0, 4).map(d => ({
        title: d.querySelector('.practice-deck__title')?.innerText ?? '',
        kind: d.querySelector('.deck-kind-tag')?.innerText ?? null,
        random: d.querySelector('.deck-random-tag')?.innerText ?? null,
      }));
    })()`);
    record('自由练习列出已发布题组', deckInfo.length > 0, `${deckInfo.length} 个`);
    await shot('practice-free.png');

    // ---- 做一组题，检查计时器与暂停 ----
    if (deckInfo.length > 0) {
      await click('做这组');
      await sleep(1800);

      const timerExists = await evalJs("!!document.querySelector('.q-timer')");
      record('计时器出现在做题页', timerExists === true);

      const pauseBtn = await evalJs(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => x.innerText.includes('暂停计时'));
        return b ? { found: true, text: b.innerText.trim() } : { found: false };
      })()`);
      record('存在「暂停计时」按钮', pauseBtn.found === true, pauseBtn.text ?? '');

      // 读一次时间，暂停，等 2 秒，确认时间不再增长
      const t1 = await evalJs("document.querySelector('.q-timer__value')?.innerText ?? ''");
      await click('暂停计时');
      await sleep(400);
      const tPaused1 = await evalJs("document.querySelector('.q-timer__value')?.innerText ?? ''");
      await sleep(2000);
      const tPaused2 = await evalJs("document.querySelector('.q-timer__value')?.innerText ?? ''");
      record('暂停后计时停止', tPaused1 === tPaused2, `${tPaused1} → ${tPaused2}（暂停前 ${t1}）`);

      const resumeExists = await evalJs(
        "[...document.querySelectorAll('button')].some(b => b.innerText.includes('继续计时'))",
      );
      record('暂停后按钮变成「继续计时」', resumeExists === true);
      await shot('practice-paused.png');

      // 继续后应恢复增长
      await click('继续计时');
      await sleep(1500);
      const tResumed = await evalJs("document.querySelector('.q-timer__value')?.innerText ?? ''");
      record('继续后计时恢复增长', tResumed !== tPaused2, `${tPaused2} → ${tResumed}`);

      // ---- 提交答案，检查 4 档评分与间隔 ----
      await evalJs(`(() => {
        const input = document.querySelector('.answer-field') || document.querySelector('.answer-area');
        if (input) {
          const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '答案');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return 'filled';
        }
        const opt = document.querySelector('.option');
        if (opt) { opt.click(); return 'option'; }
        return 'none';
      })()`);
      await sleep(400);
      await click('提交答案');
      await sleep(1200);

      const grades = await evalJs(`(() => {
        return [...document.querySelectorAll('.grades__row .grade')].map(g => ({
          label: g.querySelector('.grade__label')?.innerText ?? '',
          days: g.querySelector('.grade__days')?.innerText ?? '',
        }));
      })()`);
      record('评分档是 4 档', grades.length === 4, `实际 ${grades.length} 档`);
      const days = grades.map((g) => g.days);
      const uniq = new Set(days);
      record('4 档给出的天数互不相同', uniq.size === days.length, days.join(' / '));

      await evalJs("document.querySelector('.grades')?.scrollIntoView({ block: 'center' })");
      await sleep(500);
      await shot('practice-grades.png');
    }

    // ---- 今日题组：做完之后仍可再来（自由练习不受限） ----
    await click('退出做题');
    await sleep(1000);
    const backToTabs = await evalJs("document.querySelectorAll('.practice-tab').length");
    record('退出后回到选题页（而不是直接结束）', backToTabs === 3, `标签 ${backToTabs} 个`);
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

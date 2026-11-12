/**
 * 验证「变式出题点了要有反馈」（2026-11-13）。
 *
 * ## 用户投诉
 *
 * 「变式出题还有一个问题是点击出题按钮后没有题出现，无论有没有产出都没有任何反馈。」
 * 补充：「如果是调用模型失败也要有反馈」。
 *
 * ## 根因
 *
 * 出错提示和成功提示原来只写在「用资料出题」那块表单里面，
 * 变式模式下那块根本不渲染 —— 点了「开始变式」，成功失败都一样，
 * 界面一个字都不变。
 *
 * ## 断言什么
 *
 * 三条路各断言一次（只断言「按钮能点」抓不住这个 bug）：
 *  1. 进行中：点下去后必须出现 `.gen-progress`。
 *  2. 失败：把后端 API Key 改坏 → 必须出现 `.gen-error`。
 *  3. 成功：恢复 Key（用真模型）→ 必须出现 `.gen-done`。
 *
 * 1 和 2 不用真模型（把 secrets 里的 key 换掉即可），跑得快也稳定；
 * 3 要真调一次模型，加 --real 才跑，默认跳过以免烧 token。
 *
 * 反向验证：`--app` 指向旧构建时 1 和 2 都应该 FAIL
 * （旧版变式模式下这两块根本不渲染）。
 *
 * 用法（⚠️ 会写数据，必须用副本）：
 *   node scripts/verify-variant-feedback.cjs --data .tmp/sg-data [--port 9998]
 *   node scripts/verify-variant-feedback.cjs --data .tmp/sg-data --real
 *   node scripts/verify-variant-feedback.cjs --app <旧构建目录> --data .tmp/sg-data
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  // 布尔开关：--real 后面没有值
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) return true;
  return next;
}
const APP = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA = path.resolve(ROOT, arg('data', '.tmp/sg-data'));
const PORT = Number(arg('port', '9998'));
const SHOT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/variant-feedback'));
const SLEEP_MS = Number(arg('boot-wait', '2800'));
const REAL = arg('real', false) === true;

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
    [
      `--user-data-dir=${DATA}`,
      '--no-sandbox',
      `--remote-debugging-port=${PORT}`,
      '--window-size=1440,1000',
    ],
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
      const r = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      }
      return r.result.value;
    };
    /* 按钮文字匹配一律 indexOf —— 项目里按钮常带「→」或空格，全等匹配会找不到 */
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
      /*
       * 截图前把反馈块滚进视口。
       * 第一版直接截，结果点了复选框之后页面已经滚下去了，
       * 反馈块在视口上方 —— 截出来的图里根本看不到它，
       * 等于没复核（教训：断言过了不等于图上看得见）。
       */
      await evalJs(`(() => {
        const el = document.querySelector('.gen-feedback');
        if (el) el.scrollIntoView({ block: 'center' });
        return true;
      })()`);
      await sleep(400);
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(s.data, 'base64'));
    };

    /* 走到「变式出题」模式并勾上第一道错题 —— 下面三条路径都要重复这一段 */
    const gotoVariantAndPick = async () => {
      await evalJs(`(() => {
        const groups = [...document.querySelectorAll('button.nav-group')];
        for (const g of groups) if (g.getAttribute('aria-expanded') !== 'true') g.click();
        return true;
      })()`);
      await sleep(600);
      await evalJs(`(() => {
        const hit = [...document.querySelectorAll('.nav-item__label')]
          .find(l => (l.innerText || '').trim().indexOf('错题') >= 0);
        hit?.closest('button')?.click();
        return true;
      })()`);
      await sleep(1800);
      await click('错题变式');
      await sleep(2000);
      return evalJs(`(() => {
        const boxes = [...document.querySelectorAll('.vp-item input[type="checkbox"]')];
        if (boxes.length === 0) return { ok: false, reason: '没有可勾选的错题' };
        boxes[0].click();
        return { ok: true, total: boxes.length };
      })()`);
    };

    await send('Runtime.enable');
    await sleep(SLEEP_MS);

    /* ---------- 1. 先进一次变式模式，确认入口与勾选都正常 ---------- */

    const navOk = await evalJs(`(() => {
      const groups = [...document.querySelectorAll('button.nav-group')];
      for (const g of groups) if (g.getAttribute('aria-expanded') !== 'true') g.click();
      return true;
    })()`);
    await sleep(600);
    const navHit = await evalJs(`(() => {
      const hit = [...document.querySelectorAll('.nav-item__label')]
        .find(l => (l.innerText || '').trim().indexOf('错题') >= 0);
      if (!hit) return false;
      const btn = hit.closest('button');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    record('进「错题与待巩固」页', navOk === true && navHit === true);
    await sleep(1800);

    await click('错题变式');
    await sleep(2200);

    const inVariant = await evalJs(
      `(() => (document.querySelector('.gen-mode--on .gen-mode__title')?.innerText ?? '').trim())()`,
    );
    record('点「错题变式」落在变式出题模式', inVariant === '变式出题', `当前：${inVariant}`);

    const picked = await evalJs(`(() => {
      const boxes = [...document.querySelectorAll('.vp-item input[type="checkbox"]')];
      if (boxes.length === 0) return { ok: false, reason: '没有可勾选的错题' };
      boxes[0].click();
      return { ok: true, total: boxes.length };
    })()`);
    record('变式面板里能勾选错题', picked.ok === true, JSON.stringify(picked));
    await sleep(500);

    const canStart = await evalJs(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => (x.innerText || '').indexOf('开始变式') >= 0);
      return b ? { found: true, disabled: b.disabled } : { found: false };
    })()`);
    record(
      '勾选后「开始变式」可用',
      canStart.found === true && canStart.disabled === false,
      JSON.stringify(canStart),
    );

    /* ---------- 2. 失败路径：把 API Key 改坏 ---------- */

    /*
     * 直接改 IndexedDB 的 secrets 表，比在设置页里点来点去稳。
     * 先备份原值，结束时恢复 —— 这个副本还要接着跑别的脚本。
     */
    const backupKey = await evalJs(`(() => new Promise((resolve) => {
      const req = indexedDB.open('openleaner');
      req.onsuccess = () => {
        const db = req.result;
        const all = db.transaction('secrets', 'readonly').objectStore('secrets').getAll();
        all.onsuccess = () => {
          const rec = all.result[0] || null;
          resolve(rec ? { id: rec.id, backendId: rec.backendId, value: rec.value } : null);
        };
        all.onerror = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    }))()`);
    record('读到后端 API Key（失败路径要用它改坏再恢复）', !!backupKey);

    if (backupKey) {
      await evalJs(`(() => new Promise((resolve) => {
        const req = indexedDB.open('openleaner');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('secrets', 'readwrite');
          tx.objectStore('secrets').put({ ...${JSON.stringify(backupKey)}, value: 'sk-invalid-for-feedback-test' });
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        };
        req.onerror = () => resolve(false);
      }))()`);
      /* 后端列表在内存里缓存了凭据与否，刷新一次让它重新读 */
      await send('Page.reload');
      await sleep(SLEEP_MS + 1200);

      const repicked = await gotoVariantAndPick();
      record('刷新后重新走到变式模式并勾上题', repicked.ok === true, JSON.stringify(repicked));
      await sleep(400);

      await click('开始变式');

      /*
       * 轮询等错误出现。Key 无效是立刻返回 401，20 秒足够。
       * 同时记「中途有没有出现过进行中提示」——这正是原来缺的那一块。
       */
      let sawProgress = false;
      let errText = '';
      for (let i = 0; i < 80; i++) {
        const st = await evalJs(`(() => ({
          progress: !!document.querySelector('.gen-progress'),
          error: (document.querySelector('.gen-error')?.innerText ?? '').trim(),
        }))()`);
        if (st.progress) sawProgress = true;
        if (st.error) {
          errText = st.error;
          break;
        }
        await sleep(250);
      }

      record('变式出题进行中能看见「正在等模型回话…」', sawProgress === true);
      record('模型调用失败时界面给出错误提示', errText.length > 0, errText.slice(0, 160));
      const hint = await evalJs(
        `(() => (document.querySelector('.gen-error__hint')?.innerText ?? '').trim())()`,
      );
      console.log(`     错误提示带的下一步建议：${hint ? hint.slice(0, 120) : '（无）'}`);
      await shot('variant-error.png');

      /* 恢复 Key */
      await evalJs(`(() => new Promise((resolve) => {
        const req = indexedDB.open('openleaner');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('secrets', 'readwrite');
          tx.objectStore('secrets').put(${JSON.stringify(backupKey)});
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        };
        req.onerror = () => resolve(false);
      }))()`);
      await send('Page.reload');
      await sleep(SLEEP_MS + 1200);
    }

    /* ---------- 3. 成功路径（默认跳过，加 --real 才跑真模型） ---------- */

    if (REAL) {
      const repicked = await gotoVariantAndPick();
      record('（真模型）重新走到变式模式并勾上题', repicked.ok === true, JSON.stringify(repicked));
      await sleep(400);
      await click('开始变式');

      let doneText = '';
      let sawProgress = false;
      let errText = '';
      for (let i = 0; i < 300; i++) {
        const st = await evalJs(`(() => ({
          progress: !!document.querySelector('.gen-progress'),
          done: (document.querySelector('.gen-done')?.innerText ?? '').trim(),
          error: (document.querySelector('.gen-error')?.innerText ?? '').trim(),
        }))()`);
        if (st.progress) sawProgress = true;
        if (st.error) {
          errText = st.error;
          break;
        }
        if (st.done) {
          doneText = st.done;
          break;
        }
        await sleep(500);
      }
      record('（真模型）出题成功后没报错', errText.length === 0, errText.slice(0, 160));
      record('（真模型）进行中能看到进度', sawProgress === true);
      record('（真模型）出题成功后看到结果卡片', doneText.length > 0, doneText.slice(0, 200));
      await shot('variant-done.png');

      /*
       * 结果卡片上那个「去看这 N 道题」也必须真的能跳 ——
       * 用户投诉的就是「点了没反应」，只断言按钮画出来是不够的。
       */
      if (doneText.length > 0) {
        const jumped = await click('去看这');
        await sleep(2500);
        const where = await evalJs(`(() => {
          const open = document.querySelector('.deck-card--open .deck-card__title, .deck-detail__title');
          const head = (document.querySelector('.decks-page__head, .page-title, h1')?.innerText ?? '').trim();
          return { open: (open?.innerText ?? '').trim(), head: head.slice(0, 60) };
        })()`);
        record(
          '（真模型）「去看这 N 道题」真的跳到了题库并展开该组',
          jumped === true && (where.open.length > 0 || where.head.indexOf('题组') >= 0),
          JSON.stringify(where),
        );
        await shot('variant-jump.png');
      }
    } else {
      console.log('SKIP  （真模型）成功路径 —— 加 --real 才跑，避免烧 token');
    }
  } catch (err) {
    record('脚本执行', false, err instanceof Error ? err.message : String(err));
    code = 1;
  } finally {
    try {
      app.kill();
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed / ${failed} failed`);
  process.exit(failed > 0 ? 1 : code);
})();

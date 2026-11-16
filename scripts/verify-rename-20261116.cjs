/**
 * 验证 2026-11-16 的两处改动（改名 + 删未做功能）。
 *
 * 用户要求：
 *  1. 功能导览界面和资料库界面，没有做的功能「无论是描述还是按钮都删掉」
 *  2. 全项目 OpenLeaner → Open Learner（软件内文本与 GitHub 描述）
 *
 * ## 为什么还要单独写这个脚本（已经有单测和截图了）
 *
 * 单测测的是模块；截图只能看到**首屏**。这三件事都只有跑起来才知道：
 *  - 侧栏「课程准备与管理」组默认折叠 → 收起时那些项**根本不在 DOM 里**，
 *    截图看不到它们到底删没删（硬约束 17）
 *  - 功能导览的第二屏（没有侧栏入口 / 几条要点）在首屏之外
 *  - 「还没做」「缺条件」这两块是按 `ready !== true` 推导出来的：
 *    只要有人给某页加了 `ready: false`，它们会**自己长回来**
 *
 * ## 否定断言（这一节是重点）
 *
 * 只断言「页面能打开、有内容」对坏实现同样成立 —— 那是假验证。
 * 这里钉的是「**不许出现**」：删掉的东西一个都不许回来。
 * 反向验证：拿改名前的 asar（.tmp/desktop-asar-backup/ 里那份）跑，
 * 第 3、4 组必须挂。
 *
 * 用法：
 *   node scripts/verify-rename-20261116.cjs --app release/win-unpacked \
 *        --data <隔离副本> --out .verify-shots/rename-20261116
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
const DATA_DIR = path.resolve(ROOT, arg('data', '.tmp/shot-data'));
const PORT = Number(arg('port', '9981'));
const OUT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/rename-20261116'));

const APP_EXE = path.join(APP_DIR, 'OpenLeaner.exe');
if (!fs.existsSync(APP_EXE)) {
  console.error(`找不到打包产物: ${APP_EXE}`);
  process.exit(2);
}
if (!fs.existsSync(DATA_DIR)) {
  console.error(`数据目录不存在: ${DATA_DIR}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 表格式结果，最后统一打印 —— 中途打印容易在失败时看不到全貌 */
const results = [];
function rec(name, pass, detail = '') {
  results.push({ name, pass: pass === true, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let app = null;
  try {
    app = spawn(
      APP_EXE,
      [
        `--user-data-dir=${DATA_DIR}`,
        '--no-sandbox',
        `--remote-debugging-port=${PORT}`,
        '--window-size=1440,900',
      ],
      { stdio: 'ignore' },
    );

    let page = null;
    for (let i = 0; i < 120; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find(
          (t) => t.type === 'page' && t.webSocketDebuggerUrl && typeof t.url === 'string' && t.url.indexOf('file://') === 0,
        );
        if (page) break;
      } catch {
        /* 还没起来 */
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
            reject(new Error(`CDP 超时: ${method}`));
          }
        }, 30000);
      });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const shot = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), Buffer.from(r.data, 'base64'));
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(4000);

    /* ---------- 1. 品牌名 ---------- */
    const brand = await evalJs(`(() => {
      const el = document.querySelector('.brand__name');
      const crumb = document.querySelector('.topbar__crumb');
      return {
        brand: el ? el.innerText.trim() : null,
        crumb: crumb ? crumb.innerText.trim() : null,
        docTitle: document.title,
      };
    })()`);
    rec('侧栏品牌是 Open Learner', brand.brand === 'Open Learner', `brand="${brand.brand}"`);
    rec(
      '顶栏面包屑是 Open Learner',
      typeof brand.crumb === 'string' && brand.crumb.indexOf('Open Learner') === 0,
      `crumb="${brand.crumb}"`,
    );
    rec(
      '窗口标题是 Open Learner',
      typeof brand.docTitle === 'string' && brand.docTitle.indexOf('Open Learner') === 0,
      `title="${brand.docTitle}"`,
    );

    /*
     * 否定断言：界面上不许再有旧品牌。
     * 用 indexOf 而不是 ===：正文里还有别的字，全等永远不成立。
     */
    const bodyText = await evalJs('document.body.innerText');
    rec('界面正文里没有旧品牌 OpenLeaner', bodyText.indexOf('OpenLeaner') < 0);

    /* ---------- 2. 侧栏：展开所有分组后看全部项 ---------- */
    const navLabels = await evalJs(`(() => {
      for (const g of [...document.querySelectorAll('.nav-group')]) {
        if (g.getAttribute('aria-expanded') !== 'true') g.click();
      }
      return null;
    })()`);
    void navLabels;
    await sleep(800);
    const labels = await evalJs(
      `[...document.querySelectorAll('.nav-item__label')].map(el => el.innerText.trim())`,
    );
    console.log(`  侧栏 ${labels.length} 项: ${labels.join(' / ')}`);

    for (const gone of ['音频转写', '课堂实录', '备考补习']) {
      rec(`侧栏不再有「${gone}」`, labels.indexOf(gone) < 0);
    }

    /* ---------- 3. 功能导览：不该再有「还没做」「缺条件」 ---------- */
    await evalJs(`(() => {
      for (const b of [...document.querySelectorAll('.nav-item')]) {
        const t = b.innerText.trim();
        if (t.indexOf('功能导览') >= 0) { b.click(); return true; }
      }
      return false;
    })()`);
    await sleep(1500);

    const guide = await evalJs(`(() => {
      const page = document.querySelector('.guide-page');
      const txt = page ? page.innerText : '';
      return {
        present: !!page,
        hasPendingHeading: txt.indexOf('还没做') >= 0,
        hasShelvedHeading: txt.indexOf('缺条件') >= 0,
        hasShelvedTitle: txt.indexOf('现在没做，也没放进侧栏') >= 0,
        hasShelvedBody: txt.indexOf('差一个外部条件') >= 0,
        statText: (document.querySelector('.gd-stats') || {}).innerText || '',
        itemCount: document.querySelectorAll('.gd-item').length,
      };
    })()`);

    rec('功能导览页打开', guide.present === true);
    /* 这三条是否定断言 —— 对改动前的实现必然失败 */
    rec('导览里没有「还没做」字样', guide.hasPendingHeading === false);
    rec('导览里没有「缺条件」徽标', guide.hasShelvedHeading === false);
    rec('导览里没有「现在没做，也没放进侧栏」整块', guide.hasShelvedTitle === false);
    rec('导览里没有「差一个外部条件」说明', guide.hasShelvedBody === false);
    rec(
      '概览只剩「项现在能用」一个数字',
      guide.statText.indexOf('还没做') < 0 && guide.statText.indexOf('现在能用') >= 0,
      guide.statText.replace(/\s+/g, ' ').trim(),
    );
    rec('导览列出了条目', guide.itemCount > 10, `${guide.itemCount} 项`);

    /* 首屏 + 滚到底各一张，肉眼复核用 */
    await shot('guide-top');
    await evalJs(`(() => {
      const s = document.querySelector('.shell__main') || document.scrollingElement;
      if (s) s.scrollTop = s.scrollHeight;
      return true;
    })()`);
    await sleep(600);
    await shot('guide-bottom');
    const guideBottomText = await evalJs(`(() => {
      const page = document.querySelector('.guide-page');
      return page ? page.innerText : '';
    })()`);
    rec('导览底部也没有「还没做」字样', guideBottomText.indexOf('还没做') < 0);

    /* ---------- 4. 资料页：只剩两个标签 ---------- */
    await evalJs(`(() => {
      for (const b of [...document.querySelectorAll('.nav-item')]) {
        const t = b.innerText.trim();
        if (t.indexOf('资料') >= 0 && t.indexOf('资料解析') < 0) { b.click(); return true; }
      }
      return false;
    })()`);
    await sleep(1500);

    const tabs = await evalJs(
      `[...document.querySelectorAll('.sources-tab')].map(el => el.innerText.trim())`,
    );
    console.log(`  资料页标签: ${tabs.join(' / ')}`);
    rec('资料页只有两个标签', tabs.length === 2, `${tabs.length} 个`);
    rec('没有「音频 / 录音」标签', tabs.every((t) => t.indexOf('音频') < 0));
    rec('仍有「文件」与「粘贴文本」', tabs.indexOf('文件') >= 0 && tabs.indexOf('粘贴文本') >= 0);

    const srcText = await evalJs(`(() => {
      const p = document.querySelector('.sources-page');
      return p ? p.innerText : '';
    })()`);
    rec('资料页正文没有「音频转写还在做」', srcText.indexOf('音频转写') < 0);
    rec('空态文案不再提「录音」', srcText.indexOf('录音') < 0);
    await shot('sources-tabs');

    /* ---------- 汇总 ---------- */
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} 通过`);
    if (failed.length > 0) {
      console.log('\n失败项：');
      for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? `  — ${f.detail}` : ''}`);
      process.exitCode = 1;
    }
    console.log(`截图: ${path.relative(ROOT, OUT_DIR)}`);
  } catch (e) {
    console.error('脚本自身出错:', e.message);
    process.exitCode = 2;
  } finally {
    if (app) {
      try {
        app.kill();
      } catch {
        /* 忽略 */
      }
      await sleep(500);
    }
  }
})();

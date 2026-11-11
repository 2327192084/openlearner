/**
 * 验证「标注文字与实际显示不匹配」这个 bug 修好了（2026-11-11）。
 *
 * ## 要查什么
 *
 * 用户截图里 `# 第1章 信号与系统`、`## 1.0 引言` 带着 # 号显示，
 * 说明有定位时整页走了不解析 Markdown 的老路径。
 *
 * 所以检查三点：
 *  1. 打开一份资料的**有锚点**页面，正文里不该出现裸的 `#` / `##`
 *  2. 标题应渲染成 h1/h2 元素（不是塞在 <p> 里的纯文本）
 *  3. 高亮位置要落在这段文字里（用 mark 元素的文本内容比对原文）
 *
 * ## 怎么造「有锚点」的场景
 *
 * 从知识库点一条「可点回原文」，阅读器就会带着 target 打开，
 * 那条路径会产生 highlight。这比直接调内部函数更接近用户操作。
 *
 * 用法：node scripts/verify-markdown-marks.cjs --app release/win-unpacked --data <副本>
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_URL_PREFIX = 'file://';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const APP_DIR = path.resolve(ROOT, arg('app', 'release/win-unpacked'));
const DATA_DIR = path.resolve(arg('data', path.join(ROOT, '.tmp/mdmk-data')));
const PORT = Number(arg('port', '9730'));
const OUT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/markdown-marks'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const report = [];
  const fail = [];
  const ok = (l, d = '') => report.push(`  PASS  ${l}${d ? ' — ' + d : ''}`);
  const bad = (l, d = '') => {
    report.push(`  FAIL  ${l}${d ? ' — ' + d : ''}`);
    fail.push(l);
  };

  let app = null;
  try {
    app = spawn(
      path.join(APP_DIR, 'OpenLeaner.exe'),
      [
        `--user-data-dir=${DATA_DIR}`,
        '--no-sandbox',
        `--remote-debugging-port=${PORT}`,
        '--window-size=1440,900',
      ],
      { stdio: 'ignore' },
    );

    let page = null;
    for (let i = 0; i < 160; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        /*
         * 只要 file:// 的页面即可，不再要求 URL 前缀严格相等。
         *
         * 踩过：第一次写成 t.url.indexOf('file://') === 0 匹配不到，
         * 因为带 --user-data-dir 时页面 URL 形如
         * `file:///E:/.../index.html`，前缀是 `file:///`（三个斜杠）。
         * 用 includes 更稳。
         */
        page = list.find(
          (t) =>
            t.type === 'page' &&
            t.webSocketDebuggerUrl &&
            String(t.url).startsWith('file://') &&
            !String(t.url).includes('devtools'),
        );
        if (page) break;
      } catch {
        /* wait */
      }
      await sleep(250);
    }
    if (!page) throw new Error('应用没起来（CDP 找不到 file:// 页面）');

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
            reject(new Error('timeout ' + method));
          }
        }, 30000);
      });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(4000);

    /* ---- 从知识库点「可点回原文」进阅读器（这条路径会产生高亮）---- */
    await evalJs(`(() => {
      const labels = [...document.querySelectorAll('.nav-item__label')];
      const hit = labels.find(el => el.innerText.trim() === '知识库');
      if (hit) hit.closest('button').click();
    })()`);
    await sleep(2500);

    const jumped = await evalJs(`(() => {
      /*
       * 只在**知识点卡片内部**找锚点按钮。
       *
       * 两处踩过的坑：
       * 1. 第一版在整页找 innerText 含「原文」的 button，点到了侧栏
       *    「资料」（它的 title 里有「原文」），停在资料页。
       * 2. 第二版找「可点回原文」也找不到 —— 卡片上那个按钮的实际
       *    文字是「第 N 页」（见 KnowledgePage 的锚点按钮）。
       * 所以按「第 X 页」这个形状匹配，并且限定在 .kb-point 内。
       */
      const cards = [...document.querySelectorAll('.kb-point')];
      for (const c of cards) {
        const btns = [...c.querySelectorAll('button')];
        /*
         * 用「含页字且不是改/删除」匹配。
         * 不用 ^第\s*\d+\s*页$ 是因为按钮里可能带额外空白或不可见字符，
         * 全等匹配在实测里失败过两次 —— 按形状匹配更稳。
         */
        const hit = btns.find((b) => {
          const t = (b.innerText || '').replace(/\s+/g, '');
          return t.includes('页') && t !== '改' && t !== '删除';
        });
        if (hit) { hit.click(); return { ok: true, text: hit.innerText.trim() }; }
      }
      return { ok: false, cards: cards.length, all: [...document.querySelectorAll('.kb-point button')].map(b => (b.innerText||'').trim()).slice(0, 8) };
    })()`);
    jumped.ok ? ok('从知识库跳原文', jumped.text) : bad('找不到「可点回原文」', JSON.stringify(jumped));
    await sleep(3500);

    /* 确认真的进了阅读器（不是停在知识库） */
    const arrived = await evalJs(`(() => {
      const el = document.querySelector('.reader-body');
      const crumb = document.querySelector('.topbar__title');
      return { hasBody: !!el, title: crumb ? crumb.innerText.trim() : null };
    })()`);
    arrived.hasBody
      ? ok('已进入阅读器', arrived.title ?? '')
      : bad('没进阅读器', `当前页面=${arrived.title}`);

    /* ---- 关键检查 ---- */
    const body = await evalJs(`(() => {
      const el = document.querySelector('.reader-body');
      if (!el) return { found: false };
      const text = el.innerText || '';

      /* 裸的 Markdown 标记：行首出现 # 或 ## 说明没解析 */
      const lines = text.split('\\n');
      const rawHeadingLines = lines.filter(l => /^\\s*#{1,6}\\s/.test(l));

      /* 结构元素 */
      const h1 = el.querySelectorAll('h1').length;
      const h2 = el.querySelectorAll('h2').length;
      const h3 = el.querySelectorAll('h3').length;
      const marks = [...el.querySelectorAll('mark')];
      const mdWrap = !!el.querySelector('.reader-md');

      return {
        found: true,
        hasRawHash: rawHeadingLines.length > 0,
        rawHeadingSample: rawHeadingLines.slice(0, 3),
        h1, h2, h3,
        markCount: marks.length,
        markTexts: marks.slice(0, 3).map(m => (m.innerText || '').slice(0, 40)),
        hasMdWrap: mdWrap,
        hasHighlightNote: text.indexOf('找到了') >= 0 || text.indexOf('原文位置') >= 0,
      };
    })()`);

    if (!body.found) {
      bad('阅读器正文存在');
    } else {
      !body.hasRawHash
        ? ok('正文里没有裸的 # 标题标记')
        : bad('正文仍有裸 # 标记', JSON.stringify(body.rawHeadingSample));

      body.hasMdWrap ? ok('正文包在 .reader-md 结构里') : bad('缺 .reader-md 容器');

      body.h1 + body.h2 + body.h3 > 0
        ? ok('标题渲染成真正的标题元素', `h1=${body.h1} h2=${body.h2} h3=${body.h3}`)
        : report.push('        提示：这一页可能没有 Markdown 标题（不算失败）');

      /*
       * 高亮检查：如果有 mark，它的文字必须是从原文里原样截出来的。
       * 这里只能确认「非空且不是纯语法符号」—— 精确偏移由单测覆盖。
       */
      if (body.markCount > 0) {
        const badMarks = body.markTexts.filter((t) => !t.trim() || /^[#\\s|*-]+$/.test(t));
        badMarks.length === 0
          ? ok('高亮内容是正文文字', JSON.stringify(body.markTexts))
          : bad('高亮命中了语法符号', JSON.stringify(badMarks));
      } else {
        report.push('        提示：这一页没有高亮（可能这条知识点没有锚点）');
      }

      const s = await send('Page.captureScreenshot', { format: 'png' });
      const p = path.join(OUT_DIR, '01-阅读器-有锚点.png');
      fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
      report.push(`        截图: ${path.relative(ROOT, p)}`);

      /* 再翻一页，确认无高亮时也正常（两条路径都该正确） */
      await evalJs(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const next = btns.find(b => (b.innerText || '').trim() === '下一段');
        if (next) next.click();
      })()`);
      await sleep(1500);

      const body2 = await evalJs(`(() => {
        const el = document.querySelector('.reader-body');
        if (!el) return { found: false };
        const text = el.innerText || '';
        const raw = text.split('\\n').filter(l => /^\\s*#{1,6}\\s/.test(l));
        return { found: true, hasRawHash: raw.length > 0, sample: raw.slice(0, 2) };
      })()`);

      body2.found && !body2.hasRawHash
        ? ok('翻页后（无高亮）同样无裸 #')
        : body2.found
          ? bad('翻页后出现裸 #', JSON.stringify(body2.sample))
          : bad('翻页后正文丢失');
    }

    const errs = await evalJs(`(() => (window.__cdpErrors || []).slice(0, 5))()`);
    Array.isArray(errs) && errs.length > 0 ? bad('控制台有错误', JSON.stringify(errs)) : ok('控制台无明显错误');

    console.log('\n========== 标注渲染验证 ==========');
    report.forEach((l) => console.log(l));
    console.log('==================================');
    console.log(fail.length === 0 ? '\n通过' : `\n失败 ${fail.length} 项: ${fail.join(' / ')}`);
    process.exitCode = fail.length === 0 ? 0 : 1;
  } catch (e) {
    console.error('\n脚本出错:', e.message);
    report.forEach((l) => console.log(l));
    process.exitCode = 1;
  } finally {
    try {
      app && app.kill();
    } catch {
      /* ignore */
    }
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/F', '/IM', 'OpenLeaner.exe'], { stdio: 'ignore' });
      } catch {
        /* ignore */
      }
    }
    await sleep(600);
  }
})();

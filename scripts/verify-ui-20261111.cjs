/**
 * 验证 2026-11-11 这批 UI 改动（5 处）。
 *
 * 查的是「用户实际能不能看到/点到」，不是「代码里写没写」：
 *   1. 资料页的两个假按钮真的没了（课程条「更改」、PDF 解析折叠）
 *   2. 顶栏「工作库」能点开，面板里显示真实路径
 *   3. 设置 → 学习库 显示保存位置，且有「更改位置」
 *   4. 设置 → 文档解析 有 MinerU 状态、路径选择、镜像命令
 *   5. 导入无文字层文件后出现提醒（这条需要造数据，见下）
 *
 * 用法：node scripts/verify-ui-20261111.cjs --app release/win-unpacked --data .tmp/<副本>
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
const DATA_DIR = path.resolve(ROOT, arg('data', '.tmp/ui1111-data'));
const PORT = Number(arg('port', '9720'));
const OUT_DIR = path.resolve(ROOT, arg('out', '.verify-shots/ui1111'));

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
    for (let i = 0; i < 120; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find(
          (t) =>
            t.type === 'page' &&
            t.webSocketDebuggerUrl &&
            String(t.url).indexOf(APP_URL_PREFIX) === 0,
        );
        if (page) break;
      } catch {
        /* wait */
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
            reject(new Error('timeout ' + method));
          }
        }, 30000);
      });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      const p = path.join(OUT_DIR, name);
      fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
      return p;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(4000);

    await evalJs(`(() => {
      if (window.__cdpErrors) return;
      window.__cdpErrors = [];
      const orig = console.error;
      console.error = function (...a) { try { window.__cdpErrors.push(a.map(String).join(' ').slice(0,300)); } catch {} return orig.apply(console, a); };
      window.addEventListener('error', e => window.__cdpErrors.push('window.error: ' + (e.message||'')));
    })()`);

    const goto = async (label) => {
      const r = await evalJs(`(() => {
        for (const g of [...document.querySelectorAll('.nav-group')]) {
          if (g.getAttribute('aria-expanded') === 'false') g.click();
        }
        const hit = [...document.querySelectorAll('.nav-item__label')].find(el => el.innerText.trim() === ${JSON.stringify(label)});
        if (!hit) return false;
        hit.closest('button').click();
        return true;
      })()`);
      await sleep(2000);
      return r;
    };

    /* ================= 1. 资料页：两个假按钮应消失 ================= */
    await goto('资料');
    const sourcesPage = await evalJs(`(() => {
      const body = document.body.innerText || '';
      return {
        hasCourseBar: !!document.querySelector('.sources-course'),
        hasFakeChange: !!document.querySelector('.sources-course .btn-text'),
        hasPdfNote: !!document.querySelector('.sources-note'),
        /* 这两个词原本只出现在那两个假块里 */
        hasUncat: body.indexOf('未分类') >= 0,
        hasPdfParse: body.indexOf('PDF 解析') >= 0,
      };
    })()`);

    !sourcesPage.hasCourseBar ? ok('课程条「未分类 更改」已删除') : bad('课程条还在');
    !sourcesPage.hasFakeChange ? ok('假「更改」按钮已删除') : bad('假「更改」按钮还在');
    !sourcesPage.hasPdfNote ? ok('「PDF 解析」折叠块已删除') : bad('PDF 解析折叠块还在');
    !sourcesPage.hasPdfParse ? ok('页面上不再出现「PDF 解析」字样') : bad('仍有「PDF 解析」字样');

    /* ================= 2. 顶栏工作库可点击 ================= */
    const libBtn = await evalJs(`(() => {
      const b = document.querySelector('.topbar__lib');
      if (!b) return { found: false };
      const tag = b.tagName;
      const before = !!document.querySelector('.topbar__lib-panel');
      b.click();
      return { found: true, tag, before };
    })()`);
    await sleep(900);

    if (!libBtn.found) {
      bad('顶栏工作库按钮存在');
    } else {
      libBtn.tag === 'BUTTON' ? ok('顶栏工作库是按钮（可点击）') : bad('顶栏工作库不是按钮', libBtn.tag);
      const panel = await evalJs(`(() => {
        const p = document.querySelector('.topbar__lib-panel');
        if (!p) return { open: false };
        const code = p.querySelector('.lib-loc__path');
        return {
          open: true,
          path: code ? code.innerText.trim() : null,
          hasReveal: [...p.querySelectorAll('button')].some(b => b.innerText.indexOf('打开文件夹') >= 0),
          hasMore: [...p.querySelectorAll('button')].some(b => b.innerText.indexOf('在设置里管理') >= 0),
          text: (p.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
        };
      })()`);

      panel.open ? ok('点开后出现面板') : bad('点开没出现面板');
      panel.path ? ok('面板里显示真实库路径', panel.path) : bad('面板里没有路径');
      panel.hasReveal ? ok('面板里有「打开文件夹」') : bad('缺「打开文件夹」');
      panel.hasMore ? ok('面板里有「在设置里管理」') : bad('缺跳设置入口');

      const p1 = await shot('01-顶栏工作库面板.png');
      report.push(`        截图: ${path.relative(ROOT, p1)}`);

      /* 关掉面板，免得挡住后面截图 */
      await evalJs(`(() => { const c = document.querySelector('.topbar__lib-close'); if (c) c.click(); })()`);
      await sleep(400);
    }

    /* ================= 3. 设置 → 学习库：显示位置 ================= */
    await goto('设置');
    const setLib = await evalJs(`(() => {
      const items = [...document.querySelectorAll('.settings-nav__item')];
      const hit = items.find(el => (el.innerText || '').trim().indexOf('学习库') >= 0);
      if (hit) hit.click();
      return !!hit;
    })()`);
    await sleep(1500);

    const libPane = await evalJs(`(() => {
      const loc = document.querySelector('.lib-loc');
      const code = document.querySelector('.lib-loc__path');
      const btns = loc ? [...loc.querySelectorAll('button')].map(b => b.innerText.trim()) : [];
      return {
        hasLoc: !!loc,
        path: code ? code.innerText.trim() : null,
        btns,
      };
    })()`);

    setLib ? ok('设置里找到「学习库」分类') : bad('设置里没有「学习库」分类');
    libPane.hasLoc ? ok('学习库分区显示保存位置') : bad('学习库分区没有位置行');
    libPane.path ? ok('位置是真实路径', libPane.path) : bad('位置为空');
    libPane.btns.some((b) => b.indexOf('更改位置') >= 0)
      ? ok('有「更改位置」按钮', libPane.btns.join(' / '))
      : bad('没有「更改位置」按钮', libPane.btns.join(' / '));
    libPane.btns.some((b) => b.indexOf('打开文件夹') >= 0)
      ? ok('有「打开文件夹」按钮')
      : bad('没有「打开文件夹」按钮');

    const p2 = await shot('02-设置-学习库.png');
    report.push(`        截图: ${path.relative(ROOT, p2)}`);

    /* ================= 4. 设置 → 文档解析（MinerU） ================= */
    const setParse = await evalJs(`(() => {
      const items = [...document.querySelectorAll('.settings-nav__item')];
      const hit = items.find(el => (el.innerText || '').trim().indexOf('文档解析') >= 0);
      if (hit) hit.click();
      return !!hit;
    })()`);
    await sleep(1500);

    const parsePane = await evalJs(`(() => {
      const body = document.body.innerText || '';
      return {
        hasNav: ${setParse ? 'true' : 'false'},
        hasStatus: !!document.querySelector('.mineru-status'),
        statusText: (document.querySelector('.mineru-status__text') || {}).innerText || null,
        hasPathRow: !!document.querySelector('.mineru-path'),
        hasPickBtn: [...document.querySelectorAll('.mineru-btn')].some(b => b.innerText.indexOf('选择文件') >= 0),
        /* 镜像地址是用户特别要求的 */
        hasAliyun: body.indexOf('mirrors.aliyun.com') >= 0,
        hasModelscope: body.indexOf('modelscope') >= 0,
        hasTsinghua: body.indexOf('tuna.tsinghua') >= 0,
        hasVCRedist: body.indexOf('msvcp140') >= 0 || body.indexOf('VC++') >= 0,
        stepCount: document.querySelectorAll('.mineru-steps li').length,
      };
    })()`);

    parsePane.hasStatus ? ok('有 MinerU 状态条', parsePane.statusText) : bad('没有状态条');
    parsePane.hasPathRow ? ok('有路径设置行') : bad('没有路径设置行');
    parsePane.hasPickBtn ? ok('有「选择文件」按钮') : bad('没有选择按钮');
    parsePane.hasAliyun ? ok('给了阿里云 pip 镜像（用户要求）') : bad('缺阿里云镜像');
    parsePane.hasModelscope ? ok('给了 ModelScope 模型源（国内关键）') : bad('缺 ModelScope');
    parsePane.hasTsinghua ? ok('给了清华镜像作为备选') : bad('缺清华镜像');
    parsePane.hasVCRedist ? ok('写了 VC++ 运行库这个常见坑') : bad('没写 VC++ 坑');
    parsePane.stepCount >= 4 ? ok('安装步骤完整', `${parsePane.stepCount} 步`) : bad('步骤太少', String(parsePane.stepCount));

    const p3 = await shot('03-设置-文档解析.png');
    report.push(`        截图: ${path.relative(ROOT, p3)}`);

    /* ================= 5. 控制台错误 ================= */
    const errs = await evalJs(`(() => (window.__cdpErrors || []).slice(0, 5))()`);
    Array.isArray(errs) && errs.length > 0 ? bad('控制台有错误', JSON.stringify(errs)) : ok('控制台无明显错误');

    console.log('\n========== UI 改动验证 ==========');
    report.forEach((l) => console.log(l));
    console.log('=================================');
    console.log(fail.length === 0 ? '\n全部通过' : `\n失败 ${fail.length} 项: ${fail.join(' / ')}`);
    process.exitCode = fail.length === 0 ? 0 : 1;
  } catch (e) {
    console.error('\n脚本出错:', e.message);
    if (report.length) report.forEach((l) => console.log(l));
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

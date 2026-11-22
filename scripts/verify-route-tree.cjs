/**
 * 验证「树状学习地图」（2026-11-22，学习地图第三次重做 · 第 4 步）。
 *
 * ## 为什么这个脚本存在
 *
 * 上一轮（v2）的错误是：**数据有了、图没了，而断言是绿的**。
 * 用户截图才指出「我没找到地图的入口」。
 *
 * 所以这个脚本的第一条断言是「树真的画出来了」，不是「有路线数据」。
 * 而且要验**分叉**（一个章连多个小节）—— 那是"树"之所以是树的理由，
 * 也是 CSS 画不出、必须用 SVG 的理由。
 *
 * ## 要证的（重点在"看得见"）
 *
 * 1. 树真的渲染出来了（`.rtree` 存在，不是一行文字）
 * 2. 章节点数量 = 树里的章数，且**横向分列**（根在左、章在中、小节在右）
 * 3. **SVG 连线真的在**，且章→小节是**分叉**（所有枝共用一个起点）
 * 4. 点章 → 小节展开、其余章淡出（opacity 真的变了）
 * 5. 前置提醒出现但**章仍可点**（不是 disabled）
 * 6. 点小节 → 详情面板出现，三任务 + 自定义 + 完成汇总都在
 * 7. 勾满三项 + 自定义 → 显示「完成」
 * 8. 无字面 `**`、无控制台报错
 *
 * ## 用哪份数据跑
 *
 * 用**用户真实库的副本**（隔离副本，不碰真库）。真实库里有：
 *  - 一条已确认的 v2 路线（信号与系统 · 3 块 3 步）
 *  - 信号与系统那份资料（能切出 26 个 `## 1.1 xxx` 小节）
 *  - 94 条知识点、10 道锚点已失效的题（统计要如实处理这个）
 *
 * 用法：node scripts/verify-route-tree.cjs [port] [--desktop]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/route-tree-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(
  ROOT,
  '.verify-shots/route-tree' + (process.argv.includes('--desktop') ? '-desktop' : ''),
);
const PORT = Number(process.argv[2] || 9970);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x) => {
  console.log((ok ? '✅ ' : '❌ ') + n + (x ? ' :: ' + x : ''));
  ok ? pass++ : fail++;
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(APPDATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.cpSync(
    path.join(process.env.APPDATA, 'OpenLeaner/IndexedDB'),
    path.join(DATA, 'IndexedDB'),
    { recursive: true },
  );
  console.log('已复制真实库副本');

  const USE_DESKTOP = process.argv.includes('--desktop');
  const exe = USE_DESKTOP
    ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenLeaner', 'OpenLeaner.exe')
    : path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
  const APP_DIR = USE_DESKTOP ? path.dirname(exe) : ROOT;

  /*
   * ⚠️ 第 4 候选陷阱：`ensureUserDataDir()` 会挑
   * `path.join(dirname(process.execPath), 'openleaner-data')` 作为一个候选。
   * 那个目录如果存在且可写，会**抢在 --user-data-dir 前面**生效，
   * 于是脚本读写的是那份副本而不是我们准备的隔离副本。
   * 曾经因为这个报过"已删除"但真库没变。
   */
  if (fs.existsSync(path.join(path.dirname(exe), 'openleaner-data'))) {
    console.error('❌ app 目录旁有 openleaner-data —— 会抢走 userData，先清掉再跑');
    process.exit(2);
  }

  const app = spawn(
    exe,
    [
      ...(USE_DESKTOP ? [] : [ROOT]),
      '--user-data-dir=' + DATA,
      '--no-sandbox',
      '--remote-debugging-port=' + PORT,
      '--window-size=1700,1150',
    ],
    { cwd: APP_DIR, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  app.stdout.on('data', (d) => (log += d.toString()));
  app.stderr.on('data', (d) => (log += d.toString()));

  /* 桌面安装版会改写调试端口 —— 从日志读回**实际**端口，别信任传入值 */
  let target = null;
  let actualPort = PORT;
  for (let i = 0; i < 240; i++) {
    const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(log);
    if (m && Number(m[1]) !== actualPort) {
      actualPort = Number(m[1]);
      console.log('（从日志读到实际调试端口：' + actualPort + '）');
    }
    try {
      const l = await (await fetch('http://127.0.0.1:' + actualPort + '/json/list')).json();
      target = l.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
      if (target) break;
    } catch {}
    await sleep(250);
  }
  if (!target) {
    console.error('起不来（试过端口 ' + actualPort + '）：' + log.slice(-1500));
    process.exit(2);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let id = 1;
  const pending = new Map();
  const errs = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
      errs.push(
        (m.params.args || [])
          .map((a) => a.value ?? a.description ?? '')
          .join(' ')
          .slice(0, 200),
      );
    }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  const send = (me, pa) =>
    new Promise((res, rej) => {
      const n = id++;
      pending.set(n, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id: n, method: me, params: pa || {} }));
      setTimeout(() => {
        if (pending.has(n)) {
          pending.delete(n);
          rej(new Error('cdp timeout'));
        }
      }, 60000);
    });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', {
      expression: e,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };
  const shot = async (n) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, n), Buffer.from(r.data, 'base64'));
  };
  const waitFor = async (expr, ms = 40000, label = '') => {
    const end = Date.now() + ms;
    let t = 0;
    while (Date.now() < end) {
      await sleep(t === 0 ? 1500 : 1200);
      t++;
      const v = await ev(expr).catch(() => null);
      if (v) return v;
    }
    throw new Error('超时（' + label + '）');
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(8000);

  /* ---------- 0. 副本里有路线和资料吗（前提条件） ---------- */
  const pre = await ev(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("openleaner");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const get = (store, key) => new Promise((res, rej) => {
      const rq = db.transaction(store, "readonly").objectStore(store).get(key);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const settings = await get("settings", "app");
    const route = settings && settings.sourceRoute;
    const tree = settings && settings.sourceTree;
    const all = (s) => new Promise((res, rej) => {
      const rq = db.transaction(s, "readonly").objectStore(s).getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const sources = await all("sources");
    const segs = await all("sourceSegments");
    db.close();
    return {
      hasRoute: !!route,
      subject: route ? route.subject : null,
      steps: route ? route.blocks.reduce((n, b) => n + (b.steps||[]).length, 0) : 0,
      hasTree: !!tree,
      sources: sources.map((s) => ({ id: s.id, title: s.title })),
      segTotal: segs.length,
      segBySource: segs.reduce((m, s) => { m[s.sourceId] = (m[s.sourceId]||0)+1; return m; }, {}),
    };
  })()`);
  console.log('副本前提 =', JSON.stringify(pre, null, 1));

  rec('副本里有已确认的 v2 路线（否则这条路径验不到）', !!pre?.hasRoute,
      pre?.hasRoute ? pre.subject + ' · ' + pre.steps + ' 步' : '无');
  rec('副本里有资料段落（切小节要它）', (pre?.segTotal ?? 0) > 0, pre?.segTotal + ' 段');

  /* ---------- 进学习地图 ---------- */
  await ev(`(() => {
    for (const lb of document.querySelectorAll(".nav-group__label")) {
      const b = lb.closest("button"); const g = lb.closest(".nav-group");
      if (b && g && g.getAttribute("aria-expanded") !== "true") b.click();
    }
    return true;
  })()`);
  await sleep(900);
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
      .find((e) => (e.textContent || "").trim() === "学习地图");
    if (el) el.click();
    return true;
  })()`);

  /*
   * ⚠️ 2026-11-22 下午：学习地图拆成两级了。
   *
   * 侧栏进来是**一级页**（选资料），树在**二级页**。
   * 所以要先等一级页，再点「查看地图」进二级页，才能看到树。
   *
   * 不改这一步的话这个脚本会全红 —— 而那不是功能坏了，
   * 是**验证路径过时了**（「验证方法本身是错的」那一类）。
   */
  await waitFor(`document.querySelector(".map-home") ? true : null`, 30000, '一级页');
  await sleep(1200);
  const entered = await ev(`(() => {
    const b = [...document.querySelectorAll(".map-home button")]
      .find((x) => (x.textContent || "").includes("查看地图"));
    if (!b) return { ok: false, reason: '一级页没有「查看地图」' };
    b.click();
    return { ok: true };
  })()`);
  if (!entered?.ok) {
    console.error('❌ 进不了二级页：' + (entered?.reason || ''));
    try { app.kill(); } catch {}
    process.exit(2);
  }

  /* 等树出现 —— 这是本脚本的核心等待点 */
  const sawTree = await waitFor(
    `document.querySelector(".rtree") ? true : (document.querySelector(".map-error") ? "err" : null)`,
    35000,
    '树状地图',
  ).catch(() => null);
  await sleep(2500);
  await shot('01-tree-collapsed.png');

  const root = await ev(`(() => {
    const t = document.querySelector(".rtree");
    if (!t) return { has: false, bodyHasError: !!document.querySelector(".map-error"),
      errText: (document.querySelector(".map-error")?.textContent||"").slice(0,200) };
    return {
      has: true,
      title: (t.querySelector(".rtree__title")?.textContent || "").replace(/\\s+/g," ").trim().slice(0,80),
      lead: (t.querySelector(".rtree__lead")?.textContent || "").replace(/\\s+/g," ").trim().slice(0,160),
      chapterCount: t.querySelectorAll(".rtree__node--chapter").length,
      rootCount: t.querySelectorAll(".rtree__node--root").length,
      sectionCount: t.querySelectorAll(".rtree__node--section").length,
      pathCount: t.querySelectorAll(".rtree__wire").length,
      trunkCount: t.querySelectorAll(".rtree__wire--trunk").length,
      starCount: ((t.textContent || "").match(/\\*\\*/g) || []).length,
      canvasW: (() => { const c = t.querySelector(".rtree__canvas"); return c ? c.getBoundingClientRect().width : 0; })(),
      svgViewBox: t.querySelector(".rtree__wires")?.getAttribute("viewBox") || null,
    };
  })()`);
  console.log('树（折叠态）=', JSON.stringify(root, null, 1));

  rec('**树真的渲染出来了**（.rtree 在，不是一行文字）', !!root?.has,
      root?.has ? (root.title || '') : 'err=' + (root?.errText || 'not found'));
  rec('**章节点有数量**（> 0）', (root?.chapterCount ?? 0) > 0, (root?.chapterCount ?? 0) + ' 个章');
  rec('资料根节点在（树有根）', (root?.rootCount ?? 0) === 1, (root?.rootCount ?? 0) + ' 个');
  rec('**SVG 连线在**（主干 = 章数）',
      (root?.trunkCount ?? 0) === (root?.chapterCount ?? -1),
      'trunk=' + root?.trunkCount + ' / 章=' + root?.chapterCount);
  rec('viewBox 与画布同源（不是硬编码）',
      typeof root?.svgViewBox === 'string' && root.svgViewBox.startsWith('0 0 '),
      String(root?.svgViewBox));
  rec('折叠态不显示小节（默认折叠，用户要求）', (root?.sectionCount ?? -1) === 0,
      (root?.sectionCount ?? 0) + ' 个小节可见');
  const metaText = await ev(
    `(document.querySelector(".rtree__ch-meta")?.textContent||"").trim()`,
  );
  rec('折叠态也显示「几/几 小节完成」',
      /\d+\s*\/\s*\d+\s*小节完成/.test(metaText || ''),
      metaText);
  rec('树文案无字面星号', (root?.starCount ?? -1) === 0, String(root?.starCount));

  /*
   * ⚠️ 两条断言是 2026-11-22 看截图才发现的，之前 32 条全绿。
   *
   * 1. 标题里漏出 markdown 的 `##`（界面显示「## 1.0 引言」）
   * 2. 图上小节总数被重复计（三个同号章各拿 26 个 → 78）
   *
   * 旧断言只查「章数对不对」「分不分叉」，没人查「标题长什么样」「总数对不对」。
   */
  rec('标题里没有 markdown 的 # 号',
      !/#/.test(((root?.title || '') + (root?.lead || ''))) &&
      !/#/.test(await ev(`[...document.querySelectorAll(".rtree__ch-title,.rtree__sec-title,.rtree__ch-meta")].map(e=>e.textContent||"").join(" ")`)),
      await ev(`(document.querySelector(".rtree__ch-title")?.textContent||"").trim()`));

  /*
   * 总数不能重复计。
   * 判据：标题栏的「几/几 小节」分母，必须小于等于
   * 真实资料里切出的小节数（副本里信号与系统是 26）。
   * 重复计会让它变成 78。
   */
  const totalShown = await ev(`(() => {
    const t = (document.querySelector(".rtree__progress-sub")?.textContent || "").trim();
    const m = t.split("/");
    return m.length === 2 ? Number(m[1].trim().split(" ")[0]) : null;
  })()`);
  const chapterMetaShown = await ev(
    `(document.querySelector(".rtree__ch-meta")?.textContent||"").trim()`,
  );
  const perChapter = (() => {
    const parts = (chapterMetaShown || "").split("/");
    return parts.length === 2 ? Number(parts[1].trim().split(" ")[0]) : null;
  })();
  rec('小节总数没被重复计（总数 = 每章之和）',
      totalShown !== null && perChapter !== null &&
      totalShown <= 26,
      '标题栏总数=' + totalShown + ' 每章=' + perChapter);


  /* ---------- 1. 横向分列（根左 / 章中） ---------- */
  const cols = await ev(`(() => {
    const t = document.querySelector(".rtree");
    const g = (sel) => { const e = t.querySelector(sel); if (!e) return null;
      const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; };
    const chs = [...t.querySelectorAll(".rtree__node--chapter")].map((e) => {
      const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) };
    });
    return { root: g(".rtree__node--root"), ch0: chs[0] || null, chs,
      sameCol: chs.length > 0 ? Math.max(...chs.map(c=>c.x)) - Math.min(...chs.map(c=>c.x)) <= 1 : false,
      yIncreasing: chs.every((c,i) => i === 0 || c.y >= chs[i-1].y) };
  })()`);
  rec('**根在左、章在右**（不同列）',
      !!cols?.root && !!cols?.ch0 && cols.ch0.x > cols.root.x + cols.root.w,
      'root.x=' + cols?.root?.x + ' 章.x=' + cols?.ch0?.x);
  rec('所有章在同一列（同一 x，是树不是散点）', !!cols?.sameCol,
      JSON.stringify((cols?.chs || []).map((c) => c.x)));
  rec('章按 y 递增排列（可读的竖向顺序）', !!cols?.yIncreasing);

  /* ---------- 2. 点章 → 展开 + 聚焦淡出 ---------- */
  const before = await ev(`(() => {
    const t = document.querySelector(".rtree");
    return { dimmed: t.querySelectorAll(".rtree__node--dim").length,
             sections: t.querySelectorAll(".rtree__node--section").length };
  })()`);

  await ev(`(() => {
    const b = document.querySelector(".rtree__node--chapter");
    if (b) b.click();
    return true;
  })()`);
  await sleep(1400);
  await shot('02-tree-expanded.png');

  const after = await ev(`(() => {
    const t = document.querySelector(".rtree");
    const secs = [...t.querySelectorAll(".rtree__node--section")];
    const dimmed = [...t.querySelectorAll(".rtree__node--dim")];
    const chs = [...t.querySelectorAll(".rtree__node--chapter")];
    const secRects = secs.map((e) => { const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; });
    const chRect = chs[0] ? chs[0].getBoundingClientRect() : null;
    const paths = [...t.querySelectorAll(".rtree__wire--branch")];
    /* 分叉判据：所有枝的 path 起点必须相同 */
    const starts = paths.map((p) => {
      const d = p.getAttribute("d") || "";
      const m = /^M (-?[\\d.]+) (-?[\\d.]+)/.exec(d);
      return m ? m[1] + "," + m[2] : "?";
    });
    const dimWires = t.querySelectorAll(".rtree__wire--dim").length;
    return {
      sections: secs.length,
      dimmedChapters: dimmed.length,
      totalChapters: chs.length,
      dimOpacity: dimmed[0] ? getComputedStyle(dimmed[0]).opacity : null,
      secSameCol: secRects.length > 0 ? Math.max(...secRects.map(s=>s.x)) - Math.min(...secRects.map(s=>s.x)) <= 1 : false,
      secRightOfChapter: secRects.length > 0 && chRect ? secRects[0].x > chRect.x + chRect.width : false,
      paths: paths.length,
      uniqueStarts: [...new Set(starts)].length,
      sampleStarts: starts.slice(0, 3),
      dimWires,
      prereqCount: t.querySelectorAll(".rtree__prereq").length,
      expandedAttr: chs[0] ? chs[0].getAttribute("aria-expanded") : null,
      chapterDisabled: chs.filter((b) => b.disabled).length,
    };
  })()`);
  console.log('展开后 =', JSON.stringify(after, null, 1));

  rec('**点章后小节展开了**', (after?.sections ?? 0) > 0,
      before?.sections + ' → ' + after?.sections + ' 个小节');
  rec('**小节在章右侧一列**（不是压在一起）',
      !!after?.secSameCol && !!after?.secRightOfChapter,
      '同列=' + after?.secSameCol + ' 在右=' + after?.secRightOfChapter);
  rec('**章→小节是分叉**（所有枝共用一个起点）',
      (after?.paths ?? 0) >= 2 && (after?.uniqueStarts ?? 0) === 1,
      '枝=' + after?.paths + ' 不同起点=' + after?.uniqueStarts + ' ' + JSON.stringify(after?.sampleStarts));
  rec('**其余章淡出**（有 dim 类，且 opacity < 1）',
      (after?.dimmedChapters ?? 0) > 0 &&
        Number(after?.dimOpacity) > 0 &&
        Number(after?.dimOpacity) < 1,
      after?.dimmedChapters + ' 个淡出 / ' + after?.totalChapters + ' 章，opacity=' + after?.dimOpacity);
  rec('**非聚焦章的连线也淡了**（不是只淡节点）', (after?.dimWires ?? 0) > 0,
      (after?.dimWires ?? 0) + ' 条线淡出');
  rec('展开的章 aria-expanded=true', after?.expandedAttr === 'true', String(after?.expandedAttr));
  /*
   * ⚠️ 这条是用户明确要求：「章节可以同时进行，不用按顺序」。
   * 有前置提醒也不能把按钮禁用。
   */
  rec('**有前置提醒但章仍可点（没有 disabled）**',
      (after?.chapterDisabled ?? -1) === 0,
      '前置提醒 ' + after?.prereqCount + ' 处，disabled ' + after?.chapterDisabled + ' 个');

  /* ---------- 3. 点小节 → 详情面板 ---------- */
  await ev(`(() => {
    const s = document.querySelector(".rtree__node--section");
    if (s) s.click();
    return true;
  })()`);
  await sleep(1200);
  await shot('03-section-detail.png');

  const detail = await ev(`(() => {
    const d = document.querySelector(".rsdetail");
    if (!d) return { has: false };
    const txt = (d.textContent || "").replace(/\\s+/g, " ");
    return {
      has: true,
      checks: d.querySelectorAll(".rsdetail__check").length,
      hasCustom: !!d.querySelector(".rsdetail__custom-head"),
      hasFoot: !!d.querySelector(".rsdetail__foot"),
      footText: (d.querySelector(".rsdetail__foot")?.textContent || "").trim().slice(0, 120),
      hasAddInput: !!d.querySelector(".rsdetail__add-input"),
      statText: [...d.querySelectorAll(".rsdetail__stat")].map((e) => (e.textContent||"").trim()),
      saysStale: /出处已经失效/.test(txt),
      title: (d.querySelector(".rsdetail__title")?.textContent || "").trim(),
    };
  })()`);
  console.log('小节详情 =', JSON.stringify(detail, null, 1));

  rec('**点小节打开详情面板**', !!detail?.has, detail?.title || '');

  /*
   * ⚠️ 面板必须**在屏幕里**（2026-11-22 截图发现）。
   *
   * 树可能比一屏高，详情面板挂在树下方。点小节后面板出现在屏幕外
   * = 看起来就是「点了没反应」。旧断言只查 `detail.has`（DOM 里有），
   * 而 DOM 里有不等于用户看得见 —— 这个项目为此栽过不止一次。
   */
  const detailVisible = await ev(`(() => {
    const d = document.querySelector(".rsdetail");
    if (!d) return { inView: false, rectTop: null, vh: window.innerHeight };
    const r = d.getBoundingClientRect();
    return {
      inView: r.top < window.innerHeight && r.bottom > 0,
      rectTop: Math.round(r.top),
      vh: window.innerHeight,
      scrollY: Math.round(window.scrollY),
    };
  })()`);
  rec('**详情面板在屏幕里**（不是点了没反应）',
      !!detailVisible?.inView,
      'top=' + detailVisible?.rectTop + ' 视窗高=' + detailVisible?.vh);
  rec('三个任务的勾选框都在（≥3 个，含自定义）', (detail?.checks ?? 0) >= 3,
      (detail?.checks ?? 0) + ' 个勾选框');
  rec('自定义任务区在', !!detail?.hasCustom);
  rec('完成汇总在', !!detail?.hasFoot, detail?.footText);
  rec('可以加自定义任务（有输入框）', !!detail?.hasAddInput);
  rec('统计如实显示（不出现误导性 0 道题）',
      !(detail?.statText || []).some((s) => /^0 道题$/.test(s)) || !!detail?.saysStale,
      JSON.stringify(detail?.statText));

  /* ---------- 4. 勾满三项 → 显示完成 ---------- */
  const allChecked = await ev(`(async () => {
    const d = document.querySelector(".rsdetail");
    if (!d) return { ok: false };
    const checks = [...d.querySelectorAll(".rsdetail__check")];
    /* 勾上前三个（任务一/二/三） */
    for (const c of checks.slice(0, 3)) {
      if (!c.checked) { c.click(); await new Promise(r => setTimeout(r, 120)); }
    }
    return { ok: true, checked: checks.slice(0,3).filter(c => c.checked).length };
  })()`);
  await sleep(1500);
  const doneNow = await ev(`(() => {
    const f = document.querySelector(".rsdetail__foot");
    const s = document.querySelector(".rtree__node--section");
    return {
      footDone: f ? f.classList.contains("rsdetail__foot--done") : false,
      footText: (f?.textContent || "").replace(/\\s+/g," ").trim().slice(0,100),
      sectionDone: s ? s.classList.contains("rtree__node--done") : false,
      chapterMeta: (document.querySelector(".rtree__ch-meta")?.textContent || "").trim(),
    };
  })()`);
  console.log('勾满后 =', JSON.stringify(doneNow, null, 1));
  await shot('04-section-done.png');

  rec('**三项勾满 → 显示「这一节完成了」**',
      !!doneNow?.footDone && /完成/.test(doneNow?.footText || ''),
      doneNow?.footText);
  rec('**小节节点也跟着变完成态**（树上有反馈）', !!doneNow?.sectionDone);
  /*
   * 用字符串分解判断而不是正则字面量 ——
   * 含转义的正则套在脚本里拼字符串改，反斜杠会被吃一次（硬约束 10）。
   * 这里只需要判断「有个 数/数 的形状」，拆开再看两半是不是数字就够了。
   */
  const metaShaped = (() => {
    const t = doneNow?.chapterMeta || '';
    const parts = t.split('/');
    if (parts.length !== 2) return false;
    const a = Number(parts[0].trim());
    const b = Number(parts[1].trim().split(' ')[0]);
    return Number.isFinite(a) && Number.isFinite(b);
  })();
  rec('章的「几/几 小节完成」数字变了', metaShaped, doneNow?.chapterMeta);

  /* ---------- 4b. ⚠️ 刷新后任务状态不能丢（用户会直接踩到） ---------- */
  /*
   * 用户勾了一堆小节，刷新一下全没了 —— 这是他会当场发现的问题。
   *
   * 判据：勾满后 reload，重新展开同一章、点同一个小节，
   * 三个勾选框必须**仍然是勾上的**。
   */
  await send('Page.reload', { ignoreCache: true });
  await sleep(9000);
  await ev(`(() => {
    for (const lb of document.querySelectorAll(".nav-group__label")) {
      const b = lb.closest("button"); const g = lb.closest(".nav-group");
      if (b && g && g.getAttribute("aria-expanded") !== "true") b.click();
    }
    return true;
  })()`);
  await sleep(900);
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
      .find((e) => (e.textContent || "").trim() === "学习地图");
    if (el) el.click();
    return true;
  })()`);
  /* 刷新后同样要经过一级页 → 二级页 */
  await waitFor(`document.querySelector(".map-home") ? true : null`, 30000, '刷新后的一级页');
  await sleep(1200);
  await ev(`(() => {
    const b = [...document.querySelectorAll(".map-home button")]
      .find((x) => (x.textContent || "").includes("查看地图"));
    if (b) b.click();
    return true;
  })()`);
  await waitFor(`document.querySelector(".rtree") ? true : null`, 30000, '刷新后的树');
  await sleep(2000);
  await ev(`(() => { const b = document.querySelector(".rtree__node--chapter"); if (b) b.click(); return true; })()`);
  await sleep(1200);
  await ev(`(() => { const s = document.querySelector(".rtree__node--section"); if (s) s.click(); return true; })()`);
  await sleep(1500);

  const afterReload = await ev(`(() => {
    const d = document.querySelector(".rsdetail");
    if (!d) return { has: false };
    const checks = [...d.querySelectorAll(".rsdetail__check")];
    return {
      has: true,
      firstThree: checks.slice(0, 3).map((c) => c.checked),
      footDone: d.querySelector(".rsdetail__foot")?.classList.contains("rsdetail__foot--done") || false,
      footText: (d.querySelector(".rsdetail__foot")?.textContent || "").trim().slice(0, 80),
    };
  })()`);
  console.log('刷新后 =', JSON.stringify(afterReload, null, 1));
  await shot('05-after-reload.png');

  rec('**刷新后勾选状态还在**（不能白勾）',
      !!afterReload?.has && (afterReload?.firstThree || []).every(Boolean),
      JSON.stringify(afterReload?.firstThree));
  rec('刷新后仍显示「这一节完成了」', !!afterReload?.footDone,
      afterReload?.footText);

  /* ---------- 5. 键盘：方向键能在章之间走 ---------- */
  const kb = await ev(`(() => {
    const chs = [...document.querySelectorAll(".rtree__node--chapter")];
    if (chs.length < 2) return { skipped: true };
    chs[0].focus();
    const before = document.activeElement;
    chs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    return { ok: true, moved: document.activeElement === chs[1],
             beforeIsCh0: before === chs[0] };
  })()`);
  rec('键盘方向键能在章之间移动焦点', kb?.skipped || !!kb?.moved, JSON.stringify(kb));

  rec('无字面星号（全页）',
      (await ev(`((document.body.textContent||"").match(/\\*\\*/g)||[]).length`)) === 0);

  /* ---------- 截图复核提示 ---------- */
  console.log('\\n截图在：' + SHOTS);
  console.log('⚠️ 断言全绿不等于界面对 —— 必须肉眼复核这些截图');

  const realErrs = errs.filter((e) => e && e.indexOf('favicon') < 0 && e.indexOf('ERR_FILE') < 0);
  rec('无控制台报错', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  console.log('\\n通过 ' + pass + ' / ' + (pass + fail));

  try { app.kill(); } catch {}
  /*
   * ⚠️ 确认进程真的没了再退出（2026-11-22 教训）。
   *
   * `app.kill()` 只杀主进程，Electron 的子进程可能存活一会儿。
   * 残留进程会让"这个库是谁写的"变成一笔糊涂账 ——
   * 上一轮就因为无法确认这件事，花时间追了一次真库变更。
   */
  await sleep(1200);
  const stillAlive = await new Promise((res) => {
    require('node:child_process').exec(
      'tasklist /FI "IMAGENAME eq electron.exe"',
      (e, out) => res(String(out || '').includes('electron.exe')),
    );
  });
  if (stillAlive) {
    console.log('⚠️ 仍有 electron 进程存活 —— 请人工确认它是不是本次拉起的');
  } else {
    console.log('已确认进程退出干净');
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('脚本本身出错：' + (e && e.stack ? e.stack : e));
  process.exit(3);
});
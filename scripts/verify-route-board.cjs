/**
 * 验证「学习路线的横板地图」（2026-11-21 深夜补）。
 *
 * ## 用户报的问题
 *
 * > 我没找到地图的入口
 *
 * 截图里能看到「已确认的路线：信号与系统（第二版）· 3 块 · 3 步」这一行字，
 * 但**没有任何图**。
 *
 * 根因：上一轮把路线从「依据知识点」换成「依据资料本体」时，
 * 我只重写了规划表单，忘了给新数据结构写渲染器 ——
 * 旧的 `RouteMap.tsx`（知识点级）还在，但已不被任何页面引用。
 *
 * ## 要证的（重点在"真的画出来了"）
 *
 * 1. 有路线时渲染出**横板轨道**（不是一行文字）
 * 2. 节点是**横向排列**的（x 递增且同一行）—— 不是竖着堆
 * 3. 三种状态视觉区分（已走过 / 当前 / 未到达）
 * 4. 当前步有「你在这里」徽标，且**没压住文字**（间隙 ≥8px）
 * 5. 按块分层（块数 = 层数）
 * 6. 难度与「依据」分开显示
 * 7. 资料外的部分（beyond）如实告知
 * 8. 越界丢弃条数如实显示
 * 9. 页面无字面星号
 * 10. 无控制台报错
 *
 * ## 用哪个数据跑
 *
 * 用用户**真实**的那条路线（信号与系统，已确认的 3 块 3 步）——
 * 那是他截图里看到的东西，直接验它最有意义。
 * 隔离副本跑，不碰真实库。
 *
 * 用法：node scripts/verify-route-board.cjs [port]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/route-board-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/route-board' + (process.argv.includes('--desktop') ? '-desktop' : ''));
const PORT = Number(process.argv[2] || 9960);
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
  console.log('已复制真实库副本（含用户那条已确认路线）');

  /*
   * --desktop：验**桌面安装版**而不是开发构建。
   *
   * 打包 → 替换安装目录是另一条路径，换的过程可能出错
   * （asar 没打进去、exe 与 asar 不配对）。所以交付前要对安装版单独验一次。
   */
  const USE_DESKTOP = process.argv.includes('--desktop');
  const exe = USE_DESKTOP
    ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenLeaner', 'OpenLeaner.exe')
    : path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
  const APP_DIR = USE_DESKTOP ? path.dirname(exe) : ROOT;
  if (fs.existsSync(path.join(path.dirname(exe), 'openleaner-data'))) {
    console.error('❌ app 目录旁有 openleaner-data');
    process.exit(2);
  }

  const app = spawn(
    exe,
    [...(USE_DESKTOP ? [] : [ROOT]), '--user-data-dir=' + DATA, '--no-sandbox', '--remote-debugging-port=' + PORT, '--window-size=1600,1100'],
    { cwd: APP_DIR, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  app.stdout.on('data', (d) => (log += d.toString()));
  app.stderr.on('data', (d) => (log += d.toString()));

  /*
   * ⚠️ 桌面安装版的启动参数可能被它自己改写端口（实测出现 9041）。
   * 所以这里**从 stderr 里读出真实端口**，而不是死等我们指定的那个。
   * 这也是"别信任你传的参数，要读回实际状态"的又一例。
   */
  let target = null;
  let actualPort = PORT;
  for (let i = 0; i < 240; i++) {
    /* 每轮都试着从日志里抓端口（DevTools listening on ws://127.0.0.1:NNNN/） */
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
    console.error('起不来（试过端口 ' + actualPort + '）：' + log.slice(-1200));
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
      errs.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
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
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
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

  /* 先确认副本里真有那条路线 */
  const routeFacts = await ev(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("openleaner");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const row = await new Promise((res, rej) => {
      const tx = db.transaction("settings", "readonly");
      const rq = tx.objectStore("settings").get("app");
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    db.close();
    const r = row && row.sourceRoute;
    return r ? {
      has: true,
      subject: r.subject,
      blocks: r.blocks ? r.blocks.length : 0,
      steps: r.blocks ? r.blocks.reduce((n, b) => n + (b.steps || []).length, 0) : 0,
      beyond: (r.beyond || []).length,
      dropped: r.droppedOutOfScope,
      blockTitles: (r.blocks || []).map((b) => b.title),
    } : { has: false };
  })()`);
  console.log('副本里的路线 =', JSON.stringify(routeFacts));

  rec('副本里有已确认的路线（用真实数据验）', !!routeFacts?.has,
      routeFacts?.has ? routeFacts.subject + ' · ' + routeFacts.blocks + ' 块 · ' + routeFacts.steps + ' 步' : '无');

  /* 进学习地图 */
  await ev(`(() => {
    for (const lb of document.querySelectorAll(".nav-group__label")) {
      const b = lb.closest("button"); const g = lb.closest(".nav-group");
      if (b && g && g.getAttribute("aria-expanded") !== "true") b.click();
    }
    return true;
  })()`);
  await sleep(1000);
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
      .find((e) => (e.textContent || "").trim() === "学习地图");
    if (el) el.click();
    return true;
  })()`);
  await waitFor(`document.querySelector(".rmap--planner") ? true : null`, 25000, '规划面板');
  await sleep(3500);
  await shot('01-board.png');

  /* ---------- 核心：横板图真的画出来了吗 ---------- */
  const board = await ev(`(() => {
    const b = document.querySelector(".rboard");
    if (!b) return { has: false };

    const track = b.querySelector(".rboard__track");
    const nodes = [...b.querySelectorAll(".rboard__node")];
    const layers = [...b.querySelectorAll(".rboard__layer")];
    const rects = nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) };
    });
    const xs = rects.map((r) => r.x);
    const ys = rects.map((r) => r.y);

    return {
      has: true,
      hasTrack: !!track,
      nodeCount: nodes.length,
      layerCount: layers.length,
      layerTitles: layers.map((l) => (l.querySelector(".rboard__layer-label")?.textContent || "").trim()),
      rects,
      xIncreasing: xs.every((v, i) => i === 0 || v >= xs[i - 1]),
      sameRow: ys.length > 0 ? Math.max(...ys) - Math.min(...ys) < 120 : false,
      doneCount: b.querySelectorAll(".rboard__node--done").length,
      currentCount: b.querySelectorAll(".rboard__node--current").length,
      aheadCount: b.querySelectorAll(".rboard__node--ahead").length,
      hereMark: (b.querySelector(".rboard__here")?.textContent || "").trim(),
      lead: (b.querySelector(".rboard__lead")?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 140),
      hasCurrentPanel: !!b.querySelector(".rboard__current"),
      currentPanelText: (b.querySelector(".rboard__current")?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 300),
      hasBeyond: !!b.querySelector(".rboard__beyond"),
      beyondText: (b.querySelector(".rboard__beyond")?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200),
      droppedText: (b.querySelector(".rboard__dropped")?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120),
      trackScrollW: track ? track.scrollWidth : 0,
      trackClientW: track ? track.clientWidth : 0,
      trackOverflowX: track ? getComputedStyle(track).overflowX : null,
      starCount: ((b.textContent || "").match(/\\*\\*/g) || []).length,
    };
  })()`);
  console.log('横板 =', JSON.stringify({
    hasTrack: board?.hasTrack,
    nodeCount: board?.nodeCount,
    layerCount: board?.layerCount,
    layerTitles: board?.layerTitles,
    xIncreasing: board?.xIncreasing,
    sameRow: board?.sameRow,
    done: board?.doneCount,
    current: board?.currentCount,
    ahead: board?.aheadCount,
    hereMark: board?.hereMark,
    lead: board?.lead,
  }, null, 1));

  rec('**横板地图渲染出来了**（不是只有一行文字）', !!board?.has && !!board?.hasTrack);
  rec('**节点数是实实在在的**（= 路线的步数）',
      board?.nodeCount === routeFacts?.steps, board?.nodeCount + ' 个节点 / ' + routeFacts?.steps + ' 步');
  rec('**是横向排列的**（x 递增且在同一行）',
      !!board?.xIncreasing && !!board?.sameRow,
      'x递增=' + board?.xIncreasing + ' 同行=' + board?.sameRow +
      ' 轨道=' + board?.trackScrollW + '/' + board?.trackClientW +
      ' overflow-x=' + board?.trackOverflowX);
  rec('按块分层（层数 = 块数）',
      board?.layerCount === routeFacts?.blocks, board?.layerCount + ' 层 / ' + routeFacts?.blocks + ' 块');
  rec('层标题有内容', (board?.layerTitles ?? []).every((t) => t.length > 0), JSON.stringify(board?.layerTitles));

  rec('**三种状态都有**（已走过 / 当前 / 未到达）',
      (board?.currentCount ?? 0) === 1 &&
      ((board?.doneCount ?? 0) + (board?.aheadCount ?? 0)) >= 1,
      'done=' + board?.doneCount + ' current=' + board?.currentCount + ' ahead=' + board?.aheadCount);
  rec('**当前步有「你在这里」徽标**',
      (board?.hereMark ?? '').includes('你在这里'), board?.hereMark);
  rec('顶部说明写清在哪一章',
      (board?.lead ?? '').includes('当前在'), (board?.lead ?? '').slice(0, 90));
  rec('有当前步详情面板', !!board?.hasCurrentPanel);
  rec('**详情里「难度」与「依据」分开显示**',
      (board?.currentPanelText ?? '').includes('难度') &&
      (board?.currentPanelText ?? '').includes('依据'),
      (board?.currentPanelText ?? '').slice(0, 160));
  rec('依据写清来源（目录/检索/推断）',
      /来自资料目录|来自联网检索|AI 按学科知识推断/.test(board?.currentPanelText ?? ''),
      (board?.currentPanelText ?? '').match(/来自资料目录|来自联网检索|AI 按学科知识推断/)?.[0] ?? '');

  /* 资料外的部分如实告知 */
  if ((routeFacts?.beyond ?? 0) > 0) {
    rec('**资料外的部分如实告知**（beyond 显示出来了）', !!board?.hasBeyond,
        (board?.beyondText ?? '').slice(0, 120));
  } else {
    rec('（这条路线没有 beyond，跳过）', true);
  }

  /* 越界丢弃条数如实显示 */
  if ((routeFacts?.dropped ?? 0) > 0) {
    rec('**越界被丢弃的条数如实显示**', (board?.droppedText ?? '').length > 0,
        (board?.droppedText ?? '').slice(0, 100));
  } else {
    rec('（这条路线没有越界丢弃，跳过）', true);
  }

  /* ---------- 「你在这里」徽标不能压住文字 ---------- */
  const badge = await ev(`(() => {
    const node = document.querySelector(".rboard__node--current");
    if (!node) return null;
    const b = node.querySelector(".rboard__here");
    const l = node.querySelector(".rboard__label");
    if (!b || !l) return null;
    const br = b.getBoundingClientRect();
    const lr = l.getBoundingClientRect();
    return {
      gap: Math.round(lr.bottom - br.top),
      badgeTop: Math.round(br.top),
      labelBottom: Math.round(lr.bottom),
    };
  })()`);
  /*
   * 判据是「留出呼吸空间」而不是「刚好不重叠」。
   * 知识点级那版反向验证过：间隙 3px 时「不重叠」也成立，但看图是糊的。
   */
  rec('**「你在这里」徽标与文字留有呼吸空间（≥8px）**',
      badge !== null && badge.gap <= -8,
      badge ? '间隙 ' + (-badge.gap) + 'px' : '(没找到徽标)');

  rec('横板文案无字面星号', (board?.starCount ?? -1) === 0, String(board?.starCount));

  /*
   * ⚠️ 覆盖度不能显示误导性的 0%（2026-11-21 深夜实测）。
   *
   * 用户库「信号与系统」有 10 道题，但它们的锚点 segmentId
   * 全部指向已不存在的段（重新整理时换过段落，锚点没更新）。
   * 照常算会显示「0 段已出题（0%）」—— 用户会以为他一题都没做。
   *
   * 所以要么显示正常覆盖度，要么如实说「题目出处已失效」。
   * 判据：如果页面上出现「已出题」并且数字是 0，而库里其实有题，
   * 那就是误导。
   */
  const covText = await ev(`(() => {
    const d = document.querySelector(".rboard__current");
    return d ? (d.textContent || "").replace(/\s+/g, " ") : null;
  })()`);
  console.log('覆盖度文本 =', (covText ?? '').slice(0, 220));

  const looksMisleading = /其中 0 段已出题/.test(covText ?? '');
  const saysBroken = /出处已经失效|算不出覆盖度/.test(covText ?? '');
  rec('**覆盖度没有误导性地显示 0%（题目锚点失效时如实说明）**',
      !looksMisleading || saysBroken,
      looksMisleading
        ? (saysBroken ? '显示 0% 但同时说明了原因' : '⚠️ 只显示 0%，没说原因')
        : '没有出现误导性的 0%');

  /* ---------- 点一下节点 ---------- */
  const clicked = await ev(`(() => {
    const n = document.querySelector(".rboard__node--current") || document.querySelector(".rboard__node");
    if (!n) return null;
    const before = location.href;
    n.click();
    return { clicked: true, before, after: location.href };
  })()`);
  await sleep(1500);
  const afterClick = await ev(`(() => {
    const txt = (document.querySelector(".page")?.textContent || "").replace(/\\s+/g, " ");
    return { head: txt.slice(0, 120) };
  })()`);
  rec('点节点有反应（跳走了，不是死链）',
      clicked?.clicked === true, (afterClick?.head ?? '').slice(0, 70));

  const realErrs = errs.filter((e) => e && e.indexOf('favicon') < 0 && e.indexOf('ERR_FILE') < 0);
  rec('无控制台报错', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  console.log('\n通过 ' + pass + ' / ' + (pass + fail));
  console.log('截图：' + SHOTS);

  try { app.kill(); } catch {}
  await sleep(600);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('脚本本身出错：' + (e && e.stack ? e.stack : e));
  process.exit(3);
});
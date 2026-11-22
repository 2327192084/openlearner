/**
 * 验证「学习地图拆两级」（2026-11-22 下午）。
 *
 * ## 用户的原始要求
 *
 * > 写一个二级页面，用户在一级页面选择资料创建学习地图，
 * > 二级页面显示树状地图。
 * > 每份资料都能创建地图，创建完成后在不同资料底下留个查看地图按钮就行。
 * > 页面内这些东西都不要了（题库概览 / 章节列表 / 横板路线 / 工具条）
 *
 * ## 要证的（重点是"真的分成两页了"）
 *
 * 1. 一级页只有「选资料创建」+ 已有地图入口，**没有**题库概览/横板/工具条
 * 2. 每份资料一行，没有地图的行有「创建地图」，有地图的行有「查看地图」
 * 3. 未解析完的资料**按钮仍可点**（不 disabled）
 * 4. 点「查看地图」→ 进入二级页，**树真的画出来了**
 * 5. 二级页有返回按钮，点它回到一级页
 * 6. 侧栏高亮仍是「学习地图」（两级都在同一项下）
 * 7. 无字面 `**`、无控制台报错
 *
 * 用真实库副本跑（不碰真库）。
 * 用法：node scripts/verify-map-two-level.cjs [port]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/twolevel-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/map-two-level');
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
  console.log('已复制真实库副本');

  const exe = path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
  /* 第 4 候选陷阱：那个目录存在会抢走 --user-data-dir */
  if (fs.existsSync(path.join(path.dirname(exe), 'openleaner-data'))) {
    console.error('❌ app 目录旁有 openleaner-data —— 会抢走 userData');
    process.exit(2);
  }

  const app = spawn(
    exe,
    [ROOT, '--user-data-dir=' + DATA, '--no-sandbox', '--remote-debugging-port=' + PORT],
    { cwd: ROOT, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  app.stdout.on('data', (d) => (log += d));
  app.stderr.on('data', (d) => (log += d));

  let target = null;
  let actualPort = PORT;
  for (let i = 0; i < 240; i++) {
    const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(log);
    if (m && Number(m[1]) !== actualPort) {
      actualPort = Number(m[1]);
      console.log('（实际调试端口：' + actualPort + '）');
    }
    try {
      const l = await (await fetch('http://127.0.0.1:' + actualPort + '/json/list')).json();
      target = l.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
      if (target) break;
    } catch {}
    await sleep(250);
  }
  if (!target) {
    console.error('起不来：' + log.slice(-1200));
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
        (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200),
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

  /* 视口放大，一屏看完 */
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 1250,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(1000);

  /* ---------- 进学习地图（一级页） ---------- */
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
  await waitFor(`document.querySelector(".map-home") ? true : null`, 30000, '一级页');
  await sleep(2500);
  await shot('01-level1.png');

  /* ---------- 一级页的内容检查 ---------- */
  const lvl1 = await ev(`(() => {
    const h = document.querySelector(".map-home");
    const txt = (h.textContent || "").replace(/\\s+/g, " ");
    return {
      has: true,
      rows: h.querySelectorAll(".maphome-row").length,
      rowsWithMap: h.querySelectorAll(".maphome-row--has").length,
      createBtns: [...h.querySelectorAll("button")].filter(b => (b.textContent||"").trim() === "创建地图").length,
      openBtns: [...h.querySelectorAll("button")].filter(b => (b.textContent||"").includes("查看地图")).length,
      disabledBtns: [...h.querySelectorAll("button")].filter(b => b.disabled).length,
      /* 旧页面那些东西必须没了 */
      hasOldStats: !!document.querySelector(".map-stats"),
      hasOldToolbar: !!document.querySelector(".map-toolbar"),
      hasOldTree: !!document.querySelector(".map-tree"),
      hasOldBoard: !!document.querySelector(".rboard"),
      hasPlanner: !!document.querySelector(".rmap--planner"),
      starCount: ((h.textContent||"").match(/\\*\\*/g) || []).length,
      titles: [...h.querySelectorAll(".maphome-row__title")].map(e => (e.textContent||"").trim()),
      warnCount: h.querySelectorAll(".maphome-row__warn").length,
    };
  })()`);
  console.log('一级页 =', JSON.stringify(lvl1, null, 1));

  rec('**一级页渲染出来了**（.map-home）', !!lvl1?.has);
  rec('每份资料一行', (lvl1?.rows ?? 0) >= 3, (lvl1?.rows ?? 0) + ' 行');
  rec('**每行都有「创建地图」或「查看地图」**',
      (lvl1?.createBtns ?? 0) + (lvl1?.openBtns ?? 0) === lvl1?.rows,
      '创建=' + lvl1?.createBtns + ' 查看=' + lvl1?.openBtns + ' 行=' + lvl1?.rows);
  rec('**旧页面的东西都没了**（题库概览/工具条/章节列表/横板/规划表单）',
      !lvl1?.hasOldStats && !lvl1?.hasOldToolbar && !lvl1?.hasOldTree &&
      !lvl1?.hasOldBoard && !lvl1?.hasPlanner,
      'stats=' + lvl1?.hasOldStats + ' toolbar=' + lvl1?.hasOldToolbar +
      ' tree=' + lvl1?.hasOldTree + ' board=' + lvl1?.hasOldBoard +
      ' planner=' + lvl1?.hasPlanner);
  /*
   * ⚠️ 用户明确要求：未解析完只提示不拦，按钮始终可点。
   * 副本里「课程知识点一」和「高等数学」都是未解析完的。
   */
  rec('有未解析完的提示（黄色说明）', (lvl1?.warnCount ?? 0) > 0, (lvl1?.warnCount ?? 0) + ' 处');
  rec('**未解析完的资料按钮仍可点**（没有 disabled）',
      (lvl1?.disabledBtns ?? -1) === 0, (lvl1?.disabledBtns ?? 0) + ' 个 disabled');
  rec('一级页文案无字面星号', (lvl1?.starCount ?? -1) === 0);

  /*
   * ⚠️ 旧数据迁移（2026-11-22 实测踩到的）。
   *
   * 用户库里可能**只有** v2 的扁平路线（`settings.sourceRoute`），
   * 既没有 `sourceTree` 也没有 `sourceTrees`。第一版 `readTreeMap`
   * 只认后两者，结果他已有的「信号与系统」路线没被转成地图，
   * 一级页三份资料全都只有「创建地图」—— 看起来像"我做的地图没了"。
   *
   * 这条断言直接查库：有旧路线就必须已经长出地图。
   */
  const migrate = await ev(`(async () => {
    const db = await new Promise((res,rej)=>{const r=indexedDB.open("openleaner");r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});
    const get=(s,k)=>new Promise((res,rej)=>{const rq=db.transaction(s,"readonly").objectStore(s).get(k);rq.onsuccess=()=>res(rq.result);rq.onerror=()=>rej(rq.error);});
    const st = await get("settings","app");
    db.close();
    return {
      hasLegacyRoute: !!(st && st.sourceRoute),
      hasTrees: !!(st && st.sourceTrees),
      treeKeys: st && st.sourceTrees ? Object.keys(st.sourceTrees).length : 0,
    };
  })()`);
  console.log('迁移前状态 =', JSON.stringify(migrate));
  rec('**旧 v2 路线已转成地图**（有旧路线就该有地图）',
      !migrate?.hasLegacyRoute || (migrate?.treeKeys ?? 0) > 0,
      '旧路线=' + migrate?.hasLegacyRoute + ' 地图数=' + migrate?.treeKeys);

  /* ---------- 已有地图 → 点「查看地图」进二级页 ---------- */
  const hasOpen = (lvl1?.openBtns ?? 0) > 0;
  if (hasOpen) {
    await ev(`(() => {
      const b = [...document.querySelectorAll(".map-home button")]
        .find((x) => (x.textContent || "").includes("查看地图"));
      if (b) b.click();
      return true;
    })()`);
    await waitFor(`document.querySelector(".map-tree-page") ? true : null`, 30000, '二级页');
    await sleep(2500);
    await shot('02-level2-tree.png');

    const lvl2 = await ev(`(() => {
      const p = document.querySelector(".map-tree-page");
      const t = document.querySelector(".rtree");
      const crumb = p?.querySelector(".map-tree-page__crumb");
      const back = p?.querySelector(".map-tree-page__back");
      const navActive = [...document.querySelectorAll(".nav-item")]
        .filter((e) => (e.textContent || "").trim() === "学习地图")
        .map((e) => e.className);
      return {
        hasPage: !!p,
        hasTree: !!t,
        chapters: t ? t.querySelectorAll(".rtree__node--chapter").length : 0,
        root: t ? t.querySelectorAll(".rtree__node--root").length : 0,
        wires: t ? t.querySelectorAll(".rtree__wire").length : 0,
        crumb: crumb ? (crumb.textContent || "").trim() : "",
        hasBack: !!back,
        backText: back ? (back.textContent || "").trim() : "",
        navActive,
        hasLevel1: !!document.querySelector(".map-home"),
      };
    })()`);
    console.log('二级页 =', JSON.stringify(lvl2, null, 1));

    rec('**二级页渲染出来了**', !!lvl2?.hasPage);
    rec('**树真的画出来了**（有章节点 + 根 + 连线）',
        (lvl2?.chapters ?? 0) > 0 && (lvl2?.root ?? 0) === 1 && (lvl2?.wires ?? 0) > 0,
        '章=' + lvl2?.chapters + ' 根=' + lvl2?.root + ' 线=' + lvl2?.wires);
    rec('**两级是分开的**（二级页上没有一级页的选资料列表）', !lvl2?.hasLevel1);
    rec('**有返回按钮**', !!lvl2?.hasBack, lvl2?.backText);
    rec('面包屑显示资料标题（不是空白）', (lvl2?.crumb ?? '').length > 0, lvl2?.crumb);
    rec('**侧栏仍高亮「学习地图」**（两级同一项）',
        (lvl2?.navActive ?? []).some((c) => c.includes('nav-item--on')),
        JSON.stringify(lvl2?.navActive));

    /* ---------- 破坏性动作要二次确认 ---------- */
    /*
     * 「重新生成」会清掉勾选、「删除」会去掉整张地图，都不可撤销。
     * 直接执行等于让用户误点一次就丢东西。
     */
    const confirmCheck = await ev(`(async () => {
      const btns = [...document.querySelectorAll(".rtree__actions button")];
      const del = btns.find((b) => (b.textContent || "").includes("删除这张地图"));
      const regen = btns.find((b) => (b.textContent || "").includes("重新生成"));
      if (!del) return { hasDelete: false };
      const before = document.querySelectorAll('[role="dialog"]').length;
      del.click();
      await new Promise((r) => setTimeout(r, 700));
      const dlg = document.querySelector('[role="dialog"]');
      const dlgText = dlg ? (dlg.textContent || "").replace(/\s+/g, " ") : "";
      /* 关掉它，别真删 */
      const cancel = dlg ? [...dlg.querySelectorAll("button")].find((b) => (b.textContent||"").trim() === "取消") : null;
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 500));
      return {
        hasDelete: true,
        hasRegen: !!regen,
        deleteLabel: (del.textContent || "").trim(),
        regenLabel: regen ? (regen.textContent || "").trim() : "",
        dialogAppeared: before === 0 && !!dlg,
        dialogText: dlgText.slice(0, 160),
        closedAfterCancel: document.querySelectorAll('[role="dialog"]').length === 0,
      };
    })()`);
    console.log('破坏性动作 =', JSON.stringify(confirmCheck, null, 1));

    rec('按钮文案说清是「整张地图」不是「路线」',
        (confirmCheck?.deleteLabel ?? '').includes('地图'),
        confirmCheck?.deleteLabel + ' / ' + confirmCheck?.regenLabel);
    rec('**删除前弹二次确认**（不可撤销动作不能误点）',
        !!confirmCheck?.dialogAppeared, confirmCheck?.dialogText);
    rec('确认框关掉后状态正常（没真删）', !!confirmCheck?.closedAfterCancel);

    /* ---------- 重新生成：接线与文案（不真跑 AI） ---------- */
    /*
     * ⚠️ 这里**验不了"保留勾选"的完整链路**，如实说明原因：
     *
     * 重新生成要调真实模型，而隔离副本里没有配置任何 AI 后端
     * （实测 backends=0、secrets=0）。假模型也补不了 ——
     * 桌面端走 preload 桥（`window.openleaner.chat`），不碰页面 fetch，
     * 项目文档里记过两次这个坑。
     *
     * 所以这里只验**能验的部分**：
     *  - 按钮存在、文案说清是"整张地图"
     *  - 点了会弹确认框，且确认框文案说的是"尽量保留"而不是"会清掉"
     *
     * 「按标题保留」的逻辑由 42 条单测守（`carryTaskProgress`，含反向验证：
     * 改成按位置硬搬 → 2 条红）。**不在这里假装验过。**
     */
    const regenUi = await ev(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const btn = [...document.querySelectorAll(".rtree__actions button")]
        .find((b) => (b.textContent || "").includes("重新生成"));
      if (!btn) return { hasBtn: false };
      const label = (btn.textContent || "").trim();
      btn.click();
      await sleep(900);
      const dlg = document.querySelector('[role="dialog"]');
      const text = dlg ? (dlg.textContent || "").replace(/\s+/g, " ") : "";
      /* 关掉，别真触发（副本里没后端，点了只会报错） */
      const cancel = dlg ? [...dlg.querySelectorAll("button")]
        .find((b) => (b.textContent || "").trim() === "取消") : null;
      if (cancel) cancel.click();
      await sleep(400);
      return {
        hasBtn: true,
        label,
        dialogAppeared: !!dlg,
        text: text.slice(0, 200),
        closed: document.querySelectorAll('[role="dialog"]').length === 0,
      };
    })()`);
    console.log('重新生成（只验接线）=', JSON.stringify(regenUi, null, 1));
    await shot('03-regen-confirm.png');

    rec('有「重新生成这张地图」按钮', !!regenUi?.hasBtn, regenUi?.label);
    rec('**确认框文案说「尽量保留」而不是「会被清掉」**',
        /尽量|保留/.test(regenUi?.text || '') && !/会被清掉/.test(regenUi?.text || ''),
        (regenUi?.text || '').slice(0, 120));
    rec('点重新生成会弹确认框', !!regenUi?.dialogAppeared);
    rec('取消后状态正常', !!regenUi?.closed);

    /* ---------- 点返回 → 回一级页 ---------- */
    await ev(`(() => {
      const b = document.querySelector(".map-tree-page__back");
      if (b) b.click();
      return true;
    })()`);
    await sleep(2000);
    const backOk = await ev(`(() => ({
      hasLevel1: !!document.querySelector(".map-home"),
      hasLevel2: !!document.querySelector(".map-tree-page"),
    }))()`);
    rec('**点返回回到一级页**', !!backOk?.hasLevel1 && !backOk?.hasLevel2,
        JSON.stringify(backOk));
  } else {
    rec('（副本里没有已建好的地图，跳过二级页检查 —— 先建一张）', false,
        '没有「查看地图」按钮');
  }

  rec('无字面星号（全页）',
      (await ev(`((document.body.textContent || "").match(/\\*\\*/g) || []).length`)) === 0);

  const realErrs = errs.filter((e) => e && e.indexOf('favicon') < 0 && e.indexOf('ERR_FILE') < 0);
  rec('无控制台报错', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  console.log('\n通过 ' + pass + ' / ' + (pass + fail));
  console.log('截图：' + SHOTS);

  try { app.kill(); } catch {}
  await sleep(1200);
  /*
   * ⚠️ 确认进程真的没了再退出（2026-11-22 教训）。
   * app.kill() 不保证 Electron 立刻退出，残留进程会在后台继续跑，
   * 下次启动就可能被误认成"我写的"。
   */
  const stillAlive = await new Promise((res) => {
    const { exec } = require('node:child_process');
    exec('tasklist /FI "IMAGENAME eq electron.exe"', (e, out) => {
      res(String(out || '').includes('electron.exe'));
    });
  });
  if (stillAlive) console.log('⚠️ 仍有 electron 进程存活（可能是我拉起的，需要人工确认）');
  else console.log('已确认进程退出干净');

  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('脚本本身出错：' + (e && e.stack ? e.stack : e));
  process.exit(3);
});
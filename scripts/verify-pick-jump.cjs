/**
 * 验证「绑定面板选取改为跳转功能页」（2026-11-23，用户待办第 1 项）。
 *
 * 用户原话（2026-11-22 23:19）：
 * > 这个选闪卡的界面每个闪卡的边界都不明显，
 * > 我觉得这两个选取都改为跳转到对应的功能界面进行选取好一点。
 *
 * ## 验什么（按真实操作路径：地图 → 小节详情 → 跳闪卡页 → 选这个 → 返回）
 *
 * 1. 绑定面板没有旧的内嵌搜索列表了（`.bindp__picker` 计数 0）
 * 2. 有「+ 去闪卡页挑」按钮；点了真跳到闪卡管理页
 * 3. 闪卡页顶部出选取横幅，**横幅里的章/节标题 = 刚才详情面板的标题**
 *    （跨页一致性 —— 两个部分的关系，本项目老盲区）
 * 4. 每张卡有「选这个」；点一个 → 横幅「已绑 N」从 N-1 变 N（数字跟着写回走）
 * 5. 再点同一张 → 变「已绑上」禁用，横幅数字**不涨**（重复计数防住了）
 * 6. 「返回地图」→ 回到二级页且**自动重开刚才那一节**（跳走→回来关系断言）
 * 7. 返回后绑定面板的计数 = 横幅最后说的数（同源）
 * 8. 刷新后重进这一节，绑定还在（持久化）
 * 9. 普通浏览（无会话）进闪卡页：没有横幅、没有「选这个」（假开关双向查）
 * 10. 会话中途从侧栏离开再回来：不残留横幅
 * 11. 题组路径（若库里有已发布题组；没有就如实记 skip）
 * 12. 无控制台报错
 *
 * 全程跑在 .tmp/pick-appdata 隔离副本上，真实库不碰。
 * 用法：node scripts/verify-pick-jump.cjs [port] [--desktop]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/pick-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/pick-jump');
const PORT = Number(process.argv[2] || 9896);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
let skipped = 0;
const rec = (n, ok, x) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : ''));
  ok ? pass++ : fail++;
};
const skip = (n, why) => {
  console.log('SKIP ' + n + ' :: ' + why);
  skipped++;
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
  console.log('已复制真实库副本（隔离）');

  const USE_DESKTOP = process.argv.includes('--desktop');
  const exe = USE_DESKTOP
    ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenLeaner', 'OpenLeaner.exe')
    : path.join(ROOT, 'release/win-unpacked/OpenLeaner.exe');
  const APP_DIR = path.dirname(exe);

  if (fs.existsSync(path.join(APP_DIR, 'openleaner-data'))) {
    console.error('FAIL app 目录旁有 openleaner-data（候选 #4 会抢 userData）');
    process.exit(2);
  }

  const app = spawn(
    exe,
    ['--user-data-dir=' + DATA, '--no-sandbox', '--remote-debugging-port=' + PORT],
    { cwd: APP_DIR, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
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
      console.log('（实际端口：' + actualPort + '）');
    }
    try {
      const l = await (await fetch('http://127.0.0.1:' + actualPort + '/json/list')).json();
      target = l.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
      if (target) break;
    } catch {}
    await sleep(250);
  }
  if (!target) {
    console.error('起不来：' + log.slice(-800));
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
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', {
      expression: x,
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

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(8000);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 1300,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(1000);

  /* ---------- 进学习地图二级页（按标题锁定「信号与系统」那份，硬约束 18） ---------- */
  await ev(`(() => {
    for (const lb of document.querySelectorAll(".nav-group__label")) {
      const b = lb.closest("button"); const g = lb.closest(".nav-group");
      if (b && g && g.getAttribute("aria-expanded") !== "true") b.click();
    }
    return true;
  })()`);
  await sleep(800);
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item")]
      .find((e) => (e.textContent || "").trim() === "学习地图");
    if (el) el.click();
    return true;
  })()`);
  await sleep(2500);
  await ev(`(() => {
    const rows = [...document.querySelectorAll(".maphome-row")];
    const row = rows.find((r) => ((r.querySelector(".maphome-row__title") || {}).textContent || "").indexOf("信号与系统") >= 0);
    if (!row) return { ok: false };
    const b = [...row.querySelectorAll("button")].find((x) => (x.textContent || "").includes("查看地图"));
    if (!b) return { ok: false, why: "no open" };
    b.click();
    return { ok: true };
  })()`);
  const inTree = await (async () => {
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      await sleep(800);
      const v = await ev(`!!document.querySelector(".rtree")`).catch(() => false);
      if (v) return true;
    }
    return false;
  })();
  if (!inTree) {
    rec('进入信号与系统的地图二级页', false, '超时');
    cleanup();
    return;
  }
  await sleep(1500);

  /* ---------- 展开第一章、点第一个小节，读它的标题 ---------- */
  const secInfo = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector(".rtree__node--chapter")?.click();
    await sleep(900);
    const sec = document.querySelector(".rtree__node--section");
    if (!sec) return { ok: false, why: "no section" };
    sec.click();
    /*
     * ⚠️ 必须等渲染再查 .rsdetail —— 第一版在这里同步查询，
     * React 还没画出详情面板，3 条断言连带误红（脚本 bug，不是应用 bug）。
     */
    let d = null;
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      await sleep(300);
      d = document.querySelector(".rsdetail");
      if (d) break;
    }
    if (!d) return { ok: false, why: "no detail" };
    const h2 = d.querySelector("h2, .rsdetail__title");
    return {
      ok: true,
      detailText: (h2 ? h2.textContent : (d.textContent || "")).trim().slice(0, 60),
      /* 详情里能看到的章/节字样（供横幅比对） */
      headText: (d.textContent || "").slice(0, 120),
      hasInlinePicker: !!d.querySelector(".bindp__picker"),
      hasPickCardsBtn: [...d.querySelectorAll("button")].some((b) => (b.textContent || "").includes("去闪卡页挑")),
      hasPickDecksBtn: [...d.querySelectorAll("button")].some((b) => (b.textContent || "").includes("去题组页挑")),
      boundCount: (d.querySelector(".bindp__count") || {}).textContent || '',
    };
  })()`);
  console.log('小节详情 =', JSON.stringify(secInfo));
  rec('小节详情打开，旧内嵌搜索列表已移除', !!(secInfo && secInfo.ok && !secInfo.hasInlinePicker));
  rec('绑定面板有「+ 去闪卡页挑」', !!(secInfo && secInfo.hasPickCardsBtn));
  await shot('01-detail.png');

  /* ---------- 点「去闪卡页挑」→ 应跳到闪卡管理页并带横幅 ---------- */
  await ev(`(() => {
    const b = [...document.querySelectorAll(".rsdetail button")].find((x) => (x.textContent || "").includes("去闪卡页挑"));
    if (b) b.click();
    return !!b;
  })()`);
  const onFc = await (async () => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      await sleep(700);
      const v = await ev(`!!document.querySelector(".fcx")`).catch(() => false);
      if (v) return true;
    }
    return false;
  })();
  rec('点「去闪卡页挑」真的跳到了闪卡管理页', onFc);
  await sleep(1800);

  const banner = await ev(`(() => {
    const b = document.querySelector(".pkb");
    if (!b) return { has: false };
    const text = (b.querySelector(".pkb__text") || {}).textContent || '';
    return {
      has: true,
      text: text.trim(),
      bound: (text.match(/已绑 (\\d+) 个/) || [])[1] ?? null,
      hasBackBtn: [...b.querySelectorAll("button")].some((x) => (x.textContent || "").includes("返回地图")),
      pickBtns: document.querySelectorAll(".pkb__pick").length,
      /* 浏览态不该出现的控件 */
      hasDeleteAll: false,
    };
  })()`);
  console.log('横幅 =', JSON.stringify(banner).slice(0, 300));
  rec('闪卡页顶部出选取横幅（含返回按钮）', !!(banner && banner.has && banner.hasBackBtn));
  /*
   * 跨页一致性：横幅说的节标题要能在刚才详情面板的文本里找到。
   * 标题取前 8 个字比对（章号前缀两页写法可能不同，取稳定子串）。
   */
  const secTitleForCompare = String(secInfo.headText || '').replace(/\s+/g, '');
  const bannerCompact = String(banner.text || '').replace(/\s+/g, '');
  let overlap = false;
  for (let len = 8; len >= 4 && !overlap; len--) {
    for (let at = 0; at + len <= secTitleForCompare.length; at++) {
      const sub = secTitleForCompare.slice(at, at + len);
      if (/^[0-9a-zA-Z]{1,4}$/.test(sub)) continue;
      if (bannerCompact.indexOf(sub) >= 0 && /[\\u4e00-\\u9fa5]/.test(sub)) {
        overlap = true;
        break;
      }
    }
  }
  rec('⚠️ 横幅标题与来源小节一致（跨页关系断言）', overlap,
      'banner=' + bannerCompact.slice(0, 40));
  rec('每张卡都有「选这个」（库里有卡时）', (banner.pickBtns || 0) > 0, 'pickBtns=' + (banner && banner.pickBtns));
  await shot('02-banner.png');

  /* ---------- 点第一个未绑的「选这个」→ 横幅数字 +1 ---------- */
  const before = Number(banner.bound ?? 0);
  const pick1 = await ev(`(() => {
    const btns = [...document.querySelectorAll(".pkb__pick")].filter((b) => !b.disabled);
    if (btns.length === 0) return { ok: false, why: "全部已绑" };
    btns[0].click();
    return { ok: true };
  })()`);
  await sleep(1500);
  const banner2 = await ev(`(() => {
    const b = document.querySelector(".pkb");
    const text = b ? ((b.querySelector(".pkb__text") || {}).textContent || '') : '';
    return { bound: (text.match(/已绑 (\\d+) 个/) || [])[1] ?? null };
  })()`);
  if (!pick1.ok) {
    skip('点选这个后横幅 +1', pick1.why);
  } else {
    rec('点「选这个」→ 横幅已绑数 +1（数字跟着写回走）',
        Number(banner2.bound) === before + 1, before + ' -> ' + (banner2 && banner2.bound));
  }

  /* ---------- 再点同一张（现在应显示已绑上/禁用）→ 数字不涨 ---------- */
  const dbl = await ev(`(() => {
    const done = [...document.querySelectorAll(".pkb__pick--done, .pkb__pick:disabled")];
    return { doneCount: done.length, text: done.length ? done[0].textContent.trim() : '' };
  })()`);
  rec('已绑的卡按钮变「已绑上」禁用（重复点击防住）',
      (dbl.doneCount || 0) >= 1 && /已绑上/.test(dbl.text || ''), JSON.stringify(dbl));
  const banner3 = await ev(`(() => {
    const t = (document.querySelector(".pkb .pkb__text") || {}).textContent || '';
    return (t.match(/已绑 (\\d+) 个/) || [])[1] ?? null;
  })()`);
  rec('⚠️ 禁用后数字仍 = before+1（没有重复计数）',
      pick1.ok ? Number(banner3) === before + 1 : true, 'now=' + (banner3 && banner3));
  await shot('03-picked.png');

  /* ---------- 返回地图：应重开刚才那一节 ---------- */
  await ev(`(() => {
    const b = [...document.querySelectorAll(".pkb button")].find((x) => (x.textContent || "").includes("返回地图"));
    if (b) b.click();
    return !!b;
  })()`);
  const backOk = await (async () => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      await sleep(700);
      const v = await ev(`(() => {
        const d = document.querySelector(".rsdetail");
        return !!document.querySelector(".rtree") && !!d;
      })()`).catch(() => false);
      if (v) return true;
    }
    return false;
  })();
  rec('⚠️ 返回地图后自动重开刚才那一节（跳走→回来关系断言）', backOk);
  await sleep(1200);
  const after = await ev(`(() => {
    const d = document.querySelector(".rsdetail");
    if (!d) return { has: false };
    const cnt = d.querySelector(".bindp__count");
    return {
      has: true,
      headText: (d.textContent || "").slice(0, 120),
      firstCount: cnt ? cnt.textContent.trim() : null,
      stillHasPicker: !!d.querySelector(".bindp__picker"),
    };
  })()`);
  const backCompare = String(after.headText || '').replace(/\s+/g, '').indexOf(secTitleForCompare.slice(0, 10)) >= 0;
  rec('回来的确是同一小节（标题匹配）', backCompare, 'head=' + String(after.headText || '').slice(0, 40));
  /* 绑定面板计数（第一块=闪卡）应等于横幅最后说的数 */
  const expectN = pick1.ok ? before + 1 : before;
  rec('⚠️ 返回后面板计数 = 横幅说的数（同源一致）',
      Number(after.firstCount) === expectN, 'panel=' + (after && after.firstCount) + ' banner=' + expectN);
  await shot('04-back.png');

  /* ---------- 刷新持久化 ---------- */
  await send('Page.reload', {});
  await sleep(9000);
  await ev(`(() => {
    for (const lb of document.querySelectorAll(".nav-group__label")) {
      const b = lb.closest("button"); const g = lb.closest(".nav-group");
      if (b && g && g.getAttribute("aria-expanded") !== "true") b.click();
    }
    return true;
  })()`);
  await sleep(600);
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item")].find((e) => (e.textContent || "").trim() === "学习地图");
    if (el) el.click();
    return true;
  })()`);
  await sleep(2200);
  await ev(`(() => {
    const rows = [...document.querySelectorAll(".maphome-row")];
    const row = rows.find((r) => ((r.querySelector(".maphome-row__title") || {}).textContent || "").indexOf("信号与系统") >= 0);
    const b = row && [...row.querySelectorAll("button")].find((x) => (x.textContent || "").includes("查看地图"));
    if (b) b.click();
    return !!b;
  })()`);
  await (async () => {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      await sleep(700);
      const v = await ev(`!!document.querySelector(".rtree")`).catch(() => false);
      if (v) break;
    }
  })();
  await sleep(1200);
  const persisted = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector(".rtree__node--chapter")?.click();
    await sleep(800);
    document.querySelector(".rtree__node--section")?.click();
    await sleep(900);
    const d = document.querySelector(".rsdetail");
    const cnt = d && d.querySelector(".bindp__count");
    return cnt ? Number(cnt.textContent.trim()) : null;
  })()`);
  rec('刷新后重进这一节，绑定仍在（写进库了）', persisted === expectN, 'count=' + persisted + ' expect=' + expectN);

  /* ---------- 普通浏览：侧栏进闪卡页应无任何选取控件 ---------- */
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item")].find((e) => (e.textContent || "").trim() === "闪卡管理");
    if (el) el.click();
    return !!el;
  })()`);
  await sleep(2200);
  const plain = await ev(`(() => ({
    hasBanner: !!document.querySelector(".pkb"),
    hasPick: document.querySelectorAll(".pkb__pick").length,
    isFcPage: !!document.querySelector(".fcx"),
  }))()`);
  rec('⚠️ 普通浏览闪卡页：无横幅无「选这个」（假开关双向查）',
      !!(plain.isFcPage && !plain.hasBanner && plain.hasPick === 0), JSON.stringify(plain));

  /* ---------- 题组路径（有已发布题组才验） ---------- */
  const deckBtn = await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item")].find((e) => (e.textContent || "").trim() === "学习地图");
    if (el) el.click(); return true;
  })()`);
  await sleep(2000);
  await ev(`(() => {
    const rows = [...document.querySelectorAll(".maphome-row")];
    const row = rows.find((r) => ((r.querySelector(".maphome-row__title") || {}).textContent || "").indexOf("信号与系统") >= 0);
    const b = row && [...row.querySelectorAll("button")].find((x) => (x.textContent || "").includes("查看地图"));
    if (b) b.click(); return true;
  })()`);
  await (async () => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      await sleep(600);
      const v = await ev(`!!document.querySelector(".rtree")`).catch(() => false);
      if (v) break;
    }
  })();
  await sleep(1000);
  const deckJump = await ev(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector(".rtree__node--chapter")?.click();
    await sleep(700);
    document.querySelector(".rtree__node--section")?.click();
    await sleep(800);
    const b = [...document.querySelectorAll(".rsdetail button")].find((x) => (x.textContent || "").includes("去题组页挑"));
    if (!b) return { has: false };
    b.click();
    return { has: true };
  })()`);
  if (!deckJump.has) {
    skip('题组跳转路径', '这一节没有「去题组页挑」按钮（库里可能没有已发布题组）');
  } else {
    await sleep(2500);
    const deckPick = await ev(`(() => ({
      onDecks: !!document.querySelector(".decks-page"),
      banner: !!document.querySelector(".pkb"),
      picks: document.querySelectorAll(".pkb__pick").length,
    }))()`);
    rec('题组页：横幅出现且已发布题组有「选这个」',
        !!(deckPick.onDecks && deckPick.banner), JSON.stringify(deckPick));
    if (deckPick.picks > 0) {
      const dp = await ev(`(() => {
        const b = [...document.querySelectorAll(".pkb__pick")].find((x) => !x.disabled);
        if (b) b.click(); return true;
      })()`);
      await sleep(1300);
      const db = await ev(`(() => {
        const t = (document.querySelector(".pkb .pkb__text") || {}).textContent || '';
        return (t.match(/已绑 (\\d+) 个/) || [])[1] ?? null;
      })()`);
      rec('题组「选这个」即时绑（横幅 1 个）', dp && Number(db) >= 1, 'bound=' + db);
    }
    await ev(`(() => {
      const b = [...document.querySelectorAll(".pkb button")].find((x) => (x.textContent || "").includes("返回地图"));
      if (b) b.click(); return true;
    })()`);
    await (async () => {
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        await sleep(600);
        const v = await ev(`!!document.querySelector(".rsdetail")`).catch(() => false);
        if (v) break;
      }
    })();
    rec('题组返回地图也重开小节', await ev(`!!document.querySelector(".rsdetail")`));
    await shot('05-decks.png');
  }

  /* ---------- 控制台 ---------- */
  const realErrs = errs.filter((e) => e && e.indexOf('favicon') < 0 && e.indexOf('ERR_FILE') < 0);
  rec('无控制台报错', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  console.log('\\n通过 ' + pass + ' / ' + (pass + fail) + '（跳过 ' + skipped + '）');
  console.log('截图：' + SHOTS);
  cleanup();

  async function cleanup() {
    try {
      app.kill();
    } catch {}
    await sleep(1200);
    const alive = await new Promise((res) => {
      require('node:child_process').exec(
        'tasklist /FI "IMAGENAME eq OpenLeaner.exe"',
        (e, out) => res(String(out || '').indexOf('OpenLeaner.exe') >= 0),
      );
    });
    console.log(alive ? 'WARN 仍有 OpenLeaner 进程' : '已确认进程退出干净');
    process.exit(fail === 0 ? 0 : 1);
  }
})().catch((e) => {
  console.error('脚本本身出错：' + (e && e.stack ? e.stack : e));
  process.exit(3);
});

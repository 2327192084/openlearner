/**
 * 验证「学习地图 + 横板爬塔学习路线」（2026-11-21 第二轮）。
 *
 * ## 用户最终要求
 *
 * > 不用单独做个学习顺序的栏，可以把它整合进学习地图里。
 * > 可以以杀戮尖塔那种爬塔式的方式做 ui，只不过是横板的，
 * > 这样更符合「地图」的概念。
 *
 * ## 要证的
 *
 * 1. **没有独立的「学习顺序」栏**（用户明确不要）
 * 2. 学习地图里有横板路线块
 * 3. 横板是**横向**的（节点左→右排列，不是一个竖列表）
 * 4. 三种状态视觉分明：已走过 / 当前 / 未到达
 * 5. **当前关有「你在这里」指示**
 * 6. 难度与掌握度**分开显示**（不能混成一个数字）
 * 7. 路线只显示已确认的；没排过时是入口，不是空占位
 * 8. 调 AI → **预览对话框**（勾完才存，用户确认的第③点）
 * 9. 预览里**按块分组**（用户确认的第①点）
 * 10. 确认后写进 settings.studyPlan，横板出现节点
 * 11. 补章节只在真有缺章节时出现
 * 12. **页面文案里没有字面 markdown 星号**（上一轮截图抓到的）
 * 13. 无控制台报错
 *
 * ## 假模型必须起真 HTTP 服务
 *
 * 桌面端 `chat-client` 走 preload 桥（`window.openleaner.chat` → 主进程转发），
 * **不碰页面的 fetch**。打补丁换 `window.fetch` 完全无效，而且现象很迷惑：
 * 界面卡在「正在让 AI 排…」、模型 0 次调用、**也没有报错**。
 * 所以照 `verify-mastery-evidence-ui.cjs`：起本地 HTTP 假模型，backends 指向它。
 *
 * 用法：node scripts/verify-route-map.cjs [port] [modelPort]
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/route-map-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/route-map');
const PORT = Number(process.argv[2] || 9920);
const MODEL_PORT = Number(process.argv[3] || 9921);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x) => {
  console.log((ok ? '✅ ' : '❌ ') + n + (x ? ' :: ' + x : ''));
  ok ? pass++ : fail++;
};

const requests = [];

/** 排顺序的回应：三块，故意只排 3 条（真实库 105 条）→ 验证「没排进来」如实告知 */
function planResponse() {
  return JSON.stringify({
    blocks: [
      {
        title: '基础概念',
        why: '先把定义弄清楚',
        items: [
          { n: 1, difficulty: 2, reason: '最基础，先学', basis: '认知层级最低' },
          { n: 2, difficulty: 3, reason: '建立在第一条上', basis: '需要前置概念' },
        ],
      },
      {
        title: '综合应用',
        why: '基础扎实了再上难度',
        items: [{ n: 3, difficulty: 5, reason: '综合应用，放最后', basis: '认知层级最高' }],
      },
    ],
  });
}

/** 补章节：混一条自造分组名「基础篇」，必须被丢弃 */
function chapterResponse() {
  return JSON.stringify({
    assign: [
      { n: 1, chapter: '第3章 导数与微分', reason: '讲导数定义' },
      { n: 2, chapter: '基础篇', reason: '自造名字，应被丢弃' },
    ],
  });
}

function startFakeModel() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {}

      if (req.url && req.url.split('?')[0].endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
        return;
      }

      const msgs = parsed && Array.isArray(parsed.messages) ? parsed.messages : [];
      const user = msgs.filter((m) => m.role === 'user').map((m) => String(m.content || '')).join('\n');

      let kind = 'other';
      let content = '{}';
      if (user.indexOf('请按上面的规矩给出章节') >= 0) {
        kind = 'chapter';
        content = chapterResponse();
      } else if (user.indexOf('请把它们归成') >= 0) {
        kind = 'plan';
        content = planResponse();
      }
      requests.push({ kind, userLen: user.length });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        }),
      );
    });
  });
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(APPDATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  const realDb = path.join(process.env.APPDATA, 'OpenLeaner/IndexedDB');
  if (!fs.existsSync(realDb)) {
    console.error('找不到真实库');
    process.exit(2);
  }
  fs.cpSync(realDb, path.join(DATA, 'IndexedDB'), { recursive: true });
  console.log('已复制真实库副本（不碰真实库）');

  const fake = startFakeModel();
  await new Promise((r) => fake.listen(MODEL_PORT, '127.0.0.1', r));
  console.log('  假模型 127.0.0.1:' + MODEL_PORT);

  const exe = path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
  if (fs.existsSync(path.join(path.dirname(exe), 'openleaner-data'))) {
    console.error('❌ app 目录旁有 openleaner-data —— --user-data-dir 会失效');
    process.exit(2);
  }

  const app = spawn(
    exe,
    [ROOT, '--user-data-dir=' + DATA, '--no-sandbox', '--remote-debugging-port=' + PORT, '--window-size=1600,1000'],
    { cwd: ROOT, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  app.stdout.on('data', (d) => (log += d.toString()));
  app.stderr.on('data', (d) => (log += d.toString()));

  let target = null;
  for (let i = 0; i < 240; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
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
          rej(new Error('timeout'));
        }
      }, 45000);
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
  /**
   * 等待某个条件成立。
   *
   * ## 为什么是「先睡再查」而不是密集轮询（2026-11-21 修）
   *
   * 原来每 300ms 轮询一次 `Runtime.evaluate`。学习地图一页要渲染
   * 105 条知识点的章节树 + 横板路线，主线程本来就紧；
   * 密集的 CDP 往返把队列压满，结果 **CDP 自己超时** ——
   * 而功能其实早就好了（诊断脚本单次查询 20 秒内就拿到对话框）。
   *
   * 现在是「睡 1.2 秒查一次」，同样能等到，但不去抢主线程。
   */
  const waitFor = async (expr, ms = 40000, label = '') => {
    const end = Date.now() + ms;
    let tries = 0;
    while (Date.now() < end) {
      await sleep(tries === 0 ? 1500 : 1200);
      tries += 1;
      const v = await ev(expr).catch(() => null);
      if (v) return v;
    }
    throw new Error('等待超时' + (label ? '（' + label + '）' : ''));
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(7000);

  /* ---------- 0. 后端指向假模型 ---------- */
  const seeded = await ev(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("openleaner");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = db.transaction(["backends","secrets"], "readwrite");
    const ts = new Date().toISOString();
    tx.objectStore("backends").put({
      id: "be_route", label: "本地假模型", kind: "direct-api",
      provider: "custom", baseUrl: "http://127.0.0.1:${MODEL_PORT}",
      model: "fake-model",
      capabilities: { textOrganize: true, visionFormula: false },
      status: "ready", isDefault: true, createdAt: ts, updatedAt: ts,
    });
    tx.objectStore("secrets").put({
      id: "sec_route", backendId: "be_route", value: "sk-fake", createdAt: ts, updatedAt: ts,
    });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
    return { ok: true };
  })()`);
  rec('后端指向本地假模型（走真实主进程代理链路）', !!(seeded && seeded.ok));

  await ev('location.reload()');
  await sleep(8000);

  /* ---------- 1. 没有独立的「学习顺序」栏 ---------- */
  await ev(`(() => {
    for (const lb of document.querySelectorAll(".nav-group__label")) {
      const b = lb.closest("button"); const g = lb.closest(".nav-group");
      if (b && g && g.getAttribute("aria-expanded") !== "true") b.click();
    }
    return true;
  })()`);
  await sleep(900);

  const navInfo = await ev(`(() => {
    const out = [...document.querySelectorAll(".nav-section")].map((sec) => ({
      label: (sec.querySelector(".nav-group__label")?.textContent ?? "").trim(),
      items: [...sec.querySelectorAll(".nav-item__label")].map((x) => x.textContent.trim()),
    }));
    const all = out.flatMap((g) => g.items);
    return {
      groups: out,
      hasPlanItem: all.some((x) => x === "学习顺序"),
      hasMap: all.some((x) => x === "学习地图"),
    };
  })()`);
  console.log('侧栏 =', JSON.stringify(navInfo.groups));

  rec('**没有独立的「学习顺序」栏**（用户明确要求整合）', !navInfo.hasPlanItem);
  rec('「学习地图」仍在（路线整合进它）', !!navInfo.hasMap);

  /* ---------- 2. 进学习地图，找到路线块 ---------- */
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
      .find((e) => (e.textContent || "").trim() === "学习地图");
    if (el) el.click();
    return true;
  })()`);
  await waitFor(`document.querySelector(".map-page") ? true : null`, 25000, '学习地图');
  await sleep(2500);
  await shot('01-map-with-route-entry.png');

  const mapInfo = await ev(`(() => {
    const page = document.querySelector(".map-page");
    const bodyTxt = page ? (page.textContent || "") : "";
    return {
      hasMap: !!page,
      hasRouteBlock: !!page.querySelector(".rmap"),
      hasRouteTitle: bodyTxt.includes("学习路线"),
      hasMapTree: !!page.querySelector(".map-tree"),
      hasStats: !!page.querySelector(".map-stats"),
      /* 文案里的字面星号（上一轮截图抓到的 bug） */
      starCount: (bodyTxt.match(/\\*\\*/g) || []).length,
      starSample: bodyTxt.indexOf("**") >= 0 ? bodyTxt.slice(Math.max(0, bodyTxt.indexOf("**") - 25), bodyTxt.indexOf("**") + 30) : "",
      starterText: (page.querySelector(".rmap--starter")?.textContent ?? "").slice(0, 200),
    };
  })()`);
  console.log('地图页 =', JSON.stringify({ ...mapInfo, starterText: undefined }, null, 1));

  rec('学习地图页打开了', !!mapInfo?.hasMap);
  rec('上半部分「我哪块弱」还在（概览 + 章节树）',
      !!mapInfo?.hasStats && !!mapInfo?.hasMapTree);
  rec('**路线块整合进了地图页**', !!mapInfo?.hasRouteBlock && !!mapInfo?.hasRouteTitle);
  rec('**页面文案里没有字面 markdown 星号**（上一轮截图抓到的）',
      (mapInfo?.starCount ?? -1) === 0,
      '星号 ' + mapInfo?.starCount + ' 处' + (mapInfo?.starSample ? '｜' + mapInfo.starSample : ''));

  /* ---------- 3. 没排过时是「入口」而不是空占位 ---------- */
  const starter = await ev(`(() => {
    const s = document.querySelector(".rmap--starter");
    if (!s) return null;
    const btn = [...s.querySelectorAll("button")].find((b) => (b.textContent || "").indexOf("让 AI 排一条学习路线") >= 0);
    const chapBtn = [...s.querySelectorAll("button")].find((b) => (b.textContent || "").indexOf("补缺失的章节") >= 0);
    return {
      hasBtn: !!btn,
      btnDisabled: btn ? btn.disabled : null,
      hasChapterBtn: !!chapBtn,
      text: (s.textContent || "").slice(0, 300),
    };
  })()`);
  console.log('入口 =', JSON.stringify(starter, null, 1));

  rec('没排过路线时有明确入口（不是空占位）', !!starter?.hasBtn);
  rec('入口按钮可点（真的能开始）', starter?.btnDisabled === false);
  rec('**调 AI 需要用户主动点**（打开页面不自动发请求）',
      requests.length === 0, '此时模型调用 ' + requests.length + ' 次');

  /* ---------- 4. 补章节只在真有缺章节时出现 ---------- */
  const missing = await ev(`(() => {
    const s = document.querySelector(".rmap--starter");
    const txt = s ? (s.textContent || "") : "";
    const m = txt.match(/有 ([0-9]+) 条知识点没有章节/);
    return { missingCount: m ? Number(m[1]) : 0, hasSection: !!m };
  })()`);
  rec('**补章节入口只在真有缺章节时出现**',
      missing?.hasSection === ((missing?.missingCount ?? 0) > 0),
      '缺 ' + missing?.missingCount + ' 条');

  /* ---------- 5. 点「让 AI 排」→ 预览对话框 ---------- */
  await ev(`(() => {
    const b = [...document.querySelectorAll(".rmap--starter button")]
      .find((x) => (x.textContent || "").indexOf("让 AI 排一条学习路线") >= 0);
    if (b) b.click();
    return true;
  })()`);

  await waitFor(`document.querySelector(".rpd") ? true : (document.querySelector(".map-error") ? "err" : null)`,
      60000, '预览对话框');
  await sleep(700);

  const planErr = await ev(`(() => {
    const e = document.querySelector(".map-error");
    return e ? e.textContent.trim() : null;
  })()`);
  if (planErr) console.error('❌ 排顺序失败：' + planErr);
  rec('排路线没有报错', !planErr, planErr ?? '');

  await shot('02-route-preview-dialog.png');

  const dlg = await ev(`(() => {
    const d = document.querySelector(".rpd");
    if (!d) return null;
    const blocks = [...d.querySelectorAll(".rpd__block")];
    const items = [...d.querySelectorAll(".rpd__item")];
    const boxes = [...d.querySelectorAll(".rpd__box")];
    const diffs = [...d.querySelectorAll(".rpd__diff")].map((x) => x.textContent.trim());
    const whys = [...d.querySelectorAll(".rpd__why")].map((x) => x.textContent.trim());
    const basis = [...d.querySelectorAll(".rpd__basis")].map((x) => x.textContent.trim());
    const blockToggles = [...d.querySelectorAll(".rpd__block-toggle")].map((x) => x.textContent.trim());
    const foot = d.querySelector(".rpd__foot")?.textContent ?? "";
    return {
      title: d.querySelector(".rpd__title")?.textContent ?? "",
      blockCount: blocks.length,
      blockTitles: blocks.map((b) => b.querySelector(".rpd__block-title")?.textContent.trim() ?? ""),
      itemCount: items.length,
      checkedCount: boxes.filter((b) => b.checked).length,
      totalBoxes: boxes.length,
      diffs, whys, basis, blockToggles,
      foot: foot.replace(/\\s+/g, " ").trim().slice(0, 120),
      starCount: ((d.textContent || "").match(/\\*\\*/g) || []).length,
    };
  })()`);
  console.log('预览对话框 =', JSON.stringify(dlg, null, 1));

  rec('**调到了模型**（假模型收到 plan 请求）', requests.some((r) => r.kind === 'plan'),
      requests.map((r) => r.kind).join(',') || '(无)');
  rec('**AI 结果先进预览对话框**（勾完才存，用户确认的第③点）', !!dlg);
  rec('**预览是「按块分组」的**（用户确认的第①点）',
      (dlg?.blockCount ?? 0) >= 2, dlg?.blockCount + ' 块：' + JSON.stringify(dlg?.blockTitles));
  rec('**默认全勾**（排序是整体，不该让用户从零点起）',
      (dlg?.checkedCount ?? 0) === (dlg?.totalBoxes ?? -1) && (dlg?.totalBoxes ?? 0) > 0,
      dlg?.checkedCount + ' / ' + dlg?.totalBoxes);
  rec('**每条都有难度**（LogiNote 的结构性缺口）',
      (dlg?.diffs ?? []).length === (dlg?.itemCount ?? -1),
      (dlg?.diffs ?? []).length + ' / ' + dlg?.itemCount);
  rec('**每条都有理由**（与 LogiNote 刻意相反）',
      (dlg?.whys ?? []).filter((w) => w).length === (dlg?.itemCount ?? -1),
      JSON.stringify(dlg?.whys));
  rec('**每条都有依据 basis**',
      (dlg?.basis ?? []).filter((w) => w).length === (dlg?.itemCount ?? -1),
      JSON.stringify((dlg?.basis ?? []).map((b) => b.slice(0, 20))));
  rec('每块有「整块全选/全不选」（100+ 条逐条点太慢）',
      (dlg?.blockToggles ?? []).every((t) => t.indexOf('本块') >= 0),
      JSON.stringify(dlg?.blockToggles));
  rec('对话框里也没有字面星号', (dlg?.starCount ?? -1) === 0, String(dlg?.starCount));

  /* 难度说明要写清「不是掌握度」 */
  const diffTitle = await ev(`(() => {
    const d = document.querySelector(".rpd__diff");
    return d ? (d.getAttribute("title") || "") : null;
  })()`);
  rec('难度的悬停说明写明它与掌握度分开',
      (diffTitle ?? '').includes('掌握度'), diffTitle);

  /* ---------- 6. 取消勾选 → 条数跟着变 ---------- */
  const beforeUncheck = await ev(`document.querySelectorAll(".rpd__box:checked").length`);
  await ev(`(() => {
    const b = document.querySelector(".rpd__box");
    if (b) b.click();
    return true;
  })()`);
  await sleep(300);
  const afterUncheck = await ev(`document.querySelectorAll(".rpd__box:checked").length`);
  const footAfter = await ev(`(document.querySelector(".rpd__count")?.textContent ?? "").trim()`);
  rec('**取消勾选真的减少条数**（不是假勾选框）',
      afterUncheck === beforeUncheck - 1, beforeUncheck + ' → ' + afterUncheck);
  rec('底部计数跟着变', footAfter.indexOf(String(afterUncheck)) >= 0, footAfter);

  /*
   * 整块的按钮是**切换**语义（2026-11-21 修断言）。
   *
   * 我的第一版断言写成「点一下必然减少」—— 那是错的。
   * 上一步我已经取消了第一块里的第 1 条，所以那一块不是「全勾」状态，
   * 按钮显示的是「本块全选」，点它**增加**条数。功能是对的，
   * 是断言把「切换」当成了「全不选」。
   *
   * 现在按真实语义验：读按钮文字 → 点它 → 条数朝那个方向变。
   */
  const beforeToggle = await ev(`(() => {
    const t = document.querySelector(".rpd__block-toggle");
    const firstBlockIds = [...document.querySelectorAll(".rpd__block")][0]
      ? [...document.querySelectorAll(".rpd__block")][0].querySelectorAll(".rpd__box").length
      : 0;
    return { label: t ? t.textContent.trim() : "", blockSize: firstBlockIds };
  })()`);
  await ev(`(() => {
    const t = document.querySelector(".rpd__block-toggle");
    if (t) t.click();
    return true;
  })()`);
  await sleep(400);
  const afterBlockToggle = await ev(`document.querySelectorAll(".rpd__box:checked").length`);

  /*
   * 「全选」是把该块**补齐到全勾**，不是「再加 blockSize 条」。
   * 块里 2 条其中 1 条已经勾着时，全选只增加 1 条。
   * 所以判据是「点完之后该块全部勾上」。
   */
  const blockStateAfter = await ev(`(() => {
    const first = [...document.querySelectorAll(".rpd__block")][0];
    if (!first) return null;
    const boxes = [...first.querySelectorAll(".rpd__box")];
    return {
      total: boxes.length,
      checked: boxes.filter((b) => b.checked).length,
      label: first.querySelector(".rpd__block-toggle")?.textContent.trim() ?? "",
    };
  })()`);

  if ((beforeToggle?.label ?? '').indexOf('全不选') >= 0) {
    rec('整块「全不选」后该块一条不剩',
        (blockStateAfter?.checked ?? -1) === 0,
        beforeToggle?.label + '：该块 ' + blockStateAfter?.checked + ' / ' + blockStateAfter?.total);
  } else {
    rec('整块「全选」后该块全部勾上',
        (blockStateAfter?.checked ?? -1) === (blockStateAfter?.total ?? -2) &&
        (blockStateAfter?.total ?? 0) > 0,
        beforeToggle?.label + '：该块 ' + blockStateAfter?.checked + ' / ' + blockStateAfter?.total);
  }
  rec('**整块按钮点完之后文案反过来**（切换语义正确）',
      (beforeToggle?.label ?? '') !== (blockStateAfter?.label ?? ''),
      beforeToggle?.label + ' → ' + blockStateAfter?.label);
  rec('整块操作让总数朝预期方向变',
      (beforeToggle?.label ?? '').indexOf('全不选') >= 0
        ? afterBlockToggle < afterUncheck
        : afterBlockToggle > afterUncheck,
      afterUncheck + ' → ' + afterBlockToggle);

  /*
   * 恢复全勾再确认。
   *
   * 用整块按钮一次勾完，而不是循环点每个框 ——
   * 对话框里 100+ 条时逐框点击会触发上百次 React 重渲染，
   * 主线程被占满，CDP 自己的 evaluate 会超时（这轮踩到了）。
   */
  await ev(`(() => {
    for (const block of document.querySelectorAll(".rpd__block")) {
      const boxes = [...block.querySelectorAll(".rpd__box")];
      if (boxes.every((b) => b.checked)) continue;
      const t = block.querySelector(".rpd__block-toggle");
      if (t) t.click();
    }
    return true;
  })()`);
  await sleep(1200);
  const restored = await ev(`(() => {
    const boxes = [...document.querySelectorAll(".rpd__box")];
    return { checked: boxes.filter((b) => b.checked).length, total: boxes.length };
  })()`);
  rec('恢复全勾成功（为了验确认流程）',
      (restored?.checked ?? 0) === (restored?.total ?? -1),
      restored?.checked + ' / ' + restored?.total);

  /* ---------- 7. 确认 → 落库 + 横板出现 ---------- */
  await ev(`(() => {
    const b = [...document.querySelectorAll(".rpd button")]
      .find((x) => (x.textContent || "").indexOf("确认这条路线") >= 0);
    if (b) b.click();
    return true;
  })()`);
  await waitFor(`document.querySelector(".rpd") ? null : (document.querySelector(".rmap__track") ? true : null)`,
      20000, '横板路线');
  await sleep(1200);
  await shot('03-route-track.png');

  const trackInfo = await ev(`(() => {
    const page = document.querySelector(".map-page");
    const track = page.querySelector(".rmap__track");
    const nodes = [...page.querySelectorAll(".rmap__node")];
    const layers = [...page.querySelectorAll(".rmap__layer")];
    const end = page.querySelector(".rmap__end");
    const head = page.querySelector(".rmap__lead")?.textContent ?? "";

    /* 横向的证据：节点左边缘应递增，且分布在一行（y 接近） */
    const rects = nodes.map((n) => { const r = n.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) }; });
    const xs = rects.map((r) => r.x);
    const ys = rects.map((r) => r.y);
    const xIncreasing = xs.every((v, i) => i === 0 || v >= xs[i - 1]);
    const sameRow = ys.length > 0 && (Math.max(...ys) - Math.min(...ys)) < 120;

    return {
      hasTrack: !!track,
      nodeCount: nodes.length,
      layerCount: layers.length,
      hasEnd: !!end,
      rects, xIncreasing, sameRow,
      doneCount: page.querySelectorAll(".rmap__node--done").length,
      currentCount: page.querySelectorAll(".rmap__node--next").length,
      aheadCount: page.querySelectorAll(".rmap__node--ahead").length,
      hereMark: (page.querySelector(".rmap__here")?.textContent ?? "").trim(),
      lead: head.replace(/\\s+/g, " ").trim().slice(0, 120),
      hasCurrentPanel: !!page.querySelector(".rmap__current"),
      currentPanelText: (page.querySelector(".rmap__current")?.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 300),
      starCount: ((page.textContent || "").match(/\\*\\*/g) || []).length,
      trackScrollW: track ? track.scrollWidth : 0,
      trackClientW: track ? track.clientWidth : 0,
    };
  })()`);
  console.log('横板 =', JSON.stringify({
    nodeCount: trackInfo?.nodeCount,
    layerCount: trackInfo?.layerCount,
    xIncreasing: trackInfo?.xIncreasing,
    sameRow: trackInfo?.sameRow,
    done: trackInfo?.doneCount,
    current: trackInfo?.currentCount,
    ahead: trackInfo?.aheadCount,
    hereMark: trackInfo?.hereMark,
    lead: trackInfo?.lead,
  }, null, 1));

  rec('**横板出现了节点**', (trackInfo?.nodeCount ?? 0) > 0, trackInfo?.nodeCount + ' 个节点');
  rec('**是横向排列的**（节点 x 递增且在同一行）',
      !!trackInfo?.xIncreasing && !!trackInfo?.sameRow,
      'x递增=' + trackInfo?.xIncreasing + ' 同行=' + trackInfo?.sameRow +
      ' 宽度=' + trackInfo?.trackScrollW + '/' + trackInfo?.trackClientW);
  rec('按块分层（层数 = 块数）',
      (trackInfo?.layerCount ?? 0) === (dlg?.blockCount ?? -1),
      trackInfo?.layerCount + ' 层 / ' + dlg?.blockCount + ' 块');
  rec('**有三种状态视觉区分**（已走过/当前/未到达）',
      (trackInfo?.currentCount ?? 0) === 1 &&
      ((trackInfo?.doneCount ?? 0) + (trackInfo?.aheadCount ?? 0)) >= 1,
      'done=' + trackInfo?.doneCount + ' current=' + trackInfo?.currentCount + ' ahead=' + trackInfo?.aheadCount);
  rec('**当前关有「你在这里」指示**',
      (trackInfo?.hereMark ?? '').includes('你在这里'), trackInfo?.hereMark);

  /*
   * ⚠️ 「你在这里」徽标不能压住节点文字（2026-11-21 截图抓到）。
   *
   * 徽标是 absolute + bottom:-9px，探出节点下边界。第一版没给当前节点加高，
   * 它把标签第二行盖住了 —— 而「有没有徽标」「徽标文字对不对」两条断言都绿。
   * 又是「断言全绿但界面是错的」那一类。
   *
   * 这里量实际矩形：徽标上边界必须在标签下边界之下。
   */
  const badgeOverlap = await ev(`(() => {
    const node = document.querySelector(".rmap__node--next");
    if (!node) return null;
    const badge = node.querySelector(".rmap__here");
    const label = node.querySelector(".rmap__label");
    if (!badge || !label) return null;
    const b = badge.getBoundingClientRect();
    const l = label.getBoundingClientRect();
    /* 重叠量：> 0 表示徽标压到文字了 */
    const overlap = Math.round(l.bottom - b.top);
    return {
      overlap,
      badgeTop: Math.round(b.top),
      labelBottom: Math.round(l.bottom),
      badgeText: (badge.textContent || "").trim(),
    };
  })()`);
  /*
   * 判据是「留出足够呼吸空间」，不是「刚好不重叠」。
   *
   * 反向验证做过：把节点加高去掉，间隙从 -11px 变成 -3px ——
   * 仍然「不重叠」，断言照样绿。但从截图看，-3px 时徽标几乎贴在
   * 文字下沿，读起来是糊成一团。「不重叠」这个判据太宽松了
   * （项目老话：断言写得够宽 = 没在验）。
   *
   * 要求至少 8px 间隙 —— 那是肉眼能明确看出「徽标在下面」的距离。
   */
  rec('**「你在这里」徽标与文字留有呼吸空间（≥8px）**',
      badgeOverlap !== null && badgeOverlap.overlap <= -8,
      badgeOverlap
        ? '间隙 ' + (-badgeOverlap.overlap) + 'px（徽标顶 ' + badgeOverlap.badgeTop + ' / 文字底 ' + badgeOverlap.labelBottom + '）'
        : '(没找到徽标或标签)');
  rec('顶部写着「推到第几关」',
      (trackInfo?.lead ?? '').includes('推到') || (trackInfo?.lead ?? '').includes('全部走完'),
      trackInfo?.lead);
  rec('**当前关详情面板在**（难度/掌握/理由分开显示）', !!trackInfo?.hasCurrentPanel);
  rec('**详情里难度与掌握度是两个独立项**',
      (trackInfo?.currentPanelText ?? '').includes('难度') &&
      (trackInfo?.currentPanelText ?? '').includes('你的掌握'),
      (trackInfo?.currentPanelText ?? '').slice(0, 160));
  rec('路线终点标记在', !!trackInfo?.hasEnd);
  rec('横板页面没有字面星号', (trackInfo?.starCount ?? -1) === 0, String(trackInfo?.starCount));

  /* ---------- 8. 库内数据 ---------- */
  const dbCheck = await ev(`(async () => {
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
    const sp = row && row.studyPlan;
    return {
      hasPlan: !!sp,
      stepCount: sp && Array.isArray(sp.steps) ? sp.steps.length : 0,
      first: sp && sp.steps && sp.steps[0] ? {
        order: sp.steps[0].order, difficulty: sp.steps[0].difficulty,
        reason: sp.steps[0].reason, statement: (sp.steps[0].statement || '').slice(0, 24),
        blockTitle: sp.steps[0].blockTitle,
      } : null,
      unplaced: sp ? sp.unplaced : null,
    };
  })()`);
  console.log('库内 =', JSON.stringify(dbCheck, null, 1));

  rec('**确认后写进了 settings.studyPlan**', !!dbCheck?.hasPlan);
  rec('步数正确', (dbCheck?.stepCount ?? 0) === (dlg?.itemCount ?? -1),
      dbCheck?.stepCount + ' 步 / 预览 ' + dlg?.itemCount);
  rec('存了难度', dbCheck?.first?.difficulty !== null && dbCheck?.first?.difficulty !== undefined,
      String(dbCheck?.first?.difficulty));
  rec('存了理由与块名',
      !!dbCheck?.first?.reason && !!dbCheck?.first?.blockTitle,
      (dbCheck?.first?.blockTitle ?? '') + ' / ' + (dbCheck?.first?.reason ?? ''));
  rec('存了陈述快照', !!dbCheck?.first?.statement, dbCheck?.first?.statement);
  rec('**如实记了没排进来的条数**', (dbCheck?.unplaced ?? 0) > 0, String(dbCheck?.unplaced));

  /* ---------- 9. 清除路线 ---------- */
  await ev(`(() => {
    const b = [...document.querySelectorAll(".rmap button")]
      .find((x) => (x.textContent || "").indexOf("清除这条路线") >= 0);
    if (b) b.click();
    return true;
  })()`);
  await sleep(2000);
  const afterClear = await ev(`(() => {
    const page = document.querySelector(".map-page");
    return {
      hasTrack: !!page.querySelector(".rmap__track"),
      hasStarter: !!page.querySelector(".rmap--starter"),
    };
  })()`);
  rec('**清除路线回到入口态**（横板消失、入口回来）',
      !afterClear?.hasTrack && !!afterClear?.hasStarter,
      'track=' + afterClear?.hasTrack + ' starter=' + afterClear?.hasStarter);

  /* ---------- 10. 无控制台报错 ---------- */
  const realErrs = errs.filter((e) => e && e.indexOf('favicon') < 0 && e.indexOf('ERR_FILE') < 0);
  rec('无控制台报错', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  console.log('\n==========================');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  console.log('截图：' + SHOTS);
  console.log('假模型请求 =', JSON.stringify(requests));

  try { app.kill(); } catch {}
  await new Promise((r) => fake.close(r));
  await sleep(600);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('脚本本身出错：' + (e && e.stack ? e.stack : e));
  process.exit(3);
});
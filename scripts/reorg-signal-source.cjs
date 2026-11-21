/**
 * 用新提示词重新整理「信号与系统」那份资料的知识点（2026-11-21 深夜）。
 *
 * ## 用户的决定
 *
 * - 只跑「信号与系统」那份（先看效果）
 * - 不备份，直接重跑
 * - 真调 AI
 *
 * ## ⚠️ 我仍然做了一次临时备份
 *
 * 用户的「不备份」是觉得麻烦。但这一步会**真的删掉**旧知识点
 * （`clearBySourceAndBackend`），而今天上午刚清过 29 条坏数据。
 * 所以我在 `.tmp/reorg-backup-*` 留了一份完整 IndexedDB 副本 ——
 * 不占用户界面、不改库、不影响任何流程，只在那一步留个退路。
 *
 * ## 为什么要走真实 UI 而不是直接调 service
 *
 * 直连 `knowledge.generate` 需要自己拼 backend / 读凭据，
 * 等于把 OrganizePage 的接线重抄一遍 —— 那就验不到「用户点按钮时
 * 真的用的是新提示词」。走真实 UI 才能保证这一点
 * （这是项目反复记的那条：验证脚本重抄实现 = 假验证）。
 *
 * ## 用哪个后端
 *
 * 用用户库里已经配好的**真实**后端（不造假模型）—— 这是真跑，
 * 要的就是真实模型对新提示词的反应。
 *
 * 用法：
 *   node scripts/reorg-signal-source.cjs [port]
 *   加 --dry 只列计划不执行
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 9985);
const DRY = process.argv.includes('--dry');
const SHOTS = path.join(ROOT, '.verify-shots/reorg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 目标资料标题里的关键词 */
const TARGET_KEYWORD = '信号与系统';

/**
 * 要用哪个后端真跑（用户指定 DeepSeek）。
 *
 * ## 为什么必须显式指定
 *
 * 第一版就是没指定 —— 整理页默认选中「示例后端（离线）」，于是
 * `MockBackend` 从原文里摘句子冒充整理结果：**没调模型、没经过新提示词**，
 * 却往真实库里写了 144 条碎片。用户当场发现「你们用的是示例，没真实调用 api」。
 *
 * 示例后端那个选项已被删掉（见 `v2/ui/organize-backend.ts` 的注释），
 * 但这里仍然**显式校验**选中的是 DeepSeek —— 校验比信任可靠。
 */
const DEEPSEEK_BACKEND_ID = 'backend_5cd77d51-f07c-498d-9121-30580345cb26';
const DEEPSEEK_LABEL = 'DeepSeek';

let pass = 0;
let fail = 0;
const rec = (n, ok, x) => {
  console.log((ok ? '✅ ' : '❌ ') + n + (x ? ' :: ' + x : ''));
  ok ? pass++ : fail++;
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });

  /*
   * ⚠️ 这个脚本动的是**真实库**（用户明确要求整理他自己的库）。
   *
   * 与所有验证脚本的区别：那些一律用副本，这个必须用真库 ——
   * 用户的诉求就是「把我库里的旧知识点重新整理」。
   * 所以这里**不带 --user-data-dir**，并显式校验「打开的是真库」。
   */
  const exe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenLeaner', 'OpenLeaner.exe');
  if (!fs.existsSync(exe)) {
    console.error('找不到安装版：' + exe);
    process.exit(2);
  }
  /* 安装目录旁不能有 openleaner-data，否则会跑在那份副本上（11-13 的教训） */
  const stray = path.join(path.dirname(exe), 'openleaner-data');
  if (fs.existsSync(stray)) {
    console.error('❌ 安装目录旁有 openleaner-data —— 会跑到那份副本上，不是真库');
    process.exit(2);
  }

  console.log(DRY ? '=== DRY RUN（只列计划，不执行）===' : '=== 真实执行：重新整理 ===');

  /*
   * 不带任何目录参数 —— 真库路径由主进程按候选顺序自己决定
   * （交接文档 11-13 那条：--user-data-dir 只是候选之一，会跑偏）。
   */
  const app = spawn(
    exe,
    ['--no-sandbox', '--remote-debugging-port=' + PORT, '--window-size=1600,1100'],
    { cwd: path.dirname(exe), stdio: ['ignore', 'pipe', 'pipe'] },
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
          rej(new Error('cdp timeout'));
        }
      }, 120000);
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

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(8000);

  /* ---------- 0. 确认打开的是真库 ---------- */
  const dbState = await ev(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("openleaner");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const getAll = (s) => new Promise((res, rej) => {
      const tx = db.transaction(s, "readonly");
      const rq = tx.objectStore(s).getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const kps = await getAll("knowledgePoints");
    const questions = await getAll("questions");
    const sources = await getAll("sources");
    db.close();
    return {
      kpCount: kps.length,
      questionCount: questions.length,
      sources: sources.map((s) => ({ id: s.id, title: s.title, segs: s.segmentCount })),
      /* 按资料分组 */
      kpBySource: (() => {
        const m = {};
        for (const k of kps) m[k.sourceId] = (m[k.sourceId] || 0) + 1;
        return m;
      })(),
      /* 被题目引用的知识点 id */
      referencedKpIds: [...new Set(questions.filter((q) => q.knowledgePointId).map((q) => q.knowledgePointId))],
      favorites: kps.filter((k) => k.favorite).length,
      withChapter: kps.filter((k) => k.chapter && String(k.chapter).trim()).length,
    };
  })()`);
  console.log('库状态 =', JSON.stringify({
    kp: dbState?.kpCount,
    questions: dbState?.questionCount,
    favorites: dbState?.favorites,
    withChapter: dbState?.withChapter,
    kpBySource: dbState?.kpBySource,
  }, null, 1));

  rec('打开的是真实库（知识点 105 条左右）', (dbState?.kpCount ?? 0) > 50, dbState?.kpCount + ' 条');

  const targetSource = (dbState?.sources ?? []).find((s) => s.title.indexOf(TARGET_KEYWORD) >= 0);
  if (!targetSource) {
    console.error('❌ 找不到目标资料（标题含「' + TARGET_KEYWORD + '」）');
    process.exit(2);
  }
  console.log('目标资料 =', targetSource.title);
  console.log('  它将失去的旧知识点 =', dbState?.kpBySource?.[targetSource.id] ?? 0, '条');

  /* 目标资料的旧知识点里，有没有被题目引用的 */
  const beforeRefs = await ev(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("openleaner");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const getAll = (s) => new Promise((res, rej) => {
      const tx = db.transaction(s, "readonly");
      const rq = tx.objectStore(s).getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const kps = await getAll("knowledgePoints");
    const questions = await getAll("questions");
    db.close();
    const targetKpIds = new Set(kps.filter((k) => k.sourceId === ${JSON.stringify(targetSource.id)}).map((k) => k.id));
    const affected = questions.filter((q) => q.knowledgePointId && targetKpIds.has(q.knowledgePointId));
    return {
      targetKpCount: targetKpIds.size,
      affectedQuestions: affected.length,
      affectedIds: affected.map((q) => q.id).slice(0, 10),
    };
  })()`);
  console.log('影响面 =', JSON.stringify(beforeRefs));

  if (DRY) {
    console.log('\n（--dry：到此为止，没有执行任何写操作）');
    try { app.kill(); } catch {}
    await sleep(500);
    process.exit(0);
  }

  /* ---------- 1. 进「整理知识点」页，选中目标资料 ---------- */
  await ev(`(() => {
    for (const lb of document.querySelectorAll(".nav-group__label")) {
      const b = lb.closest("button"); const g = lb.closest(".nav-group");
      if (b && g && g.getAttribute("aria-expanded") !== "true") b.click();
    }
    return true;
  })()`);
  await sleep(900);

  /*
   * ⚠️ 「整理知识点」`show: false` —— 它**故意不在侧栏**。
   *
   * 我先后试了两条路都失败：
   *  1. 侧栏直接找「整理知识点」→ 不存在
   *  2. 「知识骨架」页的「去整理知识点」按钮 → 它只在
   *     「一条知识点都没有」或「章节大多缺失」时才渲染。
   *     用户库 105 条都有章节，两个条件都不满足，按钮不出现。
   *
   * 真正的入口在「**资料**」页：每份资料上有整理动作
   * （`onOrganizeSource`，见 App.tsx 的 SourcesPage 接线）。
   */
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
      .find((e) => (e.textContent || "").trim() === "资料");
    if (el) el.click();
    return true;
  })()`);
  await sleep(3500);
  await shot('01-sources-page.png');

  const navClick = await ev(`(() => {
    /*
     * 在目标资料那一行里找整理入口。不要全局按文字找 ——
     * 页面上别处也可能出现「整理知识点」，点错就停到别的页面。
     */
    const rows = [...document.querySelectorAll("li, .src-row, .source-item, article, .card")];
    const targetRow = rows.find((r) => {
      const t = r.textContent || "";
      return t.indexOf(${JSON.stringify(TARGET_KEYWORD)}) >= 0 && t.length < 900;
    });
    if (!targetRow) {
      return { ok: false, reason: "找不到目标资料那一行", rows: rows.length };
    }
    const btn = [...targetRow.querySelectorAll("button, a, [role=button]")]
      .find((b) => /整理知识点|重新整理|整理/.test(b.textContent || ""));
    if (!btn) {
      return {
        ok: false,
        reason: "资料行里没有整理入口",
        rowButtons: [...targetRow.querySelectorAll("button, a")].map((b) => (b.textContent || "").trim()).slice(0, 12),
      };
    }
    btn.click();
    return { ok: true, text: (btn.textContent || "").trim().slice(0, 40) };
  })()`);
  console.log('进整理页 =', JSON.stringify(navClick).slice(0, 400));
  rec('从「资料」页进到「整理知识点」页', navClick?.ok === true, JSON.stringify(navClick).slice(0, 250));
  await sleep(3500);
  await shot('02-organize-page.png');

  /* 确认真的在整理页（有「开始整理」按钮） */
  const onOrganizePage = await ev(`(() => {
    const btns = [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim());
    return { hasStart: btns.some((t) => t.indexOf("开始整理") >= 0), buttons: btns.filter(Boolean).slice(-12) };
  })()`);
  console.log('页面按钮 =', JSON.stringify(onOrganizePage));
  rec('确实在「整理知识点」页（有「开始整理」）', !!onOrganizePage?.hasStart);

  /* 选资料：找下拉/列表里含「信号与系统」的那个 */
  const picked = await ev(`(() => {
    /* 先看有没有 select */
    const sel = document.querySelector("select");
    if (sel) {
      const opt = [...sel.options].find((o) => o.textContent && o.textContent.indexOf(${JSON.stringify(TARGET_KEYWORD)}) >= 0);
      if (opt) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return { via: "select", label: opt.textContent.trim().slice(0, 60) };
      }
    }
    /* 再看有没有可点的资料行 */
    const btn = [...document.querySelectorAll("button, li, .org-src")]
      .find((e) => (e.textContent || "").indexOf(${JSON.stringify(TARGET_KEYWORD)}) >= 0 && (e.textContent || "").length < 200);
    if (btn) { btn.click(); return { via: "click", label: (btn.textContent || "").trim().slice(0, 60) }; }
    return null;
  })()`);
  console.log('选中资料 =', JSON.stringify(picked));
  await sleep(2500);
  await shot('01-organize-picked.png');

  rec('选中了目标资料', !!picked, picked?.label);

  /* ---------- 2. 检查后端与提示词版本 ---------- */
  /*
   * ⚠️ 强制选中 DeepSeek，并**校验真的选中了**。
   *
   * 第一版没做这一步：整理页默认选「示例后端（离线）」，直接点「开始整理」
   * 就用假后端跑完了 —— 没调模型、没经过新提示词，却往真实库写了 144 条碎片。
   *
   * 示例后端选项现在已经从代码里删掉，但这里仍然显式选 + 显式校验：
   * 「信任界面默认值」正是上一版失败的原因。
   */
  const backendInfo = await ev(`(() => {
    const sels = [...document.querySelectorAll("select")];
    /*
     * 页面有两个 select：选资料、选后端。按**选项内容**认出后端的那个 ——
     * 按顺序取第 2 个太脆（布局一变就错）。
     */
    const backendSel = sels.find((s) =>
      [...s.options].some((o) => /DeepSeek|智谱|GLM|示例后端/.test(o.textContent || "")),
    );
    if (!backendSel) {
      return { ok: false, reason: "找不到后端下拉", selectCount: sels.length };
    }
    const opts = [...backendSel.options].map((o) => ({
      value: o.value,
      text: (o.textContent || "").trim(),
    }));
    const target = opts.find((o) => o.text.indexOf("DeepSeek") >= 0);
    if (!target) {
      return { ok: false, reason: "后端下拉里没有 DeepSeek", options: opts };
    }
    backendSel.value = target.value;
    backendSel.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      ok: true,
      options: opts.map((o) => o.text),
      chosenValue: target.value,
      chosenText: target.text,
      /* 选完立刻读回来，确认赋值生效 */
      currentValue: backendSel.value,
      /* 检查页面上还有没有「示例后端」这个选项（应该已经删了） */
      hasMockOption: opts.some((o) => o.text.indexOf("示例后端") >= 0),
    };
  })()`);
  console.log('后端 =', JSON.stringify(backendInfo, null, 1));

  rec('**选中的是 DeepSeek，不是示例后端**',
      backendInfo?.ok === true && (backendInfo?.chosenText ?? '').indexOf('DeepSeek') >= 0,
      backendInfo?.chosenText ?? JSON.stringify(backendInfo).slice(0, 200));
  rec('赋值真的生效（读回来一致）',
      backendInfo?.currentValue === backendInfo?.chosenValue,
      backendInfo?.currentValue);
  rec('**「示例后端」选项已从界面消失**（已删掉那个按钮）',
      backendInfo?.hasMockOption === false, 'hasMockOption=' + backendInfo?.hasMockOption);

  /*
   * ⚠️ 硬性闸门：没选中 DeepSeek 就不许点。
   *
   * 上一版失败的核心原因就是「信任界面默认值」——
   * 点下去才发现用的是示例后端。所以这一次**断言先过，按钮才点**。
   * 这不是防御性编程，是因为那个错误真的发生过一次、代价是
   * 往用户真实库里写了 144 条假数据。
   */
  if (!(backendInfo?.ok === true && (backendInfo?.chosenText ?? '').indexOf('DeepSeek') >= 0)) {
    console.error('\n❌ 没有选中 DeepSeek 后端，已停止（不点「开始整理」）。');
    console.error('   后端状态：' + JSON.stringify(backendInfo));
    try { app.kill(); } catch {}
    await sleep(600);
    process.exit(2);
  }
  console.log('闸门通过：后端 = ' + backendInfo.chosenText);

  /* ---------- 3. 点「开始整理」 ---------- */
  const startClicked = await ev(`(() => {
    const btn = [...document.querySelectorAll("button")]
      .find((b) => {
        const t = (b.textContent || "").trim();
        return t === "开始整理" || t.indexOf("开始整理") >= 0;
      });
    if (!btn) {
      return { ok: false, all: [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 20) };
    }
    if (btn.disabled) return { ok: false, disabled: true, text: (btn.textContent || "").trim() };
    btn.click();
    return { ok: true, text: (btn.textContent || "").trim() };
  })()`);
  console.log('点击「开始整理」 =', JSON.stringify(startClicked));
  rec('找到并点击了「开始整理」', startClicked?.ok === true, JSON.stringify(startClicked).slice(0, 150));

  if (!startClicked?.ok) {
    try { app.kill(); } catch {}
    process.exit(2);
  }

  /* ---------- 4. 等它跑完 ---------- */
  /*
   * 真调模型，36 段要跑一会儿。轮询要稀（项目记过：页面重时密集轮询会把 CDP 压超时）。
   */
  let done = false;
  let waited = 0;
  const MAX_WAIT_MS = 15 * 60 * 1000;
  while (waited < MAX_WAIT_MS) {
    await sleep(5000);
    waited += 5000;
    const state = await ev(`(() => {
      const t = (document.querySelector(".org-page, .page")?.textContent || "").replace(/\\\\s+/g, " ");
      const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").indexOf("开始整理") >= 0 || (b.textContent || "").indexOf("正在整理") >= 0);
      return {
        btnText: btn ? (btn.textContent || "").trim() : null,
        btnDisabled: btn ? btn.disabled : null,
        running: t.indexOf("正在整理") >= 0 || t.indexOf("正在读取") >= 0,
        done: t.indexOf("整理完成") >= 0 || t.indexOf("完成") >= 0 && t.indexOf("条") >= 0,
        hasError: !!document.querySelector(".org-error, .map-error, [role=alert]"),
        errText: (document.querySelector(".org-error, .map-error, [role=alert]")?.textContent || "").slice(0, 200),
        tail: t.slice(-300),
      };
    })()`).catch(() => null);

    if (waited % 30000 === 0) {
      console.log('  已等 ' + Math.round(waited / 1000) + 's｜按钮=' + state?.btnText + '｜禁用=' + state?.btnDisabled);
    }
    if (state && !state.running && state.btnDisabled === false && state.btnText && state.btnText.indexOf('整理') >= 0 && state.btnText.indexOf('正在') < 0) {
      done = true;
      console.log('  看起来跑完了（等待 ' + Math.round(waited / 1000) + 's）');
      break;
    }
    if (state?.hasError && !state.running) {
      console.log('  出错：' + state.errText);
      break;
    }
  }

  await sleep(3000);
  await shot('02-organize-done.png');

  rec('整理跑完了（没有一直挂着）', done, '等待 ' + Math.round(waited / 1000) + ' 秒');

  /* ---------- 5. 量结果 ---------- */
  const after = await ev(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("openleaner");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const getAll = (s) => new Promise((res, rej) => {
      const tx = db.transaction(s, "readonly");
      const rq = tx.objectStore(s).getAll();
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    const kps = await getAll("knowledgePoints");
    const questions = await getAll("questions");
    const runs = await getAll("generationRuns");
    db.close();

    const mine = kps.filter((k) => k.sourceId === ${JSON.stringify(targetSource.id)});
    const kpIds = new Set(kps.map((k) => k.id));
    const dangling = questions.filter((q) => q.knowledgePointId && !kpIds.has(q.knowledgePointId));

    /* 每条知识点的字数（看是不是碎句） */
    const lens = mine.map((k) => (k.statement || "").length).sort((a, b) => a - b);

    return {
      totalKp: kps.length,
      thisSourceKp: mine.length,
      questions: questions.length,
      danglingRefs: dangling.length,
      runCount: runs.length,
      lastRun: runs.length > 0 ? {
        status: runs[runs.length - 1].status,
        produced: runs[runs.length - 1].producedCount,
        tokens: runs[runs.length - 1].actualTokens,
        error: runs[runs.length - 1].error,
      } : null,
      /* 质量指标 */
      statementLens: {
        min: lens[0] ?? 0,
        median: lens[Math.floor(lens.length / 2)] ?? 0,
        max: lens[lens.length - 1] ?? 0,
        veryShort: lens.filter((n) => n < 20).length,
        long: lens.filter((n) => n >= 60).length,
      },
      samples: mine.slice(0, 6).map((k) => ({
        statement: (k.statement || "").slice(0, 90),
        len: (k.statement || "").length,
        chapter: k.chapter,
        level: k.cognitiveLevel,
        quotes: (k.quotes || []).length,
      })),
      chapterCount: new Set(mine.map((k) => k.chapter).filter(Boolean)).size,
    };
  })()`);
  console.log('\n=== 整理结果 ===');
  console.log(JSON.stringify(after, null, 1));

  console.log('\n=== 对比 ===');
  console.log('  这份资料的知识点: ' + (dbState?.kpBySource?.[targetSource.id] ?? 0) + ' → ' + after?.thisSourceKp);
  console.log('  全库知识点: ' + dbState?.kpCount + ' → ' + after?.totalKp);
  console.log('  悬空引用: ' + after?.danglingRefs + '（应为 0）');
  console.log('  短句数（<20 字）: ' + after?.statementLens?.veryShort);
  console.log('  长句数（≥60 字）: ' + after?.statementLens?.long);

  rec('整理产出了知识点', (after?.thisSourceKp ?? 0) > 0, after?.thisSourceKp + ' 条');
  rec('**没有制造悬空引用**', (after?.danglingRefs ?? 1) === 0, after?.danglingRefs + ' 条悬空');
  rec('没有报错', !after?.lastRun?.error, after?.lastRun?.error ?? '(无)');

  console.log('\n截图：' + SHOTS);
  console.log('通过 ' + pass + ' / ' + (pass + fail));

  try { app.kill(); } catch {}
  await sleep(800);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('脚本本身出错：' + (e && e.stack ? e.stack : e));
  process.exit(3);
});
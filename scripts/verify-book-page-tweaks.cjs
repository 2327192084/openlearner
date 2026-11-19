/**
 * 验证复习巩固页 / 答疑记录的四项改动（2026-11-19 晚）。
 *
 * 用户提的四条：
 *  ① 复习巩固页的资料加个收起按钮
 *  ② 每一题都要有一个定位回原文的功能（单挂一个「出处」不够）
 *  ③ 提问式复习按钮按后给两个二级选项：
 *     a) 从知识库随机 / 选定知识点提问
 *     b) 告诉用户可以回资料库划选原文提问
 *  ④ 答疑记录继续分类：提问式复习的记录 / 错题答疑的记录
 *
 * ## 为什么要走真实 UI 并截图
 *
 * 这四项**全是界面改动**。项目的硬约束是「改界面必须 CDP 截图肉眼复核，
 * 断言全过不代表界面对」—— 上一轮就出现过「断言全绿、深色字压深色底」
 * 和「按钮看起来像禁用」两次。
 *
 * 所以这个脚本除了断言，还：
 *  - 每项都截图
 *  - 读 computedStyle 核对颜色（不是看类名猜）
 *  - 检查元素是否真的可见（getBoundingClientRect 非零）
 *
 * ## 数据
 *
 * 种一份「已发布题组 + 2 题带 anchors + 知识点 + 1 条 oralReview
 * + 1 条 explainNote」。这样 ④ 的两种分类**都能显示**，
 * 才能验「页签常驻、两类各一个入口」而不是只看到空。
 *
 * 用法：node scripts/verify-book-page-tweaks.cjs [CDP端口]
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
const APPDATA = path.resolve(ROOT, '.tmp/booktweaks-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/book-tweaks');
/* 9831/9837/9847 被系统保留，用 9830 */
const PORT = Number(process.argv[2] || 9830);
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x) => {
  console.log((ok ? '✅ ' : '❌ ') + n + (x ? ' :: ' + x : ''));
  ok ? pass++ : fail++;
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });

  if (!fs.existsSync(EXE)) {
    console.error('缺隔离 electron 运行时：' + EXE);
    process.exit(2);
  }
  const trap = path.join(path.dirname(EXE), 'openleaner-data');
  if (fs.existsSync(trap)) {
    console.error('❌ ' + trap + ' 存在 —— --user-data-dir 会被它抢先，先删掉');
    process.exit(2);
  }

  fs.rmSync(APPDATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  const app = spawn(
    EXE,
    [
      ROOT,
      '--user-data-dir=' + DATA,
      '--no-sandbox',
      '--remote-debugging-port=' + PORT,
      '--window-size=1440,1100',
    ],
    { cwd: ROOT, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  app.stdout.on('data', (d) => (log += d.toString()));
  app.stderr.on('data', (d) => (log += d.toString()));

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 240; i++) {
      try {
        const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        target = l.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
        if (target) break;
      } catch {}
      await SLEEP(250);
    }
    if (!target) {
      console.error('起不来:' + log.slice(-1500));
      process.exit(2);
    }

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    let id = 1;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
    const send = (method, params) =>
      new Promise((resolve, reject) => {
        const n = id++;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params: params || {} }));
        setTimeout(() => {
          if (pending.has(n)) {
            pending.delete(n);
            reject(new Error('timeout ' + method));
          }
        }, 120000);
      });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails)
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const shot = async (n) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS, n), Buffer.from(r.data, 'base64'));
    };
    const waitFor = async (expr, ms = 25000, label = '') => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const v = await evalJs(expr).catch(() => null);
        if (v) return v;
        await SLEEP(300);
      }
      throw new Error('等待超时' + (label ? '（' + label + '）' : ''));
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await SLEEP(6000);

    /* ---------- 种子 ---------- */
    const seed = await evalJs(`(async () => {
      const db = await new Promise((res, rej) => {
        const q = indexedDB.open("openleaner");
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      const ts = new Date().toISOString();
      const put = (st, rows) => new Promise((res, rej) => {
        const tx = db.transaction(st, "readwrite");
        const s = tx.objectStore(st);
        rows.forEach((r) => s.put(r));
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      const clear = (st) => new Promise((res) => {
        const tx = db.transaction(st, "readwrite");
        tx.objectStore(st).clear();
        tx.oncomplete = res;
        tx.onerror = res;
      });
      for (const st of ["questions","decks","reviewRecords","reviewLogs","knowledgePoints",
                        "sources","sourceSegments","backends","secrets","answerRecords",
                        "oralReviews","usageRecords","flashcards"]) {
        await clear(st);
      }

      const S1 = "src_a", S2 = "src_b";
      await put("sources", [
        { id: S1, title: "高等数学 第7版 上", kind: "text", pageCount: 20, textStatus: "ready",
          createdAt: ts, updatedAt: ts, segmentCount: 3, readProgress: null },
        { id: S2, title: "信号与系统 第1章", kind: "text", pageCount: 12, textStatus: "ready",
          createdAt: ts, updatedAt: ts, segmentCount: 3, readProgress: null },
      ]);
      await put("sourceSegments", [
        { id: "seg_a1", sourceId: S1, index: 1, page: 16, chapter: "第一章 映射与函数",
          text: "设 f: X → Y 是一个映射，对 X 中每个元素 x，按法则 f 在 Y 中有唯一确定的元素 y 与之对应。因此像唯一，但原像不一定唯一，值域是 Y 的子集。",
          charCount: 78 },
        { id: "seg_b1", sourceId: S2, index: 1, page: 9, chapter: "1.2 离散时间信号",
          text: "连续时间信号用圆括号把自变量括起来并以 t 表示连续时间变量；离散时间信号用方括号表示，且仅在自变量的整数值上有定义。",
          charCount: 62 },
      ]);

      await put("knowledgePoints", [
        { id: "kp_a", statement: "映射的像唯一但原像不一定唯一",
          chapter: "第一章 映射与函数", cognitiveLevel: "understand", tags: [],
          anchors: [{ sourceId: S1, page: 16 }],
          quotes: ["设 f: X → Y 是一个映射，像唯一，但原像不一定唯一。"],
          anchorStatus: "located", origin: "material", sourceId: S1,
          backendId: null, createdAt: ts, updatedAt: ts },
        { id: "kp_b", statement: "离散时间信号只在整数点有定义",
          chapter: "1.2 离散时间信号", cognitiveLevel: "understand", tags: [],
          anchors: [{ sourceId: S2, page: 9 }],
          quotes: ["离散时间信号仅在自变量的整数值上有定义。"],
          anchorStatus: "located", origin: "material", sourceId: S2,
          backendId: null, createdAt: ts, updatedAt: ts },
      ]);

      await put("decks", [
        { id: "deck_a", title: "高等数学 第7版 上 · 题组", courseId: null, status: "published",
          sourceId: S1, backendId: null, kinds: ["single"], questionCount: 2,
          blockingIssues: 0, publishedAt: ts, createdAt: ts, updatedAt: ts },
        { id: "deck_b", title: "信号与系统 第1章 · 题组", courseId: null, status: "published",
          sourceId: S2, backendId: null, kinds: ["single"], questionCount: 1,
          blockingIssues: 0, publishedAt: ts, createdAt: ts, updatedAt: ts },
      ]);
      await put("questions", [
        { id: "q_a1", deckId: "deck_a", kind: "single",
          prompt: "设 f: X → Y 是一个映射，下列说法正确的是：",
          options: [
            { key: "A", text: "对每个 x ∈ X，其像 y = f(x) 是唯一的；但对每个 y ∈ R_f，其原像不一定唯一。" },
            { key: "B", text: "对每个 y ∈ Y，其原像一定存在且唯一。" },
          ],
          answer: "A", explanation: "映射定义：像唯一，但原像不一定唯一，值域是 Y 的子集。",
          anchors: [{ sourceId: S1, page: 16 }],
          knowledgePointId: "kp_a", cognitiveLevel: "understand", topic: "映射", order: 1 },
        { id: "q_a2", deckId: "deck_a", kind: "single",
          prompt: "映射的值域与陪域的关系是？",
          options: [{ key: "A", text: "值域是陪域的子集" }, { key: "B", text: "两者恒等" }],
          answer: "A", explanation: "值域 R_f ⊆ Y。",
          anchors: [{ sourceId: S1, page: 16 }],
          knowledgePointId: "kp_a", cognitiveLevel: "remember", topic: "映射", order: 2 },
        { id: "q_b1", deckId: "deck_b", kind: "single",
          prompt: "复信号分解为偶分量与奇分量时，对应的是哪两种分解？",
          options: [{ key: "A", text: "实部与虚部" }, { key: "B", text: "共轭对称与共轭反对称" }],
          answer: "B", explanation: "偶分量对应共轭对称部分，奇分量对应共轭反对称部分。",
          anchors: [{ sourceId: S2, page: 9 }],
          knowledgePointId: "kp_b", cognitiveLevel: "understand", topic: "信号分解", order: 1 },
      ]);

      /* ④ 的两类记录各一条 */
      await put("oralReviews", [{
        id: "oral_t1", scopeLabel: "第一章 映射与函数",
        sourceId: S1, page: 16, quote: "映射的像唯一",
        question: "映射的像和原像有什么区别？",
        answer: "像是唯一的，原像可能有多个。",
        verdict: "understanding",
        quotedFromSource: "", quoteVerified: false,
        explanation: "概念上有实质错误，先把定义理清楚。",
        correction: "像唯一，原像不一定唯一。",
        savedAs: "brief", fullText: null, createdAt: ts,
      }]);
      /* explainNotes 挂在题目上 */
      const tx = db.transaction("questions", "readwrite");
      const stq = tx.objectStore("questions");
      const q1 = await new Promise((res, rej) => {
        const rq = stq.get("q_a1");
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
      q1.explainNotes = [{
        id: "en_t1", style: "direct", given: "B",
        crux: "你把「原像唯一」当成了映射的定义。",
        body: "映射只要求像唯一，原像可以多个。",
        nextStep: "举一个「多对一」的例子。",
        createdAt: ts,
      }];
      stq.put(q1);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });

      db.close();
      return { ok: true };
    })()`);
    rec('种子写入（2 份资料 / 3 题带 anchors / 知识点 / 两类答疑记录）', !!(seed && seed.ok));

    await evalJs('location.reload()');
    await SLEEP(7000);

    /* 进复习巩固页 */
    await evalJs(`(() => {
      for (const lb of document.querySelectorAll(".nav-group__label")) {
        const b = lb.closest("button"); const g = lb.closest(".nav-group");
        if (b && g && g.getAttribute("aria-expanded") !== "true") b.click();
      }
      return true;
    })()`);
    await SLEEP(600);
    await evalJs(`(() => {
      const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
        .find((e) => e.textContent.trim().includes("复习巩固"));
      if (el) { el.click(); return true; }
      return false;
    })()`);
    await waitFor(`document.querySelector(".bk-toolbar") ? true : null`, 20000, '复习巩固页');
    await SLEEP(800);
    await shot('01-book-full.png');

    /* ---------- ① 资料收起按钮 ---------- */
    const foldInfo = await evalJs(`(() => {
      const btns = [...document.querySelectorAll(".bk-volume__fold")];
      if (!btns.length) return null;
      const b = btns[0];
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      return {
        count: btns.length,
        text: b.textContent.trim(),
        expanded: b.getAttribute("aria-expanded"),
        visible: r.width > 0 && r.height > 0,
        color: cs.color,
        fontSize: cs.fontSize,
      };
    })()`);
    rec('**① 每卷有收起按钮**', !!foldInfo && foldInfo.count >= 2, '数量=' + (foldInfo?.count ?? 0));
    rec('收起按钮可见（尺寸非零）', !!foldInfo && foldInfo.visible, JSON.stringify(foldInfo?.visible));
    rec('默认是展开态（aria-expanded=true）', foldInfo?.expanded === 'true', foldInfo?.expanded ?? '');
    rec(
      '按钮文字说明当前动作（展开态显示「收起」）',
      !!foldInfo && foldInfo.text.includes('收起'),
      foldInfo?.text ?? '',
    );

    /* 收起第二卷，验证内容真的消失 */
    const beforeCollapse = await evalJs(`document.querySelectorAll(".bk-q").length`);
    const collapsed = await evalJs(`(() => {
      const btns = [...document.querySelectorAll(".bk-volume__fold")];
      if (btns.length < 2) return false;
      btns[1].click();
      return true;
    })()`);
    await SLEEP(900);
    const afterCollapse = await evalJs(`document.querySelectorAll(".bk-q").length`);
    rec(
      '**点收起后题真的隐藏**',
      !!collapsed && afterCollapse < beforeCollapse,
      beforeCollapse + ' → ' + afterCollapse,
    );
    const collapsedState = await evalJs(`(() => {
      const b = document.querySelectorAll(".bk-volume__fold")[1];
      return b ? { expanded: b.getAttribute("aria-expanded"), text: b.textContent.trim() } : null;
    })()`);
    rec(
      '收起后 aria-expanded=false 且文字变「展开」',
      collapsedState?.expanded === 'false' && collapsedState.text.includes('展开'),
      JSON.stringify(collapsedState),
    );
    /*
     * 截图前先滚到那卷上去（2026-11-19 晚）。
     * 被收起的是第 2 卷，在首屏之下 —— 不滚的话截图与收起前**长得一样**，
     * 等于没拍到证据。判定证据要肉眼能看见，不能只靠断言。
     */
    await evalJs(`(() => {
      const b = document.querySelectorAll(".bk-volume__fold")[1];
      if (b) b.scrollIntoView({ block: "center" });
      return true;
    })()`);
    await SLEEP(700);
    await shot('02-volume-collapsed.png');

    /* 展开回来 */
    await evalJs(`(() => {
      const b = document.querySelectorAll(".bk-volume__fold")[1];
      if (b) b.click();
      return true;
    })()`);
    await SLEEP(800);
    const restored = await evalJs(`document.querySelectorAll(".bk-q").length`);
    rec('**再点展开，题回来了**', restored === beforeCollapse, beforeCollapse + ' → ' + restored);

    /* ---------- ② 每题定位回原文 ---------- */
    const locate = await evalJs(`(() => {
      const btns = [...document.querySelectorAll(".bk-q__locate")];
      if (!btns.length) return null;
      const b = btns[0];
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      return {
        count: btns.length,
        text: b.textContent.trim(),
        visible: r.width > 0 && r.height > 0,
        color: cs.color,
        cursor: cs.cursor,
      };
    })()`);
    const qCount = await evalJs(`document.querySelectorAll(".bk-q").length`);
    rec(
      '**② 每道题都有「定位回原文」按钮**（题数与按钮数一致）',
      !!locate && locate.count === qCount,
      '题=' + qCount + ' 按钮=' + (locate?.count ?? 0),
    );
    rec('按钮可见', !!locate && locate.visible);
    rec('文案带页码，说明会跳去哪', !!locate && /第 \d+ 页/.test(locate.text), locate?.text ?? '');
    rec('颜色不是继承色（真的配过色）', !!locate && locate.color !== 'rgba(0, 0, 0, 0)', locate?.color ?? '');
    rec('cursor 是 pointer（看起来可点）', locate?.cursor === 'pointer', locate?.cursor ?? '');

    /*
     * ⚠️ 颜色必须**等于强调色**，不能只判「不是继承色」。
     *
     * 第一版这条写的是 `color !== 'rgba(0,0,0,0)'` —— 亮灰也过，
     * 于是层内 color 被层外 `button{color:inherit}` 压掉时它照样绿。
     * 是截图看出来「怎么是灰的」。
     *
     * 现在把 `--accent` 的实测值取出来比对：不相等就是没生效。
     * 这条是「断言写得够宽等于没在验」的直接教训。
     *
     * 取值位置要点：token 定义在 `.app` 上（v2 tokens），不是 `:root`。
     * 从 documentElement 读会拿到 `:root` 那套（另一套色），比对必然不等。
     */
    const accentMatches = await evalJs(`(() => {
      const btn = document.querySelector(".bk-q__locate");
      if (!btn) return null;
      const app = document.querySelector(".app") || document.documentElement;
      const probe = document.createElement("div");
      /* 让探针继承与按钮同一个作用域下的 --accent */
      probe.style.color = getComputedStyle(app).getPropertyValue("--accent").trim();
      app.appendChild(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      const btnColor = getComputedStyle(btn).color;
      return { btn: btnColor, accent, same: btnColor === accent };
    })()`);
    rec(
      '**定位按钮颜色 = 强调色（不是被层外规则压成的灰色）**',
      !!accentMatches && accentMatches.same,
      JSON.stringify(accentMatches),
    );

    /*
     * 真的点一下，验证跳到阅读器并且页码对。
     * 「有按钮」和「按钮有用」是两件事 —— 硬约束那条。
     */
    const navigated = await evalJs(`(() => {
      const b = document.querySelector(".bk-q__locate");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await SLEEP(2500);
    const inReader = await evalJs(`(() => {
      const t = document.body.innerText || "";
      return {
        hasReader: !!document.querySelector(".reader-page, .reader-split, .rside"),
        pageText: (document.querySelector(".reader-bar, .reader-page__bar, .rs-page")?.textContent ?? "").trim().slice(0, 60),
        bodyHasPage16: t.includes("16"),
      };
    })()`);
    rec(
      '**点「定位回原文」真的进了阅读器**',
      !!navigated && !!inReader && inReader.hasReader,
      JSON.stringify(inReader),
    );
    await shot('03-locate-to-reader.png');

    /* 回复习巩固 */
    await evalJs(`(() => {
      const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
        .find((e) => e.textContent.trim().includes("复习巩固"));
      if (el) { el.click(); return true; }
      return false;
    })()`);
    await waitFor(`document.querySelector(".bk-toolbar") ? true : null`, 20000, '回到复习巩固');

    /* ---------- ③ 提问式复习两级入口 ---------- */
    const oralBtn = await evalJs(`(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => x.textContent.trim() === "提问式复习");
      if (b) { b.click(); return true; }
      return false;
    })()`);
    rec('工具条上的「提问式复习」按钮可点', !!oralBtn);
    await SLEEP(900);

    const chooser = await evalJs(`(() => {
      const box = document.querySelector(".oral-entry");
      if (!box) return null;
      const cols = [...box.querySelectorAll(".oral-entry__col")];
      const btns = [...box.querySelectorAll(".oral-entry__btn")];
      return {
        visible: box.getBoundingClientRect().width > 0,
        colCount: cols.length,
        colLeads: cols.map((c) => (c.querySelector(".oral-entry__lead")?.textContent ?? "").trim()),
        btnTexts: btns.map((b) => b.textContent.trim()),
        hasSteps: !!box.querySelector(".oral-entry__steps"),
        hasPickKnown: btns.some((b) => b.textContent.includes("挑知识点")),
        hasRandom: btns.some((b) => b.textContent.includes("随机")),
        mentionsSelection: (box.textContent || "").includes("拖选"),
      };
    })()`);
    rec('**③ 点「提问式复习」后出现两级入口**', !!chooser && chooser.visible, JSON.stringify(chooser?.colCount));
    rec('**两栏并排：知识库提问 / 原文划选提问**', chooser?.colCount === 2, JSON.stringify(chooser?.colLeads));
    rec(
      '**有「挑知识点提问」（能选定知识点）**',
      !!chooser && chooser.hasPickKnown,
      JSON.stringify(chooser?.btnTexts),
    );
    rec('有「随机一条」', !!chooser && chooser.hasRandom);
    rec(
      '**第二栏告诉用户回资料库划选原文**（含拖选/划选说明）',
      !!chooser && chooser.mentionsSelection,
    );
    rec('划选那条给了分步指引', !!chooser && chooser.hasSteps);
    await shot('04-oral-chooser.png');

    /* 点「挑知识点提问」应当跳到知识库的挑选模式 */
    const toKnowledge = await evalJs(`(() => {
      const b = [...document.querySelectorAll(".oral-entry__btn")]
        .find((x) => x.textContent.includes("挑知识点"));
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    })()`);
    await SLEEP(2500);
    const picking = await evalJs(`(() => {
      const bar = document.querySelector(".kb-pickbar");
      return {
        hasBar: !!bar,
        barText: (bar?.textContent ?? "").trim().slice(0, 60),
        title: (document.querySelector(".kb-title")?.textContent ?? "").trim(),
        leadText: (document.querySelector(".kb-lead")?.textContent ?? "").trim().slice(0, 80),
        checkboxCount: document.querySelectorAll(".kb-point__pick input").length,
        disabledCount: document.querySelectorAll(".kb-point__pick input:disabled").length,
      };
    })()`);
    rec('**点「挑知识点提问」进了知识库挑选模式**', !!toKnowledge && picking.hasBar, picking.title);
    rec('挑选模式标题是「挑要提问的知识点」', picking.title.includes('挑要提问'), picking.title);
    rec(
      '**确认按钮文案不是「加入闪卡」**（复用挑选模式时最容易漏的一条）',
      picking.barText.includes('提问') && !picking.barText.includes('闪卡'),
      picking.barText,
    );
    rec(
      '知识点可勾选（不被「已在闪卡里」误置灰）',
      picking.checkboxCount > 0 && picking.disabledCount === 0,
      '可勾=' + picking.checkboxCount + ' 禁用=' + picking.disabledCount,
    );
    /*
     * 顶部说明也要跟着用途变（2026-11-19 晚）。
     *
     * 复用挑选模式时最容易漏的就是这种**文案**：标题改了、按钮改了，
     * 说明还写着「勾选要加进闪卡的知识点」。用户看到会以为自己点错地方。
     * 第一版截图就是这样抓到的（断言当时没覆盖到）。
     */
    rec(
      '**顶部说明不是「加进闪卡」那套话**（复用时最容易漏的文案）',
      !!picking.leadText && picking.leadText.includes('提问') && !picking.leadText.includes('闪卡'),
      picking.leadText,
    );
    await shot('05-pick-points-for-oral.png');

    /* 勾一条并确认，应当进场就进提问面板 */
    await evalJs(`(() => {
      const c = document.querySelector(".kb-point__pick input");
      if (c && !c.disabled) { c.click(); return true; }
      return false;
    })()`);
    await SLEEP(400);
    const confirmBtn = await evalJs(`(() => {
      const b = document.querySelector(".kb-pickbar__ok");
      if (!b || b.disabled) return null;
      const t = b.textContent.trim();
      b.click();
      return t;
    })()`);
    rec('勾选后确认按钮可用且文案带条数', !!confirmBtn && /（1）|\(1\)/.test(confirmBtn), confirmBtn ?? '');
    await SLEEP(3000);
    const enteredOral = await evalJs(`(() => ({
      inOral: !!document.querySelector(".orp__card, .orp__bar"),
      scope: (document.querySelector(".orp__scope")?.textContent ?? "").trim(),
      hasScopePicker: !!document.querySelector(".orp__picker select"),
      scopePickerText: (document.querySelector(".orp__picker select")?.textContent ?? "").trim().slice(0, 40),
    }))()`);
    rec(
      '**挑完知识点直接进入提问面板**（不用再点一次）',
      !!enteredOral && enteredOral.inOral,
      JSON.stringify(enteredOral),
    );
    rec(
      '面板顶部说明用的是选定的知识点，不是「知识点随机」',
      enteredOral.scope.includes('选定') || enteredOral.scope.includes('知识点'),
      enteredOral.scope,
    );
    /*
     * 素材是显式选定的，就不该再有「换范围」下拉（2026-11-19 晚）。
     *
     * 截图抓到过矛盾：顶部写「选定的 1 条知识点」，下拉却显示
     * 「知识点随机（2）」—— 两套信息打架，而且点一下会把挑的覆盖掉。
     * 与划选提问同一条规则：素材指定了就不给换范围的入口。
     */
    rec(
      '**没有「换范围」下拉**（否则与顶部说明矛盾、且会覆盖已选素材）',
      !!enteredOral && !enteredOral.hasScopePicker,
      enteredOral?.scopePickerText ?? '',
    );
    await shot('06-oral-from-picked-points.png');

    /* ---------- ④ 答疑记录分类 ---------- */
    await evalJs(`(() => {
      const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
        .find((e) => e.textContent.trim().includes("答疑记录"));
      if (el) { el.click(); return true; }
      return false;
    })()`);
    await waitFor(`document.querySelector(".ansrec-page") ? true : null`, 20000, '答疑记录页');
    await SLEEP(800);

    const tabs = await evalJs(`(() => {
      const ts = [...document.querySelectorAll(".ansrec-tab")];
      return {
        count: ts.length,
        labels: ts.map((t) => t.textContent.trim()),
        widths: ts.map((t) => Math.round(t.getBoundingClientRect().width)),
        colors: ts.map((t) => getComputedStyle(t).color),
      };
    })()`);
    rec('**④ 答疑记录有分类页签**', tabs.count === 3, '页签数=' + tabs.count);
    rec(
      '**两个来源各一个入口：提问复习 / 错题讲解**',
      tabs.labels.some((l) => l.includes('提问复习')) &&
        tabs.labels.some((l) => l.includes('错题讲解')),
      JSON.stringify(tabs.labels),
    );
    rec('页签可见（宽度非零）', tabs.widths.every((w) => w > 0), JSON.stringify(tabs.widths));
    await shot('07-answer-record-tabs.png');

    /* 点「提问复习」→ 只剩 oral 那条 */
    const oralOnly = await evalJs(`(() => {
      const t = [...document.querySelectorAll(".ansrec-tab")].find((x) => x.textContent.includes("提问复习"));
      if (t) { t.click(); return true; }
      return false;
    })()`);
    await SLEEP(700);
    const oralList = await evalJs(`(() => {
      const items = [...document.querySelectorAll(".ansrec-item")];
      return {
        count: items.length,
        kinds: items.map((i) => i.className),
        texts: items.map((i) => (i.textContent || "").slice(0, 40)),
      };
    })()`);
    rec(
      '**点「提问复习」只剩提问那一类**',
      !!oralOnly && oralList.count === 1 && oralList.kinds[0].includes('ansrec-item--oral'),
      '条数=' + oralList.count,
    );

    /* 点「错题讲解」→ 只剩讲解 */
    const explainOnly = await evalJs(`(() => {
      const t = [...document.querySelectorAll(".ansrec-tab")].find((x) => x.textContent.includes("错题讲解"));
      if (t) { t.click(); return true; }
      return false;
    })()`);
    await SLEEP(700);
    const explainList = await evalJs(`(() => {
      const items = [...document.querySelectorAll(".ansrec-item")];
      return {
        count: items.length,
        kinds: items.map((i) => i.className),
      };
    })()`);
    rec(
      '**点「错题讲解」只剩讲解那一类**',
      !!explainOnly && explainList.count === 1 && explainList.kinds[0].includes('wrong-explain'),
      '条数=' + explainList.count,
    );
    await shot('08-answer-record-filtered.png');

    console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
    console.log('  截图目录：' + SHOTS);
    if (fail > 0) process.exitCode = 1;
  } catch (e) {
    console.error('脚本异常：', e && e.message);
    console.error(log.slice(-2500));
    process.exitCode = 2;
  } finally {
    try {
      ws && ws.close();
    } catch {}
    app.kill();
    await SLEEP(1200);
  }
})();

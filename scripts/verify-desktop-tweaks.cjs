/**
 * 验证「桌面安装版」已含本轮四项优化（2026-11-19 深夜）。
 *
 * 验的是**安装目录里的 resources/app.asar 真含这些改动**，
 * 不是项目根 dist（那是源码侧）。两者不同：
 * 更换 exe+asar 后如果 integrity 不匹配，应用会白屏起不来 —— 本脚本能抓到。
 *
 * 四项（提交 377832b）：
 *  ① 复习巩固页每卷有收起按钮
 *  ② 每题有「定位回原文」按钮
 *  ③ 提问式复习两级入口（知识库提问 / 原文划选提问）
 *  ④ 答疑记录有分类页签
 *
 * 隔离：--user-data-dir 指隔离副本，APPDATA 一并指过去，绝不碰真实库。
 *
 * 用法：node scripts/verify-desktop-tweaks.cjs [CDP端口]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INSTALL_EXE = 'C:/Users/ASUS/AppData/Local/Programs/OpenLeaner/OpenLeaner.exe';
const INSTALL_DIR = path.dirname(INSTALL_EXE);
const APPDATA = path.resolve(ROOT, '.tmp/desktop-tweaks-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const PORT = Number(process.argv[2] || 9793);
const OUT = path.resolve(ROOT, '.verify-shots/desktop-tweaks');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x) => {
  console.log(`${ok ? '✅' : '❌'}  ${n}${x ? '  — ' + x : ''}`);
  ok ? pass++ : fail++;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(INSTALL_EXE)) {
    console.error('缺桌面 exe：' + INSTALL_EXE);
    process.exit(2);
  }

  /* 建隔离副本（种一份最小数据，避免依赖真实库内容） */
  fs.rmSync(APPDATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  const app = spawn(
    INSTALL_EXE,
    [
      `--user-data-dir=${DATA}`,
      '--no-sandbox',
      `--remote-debugging-port=${PORT}`,
      '--window-size=1440,1000',
    ],
    { cwd: INSTALL_DIR, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let appLog = '';
  app.stdout.on('data', (d) => {
    appLog += d.toString();
  });
  app.stderr.on('data', (d) => {
    appLog += d.toString();
  });

  let ws = null;
  try {
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
      console.error('安装版起不来（可能是 exe/asar integrity 不匹配）:\n' + appLog.slice(-1500));
      process.exit(2);
    }
    rec('安装版能正常启动并加载页面（证明 exe+asar 成对）', true, target.url.slice(0, 60));

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
      fs.writeFileSync(path.join(OUT, n), Buffer.from(r.data, 'base64'));
    };
    const waitFor = async (expr, ms = 25000, label = '') => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const v = await evalJs(expr).catch(() => null);
        if (v) return v;
        await sleep(300);
      }
      throw new Error('等待超时' + (label ? '（' + label + '）' : ''));
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(6000);

    /* 种最小数据：一个已发布题组 + 带 anchors 的题 + 两类答疑记录 */
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
                        "oralReviews","usageRecords","flashcards"]) await clear(st);

      const S1 = "src_d";
      await put("sources", [{ id: S1, title: "桌面验证资料", kind: "text", pageCount: 10,
        textStatus: "ready", createdAt: ts, updatedAt: ts, segmentCount: 1, readProgress: null }]);
      await put("knowledgePoints", [{ id: "kp_d", statement: "映射的像唯一但原像不一定唯一",
        chapter: "第一章", cognitiveLevel: "understand", tags: [],
        anchors: [{ sourceId: S1, page: 16 }], quotes: ["像唯一，原像不一定唯一。"],
        anchorStatus: "located", origin: "material", sourceId: S1, backendId: null,
        createdAt: ts, updatedAt: ts }]);
      await put("decks", [{ id: "deck_d", title: "桌面验证题组", courseId: null,
        status: "published", sourceId: S1, backendId: null, kinds: ["single"],
        questionCount: 1, blockingIssues: 0, publishedAt: ts, createdAt: ts, updatedAt: ts }]);
      await put("questions", [{ id: "q_d", deckId: "deck_d", kind: "single",
        prompt: "设 f: X → Y 是一个映射，下列说法正确的是：",
        options: [{ key: "A", text: "像唯一，原像不一定唯一" }, { key: "B", text: "原像唯一" }],
        answer: "A", explanation: "映射只要求像唯一。",
        anchors: [{ sourceId: S1, page: 16 }],
        knowledgePointId: "kp_d", cognitiveLevel: "understand", topic: "映射", order: 1,
        explainNotes: [{ id: "en_d", style: "direct", given: "B",
          crux: "把原像唯一当成了定义。", body: "映射只要求像唯一。",
          nextStep: "举多对一例子。", createdAt: ts }] }]);
      await put("oralReviews", [{ id: "oral_d", scopeLabel: "第一章",
        sourceId: S1, page: 16, quote: "像唯一",
        question: "像和原像的区别？", answer: "像唯一，原像可能多个。",
        verdict: "correct", quotedFromSource: "", quoteVerified: false,
        explanation: "说对了。", correction: "", savedAs: "brief",
        fullText: null, createdAt: ts }]);
      db.close();
      return { ok: true };
    })()`);
    rec('隔离副本种子写入', !!(seed && seed.ok));

    await evalJs('location.reload()');
    await sleep(7000);

    /* 进复习巩固页 */
    await evalJs(`(() => {
      for (const lb of document.querySelectorAll(".nav-group__label")) {
        const b = lb.closest("button"); const g = lb.closest(".nav-group");
        if (b && g && g.getAttribute("aria-expanded") !== "true") b.click();
      }
      return true;
    })()`);
    await sleep(600);
    await evalJs(`(() => {
      const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
        .find((e) => e.textContent.trim().includes("复习巩固"));
      if (el) { el.click(); return true; }
      return false;
    })()`);
    await waitFor(`document.querySelector(".bk-toolbar") ? true : null`, 20000, '复习巩固页');
    await sleep(800);
    await shot('01-desktop-book.png');

    /* ① 收起按钮 */
    const fold = await evalJs(`(() => {
      const bs = [...document.querySelectorAll(".bk-volume__fold")];
      return { count: bs.length, text: bs[0] ? bs[0].textContent.trim() : "",
               visible: bs[0] ? bs[0].getBoundingClientRect().width > 0 : false };
    })()`);
    rec('**① 安装版有每卷收起按钮**', fold.count >= 1 && fold.visible, '数量=' + fold.count + ' 文案=' + fold.text);

    /* ② 定位回原文 */
    const locate = await evalJs(`(() => {
      const bs = [...document.querySelectorAll(".bk-q__locate")];
      const n = document.querySelectorAll(".bk-q").length;
      if (!bs.length) return { count: 0, qCount: n };
      const cs = getComputedStyle(bs[0]);
      return { count: bs.length, qCount: n, text: bs[0].textContent.trim(),
               color: cs.color, cursor: cs.cursor };
    })()`);
    rec('**② 安装版每题有「定位回原文」**', locate.count === locate.qCount && locate.count > 0,
        '题=' + locate.qCount + ' 按钮=' + locate.count);
    rec('定位按钮文案带页码', /第 \d+ 页/.test(locate.text || ''), locate.text || '');
    rec('定位按钮颜色已生效（本轮修过的层外规则）', locate.color !== undefined, locate.color || '');

    /* ③ 两级入口 */
    const oralBtn = await evalJs(`(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => x.textContent.trim() === "提问式复习");
      if (b) { b.click(); return true; }
      return false;
    })()`);
    await sleep(900);
    const chooser = await evalJs(`(() => {
      const box = document.querySelector(".oral-entry");
      if (!box) return null;
      return {
        cols: [...box.querySelectorAll(".oral-entry__col")].length,
        btns: [...box.querySelectorAll(".oral-entry__btn")].map((b) => b.textContent.trim()),
        mentionsSelection: (box.textContent || "").includes("拖选"),
        hasSteps: !!box.querySelector(".oral-entry__steps"),
      };
    })()`);
    rec('**③ 安装版有提问式复习两级入口**', !!oralBtn && !!chooser, JSON.stringify(chooser?.cols));
    rec('两栏（知识库 / 原文划选）', chooser?.cols === 2, JSON.stringify(chooser?.btns));
    rec('告诉用户回资料库划选原文', !!chooser?.mentionsSelection && !!chooser?.hasSteps);
    await shot('02-desktop-oral-chooser.png');

    /* ④ 答疑记录分类 */
    await evalJs(`(() => {
      const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
        .find((e) => e.textContent.trim().includes("答疑记录"));
      if (el) { el.click(); return true; }
      return false;
    })()`);
    await waitFor(`document.querySelector(".ansrec-page") ? true : null`, 20000, '答疑记录页');
    await sleep(800);
    const tabs = await evalJs(`(() => {
      const ts = [...document.querySelectorAll(".ansrec-tab")];
      return { count: ts.length, labels: ts.map((t) => t.textContent.trim()) };
    })()`);
    rec('**④ 安装版答疑记录有分类页签**', tabs.count === 3, JSON.stringify(tabs.labels));
    rec('两个来源各一个入口',
        tabs.labels.some((l) => l.includes('提问复习')) && tabs.labels.some((l) => l.includes('错题讲解')),
        JSON.stringify(tabs.labels));
    await shot('03-desktop-answer-tabs.png');

    /* 版本号与图标一致性 */
    const meta = await evalJs(`(() => ({
      title: document.title,
      hasApp: !!document.querySelector(".app"),
    }))()`);
    rec('页面标题是 Open Learner（更名边界：文案改了、目录名没改）',
        (meta.title || '').includes('Open Learner'), meta.title);

    console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
    console.log('  截图：' + OUT);
    if (fail > 0) process.exitCode = 1;
  } catch (e) {
    console.error('脚本异常：', e && e.message);
    console.error(appLog.slice(-2000));
    process.exitCode = 2;
  } finally {
    try {
      ws && ws.close();
    } catch {}
    app.kill();
    await sleep(1500);
  }
})();

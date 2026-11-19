/**
 * 验证「定位到句子 + 橙色临时高亮」在**桌面安装版**里生效（2026-11-20）。
 *
 * 与 verify-locate-sentence.cjs（源码侧）同一套断言，只换启动目标：
 * 这里跑安装目录的 OpenLeaner.exe，验的是它加载的 resources/app.asar。
 *
 * ## 用户诉求
 *
 * > 定位功能不够，现在只能定位到页面，不能具体到句子。现在在修改一下，
 * > 同时定位到句子时应该和标注的高亮的效果一样，只不过换成橙光来用来与
 * > 高亮和备注区分开来。（该橙光是临时的，当用户转到其他页面/界面时就会消失）
 *
 * ## 要证的六件事
 *
 * 1. 定位**真的圈到那一句**（不是整页 / 不是整段）
 * 2. 橙光颜色与标注高亮的黄色**确实不同**（读 computedStyle，不看类名猜）
 * 3. 橙光的**形状与标注高亮一致**（同样的 padding / 圆角 —— 用户说"效果一样"）
 * 4. 橙光**只在句子范围内**（mark 的文本长度 ≈ 锚点跨度，不是整段）
 * 5. **翻页就消失**（用户说"临时"）
 * 6. 自改题（无出处）**给出提示而非废按钮**
 *
 * ## 种什么数据
 *
 * 三种锚点形状各一道题，对应真实库里的三种情况：
 *  - 句子级偏移 → 应能定位到句子 + 橙光
 *  - 整段偏移   → 只跳页 + 说明为什么不高亮
 *  - 没有锚点   → 只给提示、不摆按钮
 *
 * 用法：node scripts/verify-locate-sentence.cjs [CDP端口]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXE = 'C:/Users/ASUS/AppData/Local/Programs/OpenLeaner/OpenLeaner.exe';
const APPDATA = path.resolve(ROOT, '.tmp/desktop-locate-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/desktop-locate');
/* 9831/9837/9847 保留，9830/9824 用过，这里用 9834 */
const PORT = Number(process.argv[2] || 9795);
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x) => {
  console.log((ok ? '✅ ' : '❌ ') + n + (x ? ' :: ' + x : ''));
  ok ? pass++ : fail++;
};

/* 正文：三段，每段够长（>80 字才不会被 segmentsToMaterials 之类过滤） */
const SEG_TEXT =
  '设 f: X → Y 是一个映射，对 X 中每个元素 x，按法则 f 在 Y 中有唯一确定的元素 y 与之对应。' +
  '因此像唯一，但原像不一定唯一，值域是陪域的子集。映射的记法通常写成 y = f(x)，其中 x 称为自变量。' +
  '若对每个 y 都属于像集都存在 x 使 f(x) = y，则称 f 为满射；若像唯一对应原像也唯一，则称 f 为单射。' +
  '既是单射又是满射的映射称为双射，也叫一一映射。判断一个映射是不是双射，要分别检验单射性与满射性。';

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
    [`--user-data-dir=${DATA}`, '--no-sandbox', '--remote-debugging-port=' + PORT, '--window-size=1440,1100'],
    { cwd: path.dirname(EXE), env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
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
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
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

    /* 种数据：句子级 / 整段级 / 无锚点 三道题 */
    const seeded = await evalJs(`(async () => {
      const db = await new Promise((res, rej) => {
        const q = indexedDB.open("openleaner");
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      const ts = new Date().toISOString();
      const TEXT = ${JSON.stringify(SEG_TEXT)};
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

      const SRC = "src_l1";
      await put("sources", [{ id: SRC, title: "定位验证资料", kind: "text", pageCount: 3,
        textStatus: "ready", createdAt: ts, updatedAt: ts, segmentCount: 2, readProgress: null }]);
      await put("sourceSegments", [
        { id: "seg_l1", sourceId: SRC, index: 1, page: 16,
          chapter: "第一章 映射", text: TEXT, charCount: TEXT.length },
        /*
         * 必须有第二段 —— 否则「下一段」按钮是 disabled，
         * 「翻页后橙光消失」这条断言根本没让翻页发生（第一版就这样误报过）。
         */
        { id: "seg_l2", sourceId: SRC, index: 2, page: 17,
          chapter: "第一章 映射",
          text: "第二段正文用于验证翻页。判断映射是否为双射时，需要分别检验单射性与满射性。" +
                "单射要求不同的自变量对应不同的像；满射要求每个陪域元素都被某个自变量映到。",
          charCount: 76 },
      ]);

      /* 句子：从「因此像唯一」开始的 30 字 —— 一段真句子 */
      const sentStart = TEXT.indexOf("因此像唯一");
      const sentEnd = sentStart + 30;

      await put("decks", [{ id: "deck_l1", title: "定位验证题组", courseId: null,
        status: "published", sourceId: SRC, backendId: null, kinds: ["single"],
        questionCount: 3, blockingIssues: 0, publishedAt: ts, createdAt: ts, updatedAt: ts }]);

      await put("questions", [
        {
          id: "q_sentence", deckId: "deck_l1", kind: "single",
          prompt: "【句子级】映射的像与原像的关系？",
          options: [{ key: "A", text: "像唯一，原像不一定唯一" }],
          answer: "A", explanation: "见原文。",
          anchors: [{ sourceId: SRC, page: 16, segmentId: "seg_l1", charStart: sentStart, charEnd: sentEnd }],
          knowledgePointId: null, cognitiveLevel: "understand", topic: "映射", order: 1,
        },
        {
          id: "q_whole", deckId: "deck_l1", kind: "single",
          prompt: "【整段级】整段出处的题",
          options: [{ key: "A", text: "看原文" }],
          answer: "A", explanation: "整段。",
          anchors: [{ sourceId: SRC, page: 16, segmentId: "seg_l1", charStart: 0, charEnd: TEXT.length }],
          knowledgePointId: null, cognitiveLevel: "understand", topic: "映射", order: 2,
        },
        {
          id: "q_none", deckId: "deck_l1", kind: "single",
          prompt: "【无出处】自改题",
          options: [{ key: "A", text: "随便" }],
          answer: "A", explanation: "自改。",
          anchors: [],
          knowledgePointId: null, cognitiveLevel: "understand", topic: "映射", order: 3,
        },
      ]);
      db.close();
      return { ok: true, sentStart, sentEnd, textLen: TEXT.length };
    })()`);
    rec('种子写入（句子级 / 整段 / 无锚点 三道题）', !!(seeded && seeded.ok),
        `句子=${seeded?.sentStart}-${seeded?.sentEnd} 段长=${seeded?.textLen}`);

    await evalJs('location.reload()');
    await SLEEP(7000);

    /* 进复习巩固 */
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
    await SLEEP(900);
    await shot('01-book-three-kinds.png');

    /* ---------- 三种题的定位入口文案 ---------- */
    const locateUi = await evalJs(`(() => {
      const items = [...document.querySelectorAll(".bk-q")];
      return items.map((li) => {
        const btn = li.querySelector(".bk-q__locate");
        const none = li.querySelector(".bk-q__from--none");
        const note = li.querySelector(".bk-q__locate-note");
        return {
          prompt: (li.querySelector(".bk-q__prompt")?.textContent ?? "").slice(0, 14),
          btnText: btn ? btn.textContent.trim() : null,
          note: note ? note.textContent.trim() : null,
          noneText: none ? none.textContent.trim() : null,
        };
      });
    })()`);
    console.log('  三道题的入口 =', JSON.stringify(locateUi, null, 1));

    const sentenceItem = locateUi.find((x) => x.prompt.includes('句子级'));
    const wholeItem = locateUi.find((x) => x.prompt.includes('整段级'));
    const noneItem = locateUi.find((x) => x.prompt.includes('无出处'));

    rec('**句子级题：入口明确说「具体句子」**',
        !!sentenceItem && /具体句子/.test(sentenceItem.btnText || ''), sentenceItem?.btnText ?? '');
    rec('整段级题：入口说「跳到原文」、不宣称能到句子',
        !!wholeItem && /跳到原文/.test(wholeItem.btnText || '') && !/具体句子/.test(wholeItem.btnText || ''),
        wholeItem?.btnText ?? '');
    rec('整段级题：旁边说明了为什么不高亮',
        !!wholeItem && /整段/.test(wholeItem.note || ''), wholeItem?.note ?? '');
    rec('**无出处题：不摆按钮，只给提示**（用户：自改题可以没有定位功能）',
        !!noneItem && noneItem.btnText === null && !!noneItem.noneText, noneItem?.noneText ?? '');
    rec('无出处题的提示说清原因（提到自选/改造/找回）',
        !!noneItem && /自选|改造|手工|出处/.test(noneItem.noneText || ''), noneItem?.noneText ?? '');

    /* ---------- 点句子级那道 → 验证橙光 ---------- */
    const clicked = await evalJs(`(() => {
      const items = [...document.querySelectorAll(".bk-q")];
      const li = items.find((x) => (x.querySelector(".bk-q__prompt")?.textContent ?? "").includes("句子级"));
      const b = li && li.querySelector(".bk-q__locate");
      if (b) { b.click(); return true; }
      return false;
    })()`);
    rec('能点「定位回原文」', !!clicked);

    await waitFor(`document.querySelector(".reader-page, .reader-split") ? true : null`, 20000, '阅读器');
    await SLEEP(2200);

    const markInfo = await evalJs(`(() => {
      const marks = [...document.querySelectorAll("mark.reader-mark")];
      if (!marks.length) return { count: 0 };
      const m = marks[0];
      const cs = getComputedStyle(m);
      const r = m.getBoundingClientRect();
      return {
        count: marks.length,
        text: m.textContent || "",
        textLen: (m.textContent || "").length,
        className: m.className,
        bg: cs.backgroundColor,
        padding: cs.padding,
        radius: cs.borderRadius,
        shadow: cs.boxShadow,
        visible: r.width > 0 && r.height > 0,
      };
    })()`);
    console.log('  橙光 mark =', JSON.stringify(markInfo, null, 1));

    rec('**阅读器里出现了定位 mark**', markInfo.count >= 1, '数量=' + markInfo.count);
    rec('mark 可见（尺寸非零）', !!markInfo.visible);
    rec('**mark 带临时橙光 class**', /reader-mark--transient/.test(markInfo.className || ''), markInfo.className || '');

    /*
     * 核心断言：橙光**只圈那一句**，不是整段。
     * 整段有 200+ 字，句子 30 字 —— 用长度区分，宽一点的断言会放过整页高亮。
     */
    rec('**橙光只圈 30 字左右的句子，不是整段**',
        markInfo.textLen > 10 && markInfo.textLen <= 40,
        'mark 文本长度=' + markInfo.textLen + ' 段长=' + (seeded?.textLen ?? '?'));

    /*
     * 颜色必须是橙（红通道显著高于蓝、绿），且与黄色高亮不同。
     * 只判「不是透明」会放过任何颜色 —— 那是上一轮踩过的坑。
     */
    const rgb = (s) => {
      const m = String(s).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
    };
    const c = rgb(markInfo.bg);
    rec('**底色是橙色**（红 > 绿 > 蓝）',
        !!c && c.r > c.g && c.g > c.b && c.r - c.b > 60,
        markInfo.bg || '');

    /* 与黄色标注高亮对比：取 .reader-mark 的基准色 */
    const colorCmp = await evalJs(`(() => {
      const t = document.querySelector("mark.reader-mark--transient");
      if (!t) return null;
      const probe = document.createElement("div");
      probe.className = "reader-mark";
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      document.body.appendChild(probe);
      const yellow = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { transient: getComputedStyle(t).backgroundColor, yellow };
    })()`);
    rec('**橙光与标注高亮的颜色不同**',
        !!colorCmp && colorCmp.transient !== colorCmp.yellow,
        JSON.stringify(colorCmp));

    /*
     * 用户说「和标注的高亮的效果一样」—— 形状要一致（padding / 圆角）。
     * 只改颜色、不改变形状，才是"同一类东西的另一种状态"。
     */
    const shapeCmp = await evalJs(`(() => {
      const t = document.querySelector("mark.reader-mark--transient");
      if (!t) return null;
      const probe = document.createElement("div");
      probe.className = "reader-mark";
      document.body.appendChild(probe);
      const cs = getComputedStyle(probe);
      const y = { padding: cs.padding, radius: cs.borderRadius };
      probe.remove();
      const tc = getComputedStyle(t);
      return { t: { padding: tc.padding, radius: tc.borderRadius }, y };
    })()`);
    rec('**形状与标注高亮一致**（padding / 圆角相同）',
        !!shapeCmp && shapeCmp.t.padding === shapeCmp.y.padding && shapeCmp.t.radius === shapeCmp.y.radius,
        JSON.stringify(shapeCmp));

    /* mark 文本应当是原文里那一句 */
    rec('**橙光圈的是原文里那句真实存在的文字**',
        !!markInfo.text && SEG_TEXT.includes(markInfo.text.trim().slice(0, 10)),
        (markInfo.text || '').slice(0, 30));

    await shot('02-orange-sentence-highlight.png');

    /* ---------- 临时性：翻页就消失 ---------- */
    const beforeFlip = await evalJs(`document.querySelectorAll("mark.reader-mark--transient").length`);
    const flipped = await evalJs(`(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "下一段");
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    })()`);
    await SLEEP(1600);
    const afterFlip = await evalJs(`document.querySelectorAll("mark.reader-mark--transient").length`);
    rec('**翻页后橙光消失**（"临时"的核心）',
        !!flipped && beforeFlip >= 1 && afterFlip === 0,
        `${beforeFlip} → ${afterFlip}`);
    await shot('03-after-page-flip.png');

    /* ---------- 临时性：离开阅读器再回来也不该残留 ---------- */
    await evalJs(`(() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes("返回"));
      if (b) { b.click(); return true; }
      return false;
    })()`);
    await SLEEP(1800);
    const backInBook = await evalJs(`!!document.querySelector(".bk-toolbar")`);
    rec('能从阅读器返回复习巩固页', !!backInBook);

    /* 再点一次，确认能重新定位（不是一次性） */
    await evalJs(`(() => {
      const items = [...document.querySelectorAll(".bk-q")];
      const li = items.find((x) => (x.querySelector(".bk-q__prompt")?.textContent ?? "").includes("句子级"));
      const b = li && li.querySelector(".bk-q__locate");
      if (b) { b.click(); return true; }
      return false;
    })()`);
    await waitFor(`document.querySelector("mark.reader-mark--transient") ? true : null`, 20000, '再次定位');
    rec('**再点一次仍能定位到句子**（可重复使用）', true);

    /* ---------- 整段级题：只跳页，不高亮 ---------- */
    await evalJs(`(() => {
      const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").includes("返回"));
      if (b) { b.click(); return true; }
      return false;
    })()`);
    await waitFor(`document.querySelector(".bk-toolbar") ? true : null`, 20000, '回复习巩固');
    await evalJs(`(() => {
      const items = [...document.querySelectorAll(".bk-q")];
      const li = items.find((x) => (x.querySelector(".bk-q__prompt")?.textContent ?? "").includes("整段级"));
      const b = li && li.querySelector(".bk-q__locate");
      if (b) { b.click(); return true; }
      return false;
    })()`);
    await waitFor(`document.querySelector(".reader-page, .reader-split") ? true : null`, 20000, '阅读器(整段)');
    await SLEEP(2000);
    const wholeMark = await evalJs(`(() => {
      const m = document.querySelectorAll("mark.reader-mark");
      /*
       * 取**全部** reader-jump 再合并文本：有两条可能同时存在
       * （via 状态行 + jumpNote）。第一版只取 querySelector 的第一条，
       * 而整段的提示恰好在第二条，于是断言误报失败。
       */
      const notes = [...document.querySelectorAll(".reader-jump")].map((n) => (n.textContent || "").trim());
      return { markCount: m.length, jumpText: notes.join(" | "), noteCount: notes.length };
    })()`);
    rec('**整段级题：不高亮整页**（不出现满屏 mark）',
        wholeMark.markCount === 0, 'mark 数=' + wholeMark.markCount);
    console.log('  整段级题的提示 =', JSON.stringify(wholeMark));
    rec('整段级题：明确告诉用户为什么不高亮',
        /整段/.test(wholeMark.jumpText || ''), wholeMark.jumpText || '');
    await shot('04-whole-segment-no-highlight.png');

    console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
    console.log('  截图：' + SHOTS);
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
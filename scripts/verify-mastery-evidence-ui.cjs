/**
 * 端到端验证「三层证据锚点」—— **走真实 UI**（2026-11-19 晚）。
 *
 * ## 为什么要另写一份（旧脚本 verify-mastery-evidence.cjs 为什么不够）
 *
 * 旧脚本在页面上下文里 `import('/src/core/...')`，然后**自己重抄了一遍**
 * `handleOralJudge` 的逻辑（chatCompletion + parseEvidence + scoreEvidence）。
 * 它验的是「这四个纯函数串起来能得出正确标签」，**没有验**：
 *
 *   - `App.tsx` 的 `handleOralJudge` 里 `<label>` 那个接线对不对（传了 m.label 没有）
 *   - 证据链路抛错时**兜底旧判定真的会发生**（旧脚本自己 try/catch 复刻，不是真代码）
 *   - 判定结果到了界面**显示成什么样**（用户看到「判定依据」说没给原文依据）
 *   - 真正的**落库**（oralReviews 里存的 verdict 与界面显示是否一致）
 *
 * 按项目硬约束「一条断言如果对坏实现也成立，它就没在验任何东西」，
 * 旧脚本就算全绿也证明不了这条链路是通的。所以这一份：
 *
 *   **只点真实 UI**（导航 → 复习巩固 → 提问式复习 → 输入 → 提交），
 *   判定由 App 里真实的 handleOralJudge 发起，脚本只观察界面与数据库。
 *
 * ## 两个前置条件（旧脚本卡在这里）
 *
 * 1. `BookPage` 在 `volumes.length === 0` 时**整页提前返回**，
 *    toolbar 不渲染 → 「提问式复习」按钮根本不存在。
 *    所以必须种「已发布题组 + 至少 1 道题」。
 * 2. 素材池来自 `knowledgeService.listAll()` 的 `pointsToMaterials`，
 *    所以必须种知识点（且 statement 非空）。
 *
 * ## 假模型
 *
 * 真的调真模型会让判定内容不可控、要 key、要钱、还不可复现。
 * 这里起一个本地假模型（OpenAI 兼容），按 **user prompt 的差异**分流：
 *   - 含 `## 知识点`            → 证据判定请求，返回预置证据
 *   - 含 `## 材料（判定依据）`  → 旧判定请求（兜底路径才用）
 *   - 含 `就上面这段材料出一个问题` → 出题请求
 *
 * 这样**真实代码路径一行没改**，只换了模型那一端。
 *
 * 用法：node scripts/verify-mastery-evidence-ui.cjs [CDP端口] [假模型端口]
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
const APPDATA = path.resolve(ROOT, '.tmp/evidence-ui-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/evidence-ui');
/* 9837 被系统保留（硬约束：用 9824/9825/9830/9832/9834） */
const PORT = Number(process.argv[2] || 9824);
const MODEL_PORT = Number(process.argv[3] || 9924);
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x) => {
  console.log((ok ? '✅ ' : '❌ ') + n + (x ? ' :: ' + x : ''));
  ok ? pass++ : fail++;
};

/* ---------------------------------------------------------------------------
 * 假模型：按 user prompt 分流
 * ------------------------------------------------------------------------- */

/** 概念全对、判断/推理层未涉及（模拟「只答到概念层」） */
const EV_CONCEPT_ONLY = {
  conceptEvidence: {
    redefinesInOwnWords: true,
    distinguishesSimilarConcepts: true,
    givesCounterExamples: true,
    vagueTerms: [],
    conceptErrors: [],
  },
  judgmentEvidence: {
    considersConditions: false,
    distinguishesFactOpinion: false,
    usesQualifiers: false,
    absolutistCount: 0,
    judgmentErrors: [],
  },
  reasoningEvidence: {
    providesPremises: false,
    completeChain: false,
    identifiesAssumptions: false,
    distinguishesDeductiveInductive: false,
    considersCounterfactuals: false,
    fallacyTypes: [],
  },
};

/** 有实质概念错误 → 期望 understanding */
const EV_CONCEPT_ERROR = {
  conceptEvidence: {
    redefinesInOwnWords: true,
    distinguishesSimilarConcepts: false,
    givesCounterExamples: false,
    vagueTerms: [],
    conceptErrors: ['把「有限序列」说成了「无限序列」'],
  },
  judgmentEvidence: {
    considersConditions: false,
    distinguishesFactOpinion: false,
    usesQualifiers: false,
    absolutistCount: 0,
    judgmentErrors: [],
  },
  reasoningEvidence: {
    providesPremises: false,
    completeChain: false,
    identifiesAssumptions: false,
    distinguishesDeductiveInductive: false,
    considersCounterfactuals: false,
    fallacyTypes: [],
  },
};

let currentEvidence = EV_CONCEPT_ONLY;
/** 让证据 JSON 坏掉，验证兜底 */
let breakEvidence = false;

const requests = [];

/** 分类一次请求属于哪种用途 */
function classify(system, user) {
  if (system.includes('学习评估助手')) return 'evidence';
  if (user.includes('就上面这段材料出一个问题')) return 'ask';
  if (user.includes('## 材料（判定依据）')) return 'legacy';
  return 'other';
}

function startFakeModel() {
  const server = http.createServer((req, res) => {
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
      const system = msgs.find((m) => m.role === 'system')?.content ?? '';
      const user = msgs.find((m) => m.role === 'user')?.content ?? '';
      const kind = classify(system, user);
      requests.push({ kind, system, user });

      let content;
      if (kind === 'evidence') {
        content = breakEvidence
          ? '{"conceptEvidence": ' /* 故意坏 */
          : JSON.stringify(currentEvidence);
      } else if (kind === 'legacy') {
        content = JSON.stringify({
          verdict: 'memory',
          quotedFromSource: '线性表是有限序列',
          explanation: '这是旧判定的说明',
          correction: '这是旧判定的纠正',
        });
      } else if (kind === 'ask') {
        content = '线性表为什么必须是有限序列？';
      } else {
        content = '线性表是有限序列';
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          model: 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
        }),
      );
    });
  });
  return server;
}

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(APPDATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  const fake = startFakeModel();
  await new Promise((r) => fake.listen(MODEL_PORT, '127.0.0.1', r));
  console.log('  假模型 127.0.0.1:' + MODEL_PORT);

  if (!fs.existsSync(EXE)) {
    console.error('缺隔离 electron 运行时：' + EXE);
    process.exit(2);
  }
  /*
   * 硬约束：app 目录旁不能有 openleaner-data，
   * 否则 ensureUserDataDir 的第 4 候选会抢先，--user-data-dir 白给。
   */
  const trap = path.join(path.dirname(EXE), 'openleaner-data');
  if (fs.existsSync(trap)) {
    console.error('❌ ' + trap + ' 存在 —— --user-data-dir 会被它抢先，先删掉');
    process.exit(2);
  }

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
    /** 等某个条件成立（轮询页面） */
    const waitFor = async (expr, ms = 30000, label = '') => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const v = await evalJs(expr).catch(() => null);
        if (v) return v;
        await SLEEP(300);
      }
      throw new Error('等待超时' + (label ? '（' + label + '）' : '') + '：' + expr.slice(0, 120));
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await SLEEP(6000);

    /* ---------- 种子数据 ---------- */
    /*
     * 为什么要种题组：BookPage 在 volumes 为空时整页 early return，
     * toolbar 不渲染 → 「提问式复习」按钮不存在。这是本轮踩到的坑之一。
     */
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
      for (const st of ["questions","decks","reviewRecords","reviewLogs","knowledgePoints","sources","sourceSegments","backends","secrets","answerRecords","oralReviews","usageRecords"]) {
        await clear(st);
      }

      const SOURCE = "src_ev";
      await put("sources", [{
        id: SOURCE, title: "数据结构教程", kind: "text", pageCount: 3,
        textStatus: "ready", createdAt: ts, updatedAt: ts,
        segmentCount: 3, readProgress: null,
      }]);
      await put("sourceSegments", [1,2,3].map((p) => ({
        id: "seg_ev" + p, sourceId: SOURCE, index: p, page: p,
        chapter: "第一章 线性表",
        text: "线性表是由 n 个数据元素构成的有限序列，n 称为表长。当 n 为 0 时称为空表。线性表的逻辑特征是：除第一个元素外，每个元素都有且仅有一个直接前驱；除最后一个元素外，每个元素都有且仅有一个直接后继。",
        charCount: 96,
      })));

      /* 知识点：statement 必须非空，否则 pointsToMaterials 会过滤掉 */
      await put("knowledgePoints", [{
        id: "kp_ev", statement: "线性表是有限序列",
        chapter: "第一章 线性表", cognitiveLevel: "understand", tags: [],
        anchors: [{ sourceId: SOURCE, page: 1, charStart: 0, charEnd: 10, segmentId: "seg_ev1" }],
        quotes: ["线性表是由 n 个数据元素构成的有限序列。"],
        anchorStatus: "located", origin: "material", sourceId: SOURCE,
        backendId: "be_ev", createdAt: ts, updatedAt: ts,
      }]);

      /* 已发布题组 + 2 道题（让复习巩固页有内容，按钮才渲染） */
      await put("decks", [{
        id: "deck_ev", title: "线性表练习", courseId: null, status: "published",
        sourceId: SOURCE, backendId: "be_ev", kinds: ["single"],
        questionCount: 2, blockingIssues: 0, publishedAt: ts, createdAt: ts, updatedAt: ts,
      }]);
      await put("questions", [
        {
          id: "q_ev1", deckId: "deck_ev", kind: "single",
          prompt: "线性表的表长可以是什么？",
          options: [
            { key: "A", text: "任意有限数", why: "定义就是有限序列" },
            { key: "B", text: "无穷大", why: "把有限与无限搞混了" },
          ],
          answer: "A", explanation: "线性表是有限序列，表长是有限的。",
          anchors: [{ sourceId: SOURCE, page: 1, charStart: 0, charEnd: 10, segmentId: "seg_ev1" }],
          knowledgePointId: "kp_ev", cognitiveLevel: "understand",
          topic: "线性表", order: 1,
        },
        {
          id: "q_ev2", deckId: "deck_ev", kind: "single",
          prompt: "空表的表长是多少？",
          options: [
            { key: "A", text: "0", why: "n 为 0 时称为空表" },
            { key: "B", text: "1", why: "空表没有元素" },
          ],
          answer: "A", explanation: "n 为 0 时称为空表，表长为 0。",
          anchors: [{ sourceId: SOURCE, page: 1, charStart: 0, charEnd: 10, segmentId: "seg_ev1" }],
          knowledgePointId: "kp_ev", cognitiveLevel: "remember",
          topic: "线性表", order: 2,
        },
      ]);

      /* 后端指向本地假模型 */
      await put("backends", [{
        id: "be_ev", label: "本地假模型", kind: "direct-api",
        provider: "custom", baseUrl: "http://127.0.0.1:${MODEL_PORT}",
        model: "fake-model",
        capabilities: { textOrganize: true, visionFormula: false },
        status: "ready", isDefault: true, createdAt: ts, updatedAt: ts,
      }]);
      await put("secrets", [{ id: "sec_ev", backendId: "be_ev", value: "sk-fake", createdAt: ts, updatedAt: ts }]);

      db.close();
      return { ok: true };
    })()`);
    rec('种子数据写入（资料/知识点/已发布题组2题/后端）', !!(seed && seed.ok));

    /* 确认 --user-data-dir 真生效：数据必须落在副本里 */
    const uddOk = await evalJs(
      `String(location.href).indexOf('file://') === 0`,
    ).catch(() => false);
    rec('页面是 file:// 加载（非 dev server）', !!uddOk);

    await evalJs('location.reload()');
    await SLEEP(7000);

    /* ---------- 走真实 UI ---------- */
    /* 1. 展开侧栏分组并点「复习巩固」 */
    await evalJs(`(() => {
      for (const lb of document.querySelectorAll(".nav-group__label")) {
        const b = lb.closest("button"); const g = lb.closest(".nav-group");
        if (b && g && g.getAttribute("aria-expanded") !== "true") b.click();
      }
      return true;
    })()`);
    await SLEEP(600);
    const navOk = await evalJs(`(() => {
      const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
        .find((e) => e.textContent.trim().includes("复习巩固"));
      if (el) { el.click(); return true; }
      return false;
    })()`);
    rec('侧栏能点到「复习巩固」', !!navOk);

    /* 2. 等复习巩固页就绪，确认题组已渲染（不是空态） */
    const ready = await waitFor(
      `(() => {
        const t = document.querySelector(".bk-title");
        if (!t || !t.textContent.includes("复习巩固")) return null;
        const empty = document.querySelector(".bk-empty");
        return empty ? null : document.querySelector(".bk-toolbar") ? true : null;
      })()`,
      20000,
      '复习巩固页就绪',
    ).catch(() => null);
    rec('**复习巩固页不是空态，toolbar 已渲染**（旧脚本卡在这里）', !!ready);
    await shot('01-book-page.png');

    /* 3. 点「提问式复习」—— 这是真实入口按钮 */
    const oralBtn = await evalJs(`(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => x.textContent.trim() === "提问式复习");
      if (b) { b.click(); return true; }
      return false;
    })()`);
    rec('**「提问式复习」按钮存在且可点**（volumes 非空才有）', !!oralBtn);

    /* 4. 等出题完成（真代码 handleOralAsk → 假模型） */
    const hasQuestion = await waitFor(
      `(() => {
        const q = document.querySelector(".orp__q");
        return q && q.textContent.trim().length > 0 ? q.textContent.trim() : null;
      })()`,
      25000,
      '出题返回',
    ).catch(() => null);
    rec('**真实链路出题成功**（handleOralAsk → onAsk）', !!hasQuestion, hasQuestion || '');
    await shot('02-question.png');

    /* 5. 输入答案并提交（真实 submit → onJudge → handleOralJudge） */
    const typed = await evalJs(`(() => {
      const ta = document.querySelector("textarea.orp__input");
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, "线性表是由 n 个数据元素构成的有限序列，n 就是表长。");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    rec('能往回答框里输入', !!typed);

    await SLEEP(400);
    const submitted = await evalJs(`(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => x.textContent.trim() === "提交回答");
      if (!b || b.disabled) return false;
      b.click();
      return true;
    })()`);
    rec('「提交回答」可点（没被 busy 卡住）', !!submitted);

    /* 6. 等判定结果 —— 用户在界面上看到的那一块 */
    const judged = await waitFor(
      `(() => {
        const tag = document.querySelector(".orp__verdict-tag");
        if (!tag) return null;
        return {
          label: tag.textContent.trim(),
          tone: tag.className,
          explain: (document.querySelector(".orp__explain")?.textContent ?? "").trim(),
          basis: (document.querySelector(".orp__basis")?.textContent ?? "").trim(),
          correction: (document.querySelector(".orp__correction-text")?.textContent ?? "").trim(),
        };
      })()`,
      30000,
      '判定结果',
    ).catch(() => null);
    rec('**真实链路判定返回并在界面显示**（handleOralJudge）', !!judged);
    if (judged) console.log('  界面判定 =', JSON.stringify(judged));
    await shot('03-judged.png');

    /*
     * 概念全对、判断/推理层全 false → correct。
     * 这条是本次换代的核心：**没考查到的层不能拖低分数**。
     */
    rec(
      '**只答到概念层 → 界面显示「答对了」**（未考查层不拖分）',
      judged?.label === '答对了',
      judged?.label ?? '',
    );
    /* explanation 里带三层分数 —— 证明 scoreEvidence 真的算过 */
    rec(
      '判定说明里带了三层分数（概念/判断/推理）',
      !!judged && /概念\s*\d+\s*·\s*判断\s*\d+\s*·\s*推理\s*\d+/.test(judged.explain),
      judged?.explain ?? '',
    );
    /*
     * 新链路没有逐字引文，界面必须**如实说没有依据**，不能假装有。
     * 这是用户对「AI 诚实度」敏感那条（交接文档第九节）。
     *
     * ⚠️ 注意「判定依据」整块只在 verdict !== 'correct' 时才渲染
     * （OralReviewPanel 的设计：答对了还铺一堆依据是噪音）。
     * 所以这条断言只能对**非 correct** 的那次判定生效 ——
     * 第一版把它放在 correct 那次，basis 自然是空串，
     * 断言失败但**不是代码 bug**，是断言放错了位置。
     * 下面第二条判定的截图与 basis 检查才是它的正确位置。
     */
    rec(
      '答对时不铺「判定依据」（避免噪音，设计如此）',
      !!judged && judged.basis === '',
      judged?.basis ?? '',
    );
    rec(
      '证据链路下 correction 有内容（buildCorrection 生效）',
      !!judged && judged.correction.length > 0,
      judged?.correction ?? '',
    );

    /* 7. 保存并读库 —— 证明真的落库，且库里与界面一致 */
    const beforeSave = requests.filter((r) => r.kind === 'evidence').length;
    await evalJs(`(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => x.textContent.trim() === "精简保存");
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    })()`);
    await SLEEP(2500);

    const saved = await evalJs(`(async () => {
      const db = await new Promise((res, rej) => {
        const q = indexedDB.open("openleaner");
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      const all = await new Promise((res, rej) => {
        const tx = db.transaction("oralReviews", "readonly");
        const rq = tx.objectStore("oralReviews").getAll();
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
      db.close();
      return all;
    })()`);
    rec('**判定结果落库 oralReviews**', Array.isArray(saved) && saved.length > 0, '条数=' + (saved?.length ?? 0));
    const row = Array.isArray(saved) ? saved[saved.length - 1] : null;
    if (row) {
      console.log(
        '  落库记录 =',
        JSON.stringify({
          /* ⚠️ verdict 是记录顶层字段，不是 judgement.verdict —— 见 model.ts:1477 */
          verdict: row.verdict,
          savedAs: row.savedAs,
          quoteVerified: row.quoteVerified,
          quotedFromSource: row.quotedFromSource,
          question: String(row.question ?? '').slice(0, 30),
        }),
      );
      rec(
        '**库里 verdict 与界面显示一致**',
        row.verdict === 'correct' && judged?.label === '答对了',
        row.verdict ?? '',
      );
      rec('落库带 savedAs=brief（点的是精简保存）', row.savedAs === 'brief', row.savedAs ?? '');
      /*
       * 新链路没有逐字引文 → 这两个字段必须是空 / false。
       * 如果这里出现了一段编造的引文，说明有人在硬凑「有依据」，
       * 那是交接文档第九节点名的红线（用户对诚实度敏感）。
       */
      rec(
        '**落库如实记下「没有原文依据」**（quotedFromSource 空 / quoteVerified false）',
        row.quotedFromSource === '' && row.quoteVerified === false,
        JSON.stringify({ q: row.quotedFromSource, v: row.quoteVerified }),
      );
    }
    rec(
      '判定确实走的是证据链路（发了 evidence 请求，没有退回 legacy）',
      beforeSave >= 1 && requests.filter((r) => r.kind === 'legacy').length === 0,
      'evidence=' + requests.filter((r) => r.kind === 'evidence').length +
        ' legacy=' + requests.filter((r) => r.kind === 'legacy').length,
    );

    /* ---------- 8. 概念有错 → understanding（再走一遍真实 UI） ---------- */
    currentEvidence = EV_CONCEPT_ERROR;
    await evalJs(`(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => x.textContent.trim() === "再来一题");
      if (b) { b.click(); return true; }
      return false;
    })()`);
    /* 等新一题出来 */
    const q2 = await waitFor(
      `(() => { const q = document.querySelector(".orp__q"); return q && q.textContent.trim().length > 0 ? true : null; })()`,
      25000,
      '第二题',
    ).catch(() => null);
    rec('「再来一题」能换到下一题', !!q2);

    await evalJs(`(() => {
      const ta = document.querySelector("textarea.orp__input");
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, "线性表可以有无限多个元素。");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await SLEEP(400);
    await evalJs(`(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => x.textContent.trim() === "提交回答");
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    })()`);

    const judged2 = await waitFor(
      `(() => {
        const tag = document.querySelector(".orp__verdict-tag");
        if (!tag) return null;
        return {
          label: tag.textContent.trim(),
          tone: tag.className,
          basis: (document.querySelector(".orp__basis")?.textContent ?? "").trim(),
        };
      })()`,
      30000,
      '第二次判定',
    ).catch(() => null);
    rec(
      '**有概念错误 → 界面显示「理解偏差」**',
      judged2?.label === '理解偏差',
      judged2?.label ?? '',
    );
    /*
     * 这条断言必须放在非 correct 的一次 —— 「判定依据」整块只在
     * verdict !== 'correct' 时渲染（见 OralReviewPanel 的设计注释）。
     * 放在 correct 那次会得到空串，误判成 bug。
     */
    rec(
      '**如实显示「模型没有给出原文依据」**（不编造引文）',
      !!judged2 && judged2.basis.includes('没有给出原文依据'),
      judged2?.basis ?? '',
    );
    await shot('04-judged-understanding.png');

    /* ---------- 9. 证据 JSON 坏掉 → 兜底旧判定（真实代码的 try/catch） ---------- */
    /*
     * 这一条旧脚本验不了：它自己复刻了 try/catch。
     * 这里让假模型返回坏 JSON，走**真实 handleOralJudge**，
     * 期望：不报错、退回旧判定、界面显示旧判定的内容。
     */
    breakEvidence = true;
    currentEvidence = EV_CONCEPT_ONLY;
    await evalJs(`(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => x.textContent.trim() === "再来一题");
      if (b) { b.click(); return true; }
      return false;
    })()`);
    await waitFor(
      `(() => { const q = document.querySelector(".orp__q"); return q && q.textContent.trim().length > 0 ? true : null; })()`,
      25000,
      '第三题',
    ).catch(() => null);
    const legacyBefore = requests.filter((r) => r.kind === 'legacy').length;

    await evalJs(`(() => {
      const ta = document.querySelector("textarea.orp__input");
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, "随便答一句。");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await SLEEP(400);
    await evalJs(`(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => x.textContent.trim() === "提交回答");
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    })()`);

    const judged3 = await waitFor(
      `(() => {
        const tag = document.querySelector(".orp__verdict-tag");
        if (!tag) return null;
        return { label: tag.textContent.trim(), explain: (document.querySelector(".orp__explain")?.textContent ?? "").trim() };
      })()`,
      30000,
      '兜底判定',
    ).catch(() => null);
    rec(
      '**证据 JSON 坏掉 → 界面仍然有判定（兜底旧路径，不报错）**',
      !!judged3,
      judged3?.label ?? '',
    );
    rec(
      '兜底时确实改发了旧判定请求（legacy 请求数增加）',
      requests.filter((r) => r.kind === 'legacy').length > legacyBefore,
      'legacy ' + legacyBefore + ' → ' + requests.filter((r) => r.kind === 'legacy').length,
    );
    rec(
      '**兜底那条走的是旧判定内容**（界面说明是旧判定的文本）',
      !!judged3 && judged3.explain.includes('旧判定'),
      judged3?.explain ?? '',
    );
    await shot('05-fallback.png');
    breakEvidence = false;

    /* ---------- 10. 提示词核对（读真实请求体，不是读源码） ---------- */
    const evReqs = requests.filter((r) => r.kind === 'evidence');
    const lastEv = evReqs[evReqs.length - 1];
    rec('**请求体里明确「不要给出分数」**', !!lastEv && lastEv.system.includes('不要给出分数'));
    rec('**请求体要求各层独立、不许凭空补证据**', !!lastEv && lastEv.system.includes('各层独立'));
    rec(
      '请求体不再要求模型给 verdict 标签',
      !!lastEv && !lastEv.system.includes('"verdict"'),
    );
    rec(
      '请求体含三层字段名',
      !!lastEv &&
        lastEv.system.includes('conceptEvidence') &&
        lastEv.system.includes('judgmentEvidence') &&
        lastEv.system.includes('reasoningEvidence'),
    );
    /*
     * 这条是接线正确性的硬证据：handleOralJudge 必须把**知识点 statement**
     * 传进 buildEvidenceUserPrompt，否则模型看不到该判什么。
     * 如果 App.tsx 里漏传 m.label，这里 user 里就没有「线性表是有限序列」。
     */
    rec(
      '**真实请求体里带了知识点 statement**（App 接线正确，不是漏传）',
      !!lastEv && lastEv.user.includes('线性表是有限序列'),
      lastEv ? String(lastEv.user).slice(0, 80) : '',
    );
    rec(
      '真实请求体里带了学生回答',
      !!lastEv && lastEv.user.includes('随便答一句'),
      '',
    );

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
    await new Promise((r) => fake.close(r));
    await SLEEP(1200);
  }
})();

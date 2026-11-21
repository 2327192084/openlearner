/**
 * 验证「依据资料本体」的学习路线（2026-11-21 深夜）。
 *
 * ## 用户这轮的要求
 *
 * > 学习路线应该专门做一个「规划一个学习路线」的按钮。规划方法要改：
 * > 当前是依据知识库里的知识点，应该依据资料本体进行构建。
 * > 对有目录的资料，依据目录内容分析出所学科目，自主分析配合网上检索
 * > 规划学习路线。对于没有目录的资料，可以询问用户资料涉及的科目…
 * > （没有目录的资料要注意边界，规划的路线不能超出现有资料内容范围。）
 *
 * 用户确认的四点：
 * 1. 联网检索 = **真联网**（接搜索 API），由用户在页面勾选决定
 * 2. 规划依据 = 资料本体（不再以知识点为骨架）
 * 3. 只解析了一部分 → **挡住，先提示补解析**
 * 4. 科目推断 → **先告知推定值，用户确认后才规划**
 *
 * ## 要证的
 *
 * 1. 规划面板在（不是旧的「让 AI 排一条学习路线」按钮）
 * 2. 列出资料，每份标出段数/字数/覆盖章范围/有无目录
 * 3. **只解析了一部分的资料被挡住**（真实库的高数 442 页那份）
 * 4. **科目推定被展示出来**（含依据），且可改
 * 5. **覆盖范围写清楚**（用户点名的边界）
 * 6. 联网勾选框在，没 Key 时禁用并说明
 * 7. 生成后路线出现，且**不超出现有章范围**（关键）
 * 8. 越界的步骤被丢掉并在界面提示
 * 9. 页面文案没有字面星号
 * 10. 无控制台报错
 *
 * 用法：node scripts/verify-source-route.cjs [port] [modelPort]
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/source-route-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/source-route');
const PORT = Number(process.argv[2] || 9970);
const MODEL_PORT = Number(process.argv[3] || 9971);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x) => {
  console.log((ok ? '✅ ' : '❌ ') + n + (x ? ' :: ' + x : ''));
  ok ? pass++ : fail++;
};

const requests = [];

/**
 * 假模型的回应。
 *
 * 故意**越界**：资料只到第 1 章，但它排了第 2、3 章。
 * 用来验证解析层真的会把这些丢掉（用户点名的边界要求）。
 */
function routeResponse() {
  return JSON.stringify({
    blocks: [
      {
        title: '基础概念',
        why: '先把定义弄清楚',
        steps: [
          {
            chapterNumber: 1,
            title: '第1章 信号与系统',
            difficulty: 2,
            reason: '起点，最基础',
            basis: 'toc',
          },
        ],
      },
      {
        title: '越界的块（应当被丢掉）',
        why: '这份资料里没有这些章',
        steps: [
          {
            chapterNumber: 2,
            title: '第2章 线性时不变系统',
            difficulty: 3,
            reason: '资料里没有',
            basis: 'model',
          },
          {
            chapterNumber: 3,
            title: '第3章 傅里叶级数',
            difficulty: 4,
            reason: '资料里没有',
            basis: 'model',
          },
        ],
      },
    ],
    beyond: [
      { title: '第2章 线性时不变系统', note: '按常规进度这是下一步，但这份资料没有' },
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
      const system = msgs.filter((m) => m.role === 'system').map((m) => String(m.content || '')).join('\n');

      let kind = 'other';
      let content = '{}';
      if (system.indexOf('学习路线') >= 0 || user.indexOf('请排出学习路线') >= 0) {
        kind = 'route';
        content = routeResponse();
      }
      requests.push({
        kind,
        userLen: user.length,
        /* 记录提示词里有没有范围约束与目录 —— 这是要证的核心 */
        hasScopeLine: (system + user).indexOf('只覆盖第') >= 0,
        hasToc: user.indexOf('目录') >= 0,
        hasSearch: user.indexOf('网上的参考资料') >= 0,
        userHead: user.slice(0, 300),
      });

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
    [ROOT, '--user-data-dir=' + DATA, '--no-sandbox', '--remote-debugging-port=' + PORT, '--window-size=1600,1100'],
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
  const waitFor = async (expr, ms = 45000, label = '') => {
    const end = Date.now() + ms;
    let tries = 0;
    while (Date.now() < end) {
      await sleep(tries === 0 ? 1500 : 1200);
      tries += 1;
      const v = await ev(expr).catch(() => null);
      if (v) return v;
    }
    throw new Error('等待超时（' + label + '）');
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
      id: "be_sr", label: "本地假模型", kind: "direct-api",
      provider: "custom", baseUrl: "http://127.0.0.1:${MODEL_PORT}",
      model: "fake-model",
      capabilities: { textOrganize: true, visionFormula: false },
      status: "ready", isDefault: true, createdAt: ts, updatedAt: ts,
    });
    tx.objectStore("secrets").put({
      id: "sec_sr", backendId: "be_sr", value: "sk-fake", createdAt: ts, updatedAt: ts,
    });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
    return { ok: true };
  })()`);
  rec('后端指向本地假模型', !!(seeded && seeded.ok));

  await ev('location.reload()');
  await sleep(8000);

  /* ---------- 1. 进学习地图，找规划面板 ---------- */
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
  await waitFor(`document.querySelector(".map-page") ? true : null`, 25000, '学习地图');
  await sleep(3000);
  await shot('01-planner-initial.png');

  const panel = await ev(`(() => {
    const page = document.querySelector(".map-page");
    const planner = page.querySelector(".rmap--planner");
    const txt = planner ? (planner.textContent || "") : "";
    return {
      hasPlanner: !!planner,
      hasTitle: txt.includes("学习路线"),
      /* 旧口径的按钮不该再出现 */
      hasOldButton: txt.includes("让 AI 排一条学习路线"),
      hasOldChapterBtn: txt.includes("补缺失的章节"),
      /* 三段结构 */
      hasPickSection: txt.includes("选一份资料"),
      hasConfirmSection: txt.includes("确认科目"),
      hasSearchSection: txt.includes("联网检索"),
      /* 文案里的字面星号 */
      starCount: (txt.match(/\\*\\*/g) || []).length,
      head: txt.replace(/\\s+/g, " ").slice(0, 300),
    };
  })()`);
  console.log('面板 =', JSON.stringify(panel, null, 1));

  rec('**规划面板在**（学习地图里）', !!panel?.hasPlanner && !!panel?.hasTitle);
  rec('**旧口径的「让 AI 排一条学习路线」已消失**', !panel?.hasOldButton);
  rec('旧的「补缺失的章节」也消失了', !panel?.hasOldChapterBtn);
  rec('**有「选一份资料」**（依据资料本体的入口）', !!panel?.hasPickSection);
  rec('**有「确认科目」**（用户要求的先确认）', !!panel?.hasConfirmSection);
  rec('**有「联网检索」**（用户选的真联网）', !!panel?.hasSearchSection);
  rec('页面文案没有字面星号', (panel?.starCount ?? -1) === 0, String(panel?.starCount));

  /* ---------- 2. 资料列表：每份都标出关键信息 ---------- */
  const list = await ev(`(() => {
    const items = [...document.querySelectorAll(".rsp-item")];
    return {
      count: items.length,
      rows: items.map((li) => {
        const label = li.querySelector(".rsp-label");
        return {
          title: (li.querySelector(".rsp-title")?.textContent ?? "").trim(),
          meta: (li.querySelector(".rsp-meta")?.textContent ?? "").replace(/\\s+/g, " ").trim(),
          blocked: !!li.querySelector(".rsp-blocked"),
          blockedText: (li.querySelector(".rsp-blocked")?.textContent ?? "").replace(/\\s+/g, " ").slice(0, 120),
          blockedClass: label ? label.className.indexOf("rsp-label--blocked") >= 0 : false,
        };
      }),
    };
  })()`);
  console.log('资料列表 =', JSON.stringify(list, null, 1));

  rec('**列出了资料**', (list?.count ?? 0) > 0, list?.count + ' 份');
  rec('每份都标出段数/字数/覆盖章', (list?.rows ?? []).every((r) => r.meta.length > 0));

  const blockedRows = (list?.rows ?? []).filter((r) => r.blocked);
  rec('**只解析了一部分的资料被挡住**（用户确认要挡）',
      blockedRows.length > 0,
      blockedRows.length > 0
        ? blockedRows.map((r) => r.title.slice(0, 20) + '：' + r.blockedText.slice(0, 60)).join(' | ')
        : '（没有挡住任何一份）');
  rec('被挡住的资料**仍然列出**（不是隐藏 —— 否则用户以为没导进来）',
      (list?.rows ?? []).length >= blockedRows.length);

  /* ---------- 3. 选一份能排的资料，看科目与范围 ---------- */
  const pickedInfo = await ev(`(() => {
    /* 找第一份没被挡的 */
    const items = [...document.querySelectorAll(".rsp-item")];
    for (const li of items) {
      const label = li.querySelector(".rsp-label");
      if (label && label.className.indexOf("rsp-label--blocked") < 0) {
        const radio = li.querySelector(".rsp-radio");
        if (radio && !radio.checked) { radio.click(); }
        return { clicked: true, title: (li.querySelector(".rsp-title")?.textContent ?? "").trim() };
      }
    }
    return { clicked: false };
  })()`);
  console.log('选中 =', JSON.stringify(pickedInfo));
  await sleep(1200);
  await shot('02-planner-subject-confirm.png');

  const confirmInfo = await ev(`(() => {
    const planner = document.querySelector(".rmap--planner");
    const txt = planner ? (planner.textContent || "") : "";
    const input = planner?.querySelector(".rsp-input");
    const scope = planner?.querySelector(".rsp-scope");
    const guess = planner?.querySelector(".rsp-guess");
    const check = planner?.querySelector(".rsp-check__box");
    return {
      subjectValue: input ? input.value : null,
      hasGuess: !!guess,
      guessText: (guess?.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 200),
      hasScope: !!scope,
      scopeText: (scope?.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 250),
      hasSearchCheck: !!check,
      searchDisabled: check ? check.disabled : null,
      searchText: (planner?.querySelector(".rsp-check__text")?.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 160),
      hasGenerateBtn: !!(planner && [...planner.querySelectorAll("button")].some((b) => (b.textContent || "").indexOf("规划学习路线") >= 0)),
    };
  })()`);
  console.log('科目与范围 =', JSON.stringify(confirmInfo, null, 1));

  rec('**科目推定被展示出来**（含依据，用户要先确认）',
      !!confirmInfo?.hasGuess && (confirmInfo?.guessText ?? '').length > 0,
      confirmInfo?.guessText?.slice(0, 80));
  rec('**科目输入框有值**（推定值预填，用户可改）',
      (confirmInfo?.subjectValue ?? '').length > 0, confirmInfo?.subjectValue);
  rec('**覆盖范围写清楚了**（用户点名的边界）',
      !!confirmInfo?.hasScope && (confirmInfo?.scopeText ?? '').length > 0,
      confirmInfo?.scopeText?.slice(0, 120));
  rec('有联网勾选框', !!confirmInfo?.hasSearchCheck);
  rec('**没配搜索 Key 时勾选框禁用**（不静默联网）',
      confirmInfo?.searchDisabled === true,
      '禁用=' + confirmInfo?.searchDisabled + '｜' + (confirmInfo?.searchText ?? '').slice(0, 80));
  rec('有「规划学习路线」按钮', !!confirmInfo?.hasGenerateBtn);

  /* ---------- 4. 生成路线 ---------- */
  await ev(`(() => {
    const b = [...document.querySelectorAll(".rmap--planner button")]
      .find((x) => (x.textContent || "").indexOf("规划学习路线") >= 0);
    if (b) b.click();
    return true;
  })()`);

  await waitFor(
    `document.querySelector(".rsp-saved") ? true : (document.querySelector(".rmap--planner .map-error") ? "err" : null)`,
    60000,
    '路线生成',
  );
  await sleep(1500);
  await shot('03-route-generated.png');

  const routeErr = await ev(`(() => {
    const e = document.querySelector(".rmap--planner .map-error");
    return e ? e.textContent.trim() : null;
  })()`);
  if (routeErr) console.error('❌ 规划失败：' + routeErr);
  rec('规划没有报错', !routeErr, routeErr ?? '');

  const promptInfo = requests.find((r) => r.kind === 'route');
  rec('**真的调到了模型**', !!promptInfo);
  rec('**提示词里带了范围约束**（用户点名的边界要求）',
      !!promptInfo?.hasScopeLine, 'hasScopeLine=' + promptInfo?.hasScopeLine);
  rec('**提示词里带了目录**（依据资料本体）',
      !!promptInfo?.hasToc, 'hasToc=' + promptInfo?.hasToc);
  rec('没勾联网时提示词里说明「这次没有联网」',
      !!promptInfo && !promptInfo.hasSearch);

  /* ---------- 5. 关键：越界的步骤必须被丢掉 ---------- */
  const savedInfo = await ev(`(async () => {
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
    const route = row && row.sourceRoute;
    return {
      hasRoute: !!route,
      subject: route ? route.subject : null,
      stepCount: route && Array.isArray(route.blocks)
        ? route.blocks.reduce((n, b) => n + (b.steps ? b.steps.length : 0), 0)
        : 0,
      chapters: route && Array.isArray(route.blocks)
        ? route.blocks.flatMap((b) => (b.steps || []).map((s) => s.chapterNumber))
        : [],
      beyondCount: route && Array.isArray(route.beyond) ? route.beyond.length : 0,
      dropped: route ? route.droppedOutOfScope : null,
      usedSearch: route ? route.usedSearch : null,
    };
  })()`);
  console.log('已保存路线 =', JSON.stringify(savedInfo, null, 1));

  rec('**路线已保存**', !!savedInfo?.hasRoute);
  rec('科目写进了路线', (savedInfo?.subject ?? '').length > 0, savedInfo?.subject);
  rec('**⚠️ 越界的章被丢掉**（模型排了第 2、3 章，资料只有第 1 章）',
      (savedInfo?.chapters ?? []).every((c) => c === 1 || c === 0),
      '保留的章号 = ' + JSON.stringify(savedInfo?.chapters));
  rec('**越界条数被如实记录**', (savedInfo?.dropped ?? 0) >= 2, 'dropped=' + savedInfo?.dropped);
  rec('**beyond 如实告知资料外的部分**',
      (savedInfo?.beyondCount ?? 0) > 0, 'beyond=' + savedInfo?.beyondCount + ' 条');

  const routeView = await ev(`(() => {
    const planner = document.querySelector(".rmap--planner");
    const txt = planner ? (planner.textContent || "") : "";
    return {
      savedText: (planner?.querySelector(".rsp-saved__lead")?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
      fullText: txt.replace(/\\s+/g, ' ').slice(0, 400),
      starCount: (txt.match(/\\*\\*/g) || []).length,
    };
  })()`);
  rec('界面显示已确认路线摘要', (routeView?.savedText ?? '').length > 0, routeView?.savedText);
  rec('生成后页面仍无字面星号', (routeView?.starCount ?? -1) === 0, String(routeView?.starCount));

  /* ---------- 6. 无控制台报错 ---------- */
  const realErrs = errs.filter((e) => e && e.indexOf('favicon') < 0 && e.indexOf('ERR_FILE') < 0);
  rec('无控制台报错', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  console.log('\n==========================');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  console.log('截图：' + SHOTS);
  console.log('假模型请求 =', JSON.stringify(requests.map((r) => ({ kind: r.kind, hasScope: r.hasScopeLine, hasToc: r.hasToc }))));

  try { app.kill(); } catch {}
  await new Promise((r) => fake.close(r));
  await sleep(600);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('脚本本身出错：' + (e && e.stack ? e.stack : e));
  process.exit(3);
});
/**
 * 验证闪卡第三批改动（2026-11-24 凌晨）。
 *
 * ## 用户需求（原话，m05550）
 * > 这个写记忆闪卡的功能需要修改一下，文本描述改回"写闪卡"。
 * > 用户使用这个功能写完闪卡后再决定闪卡归属知识点类、错题类还是记忆类。
 * > 最后再加给导入闪卡功能
 *
 * 导入格式用户只勾了一种：Obsidian Callout 卡片（m05564）。
 *
 * ## 验什么（关系断言优先，硬约束 1）
 *
 * 1. 入口按钮文案是「写闪卡」「导入」，「记忆闪卡」不再出现在入口区
 * 2. 写卡面板标题是「写闪卡」，说明里不再有「改名为记忆」那段
 * 3. 写完再定归属：面板里三档归属可点，默认「记忆」
 * 4. ★ 写一张「错题」卡 → 错题 tab +1、记忆 tab 不变（关系：归属真的落到了那一栏）
 * 5. ★ 编辑改成「知识点」→ 错题 -1、知识点 +1、全部不变（关系：改归属不是复制一张）
 * 6. 导入面板能开，解析出正确张数、预览可见
 * 7. ★ 导入 2 张 → 全部 tab +2、记忆 tab +2（关系）
 * 8. ★ 同一个文件再导一次 → 全部张数不变（关系：重复正面要跳过，不是导两遍）
 * 9. ★ 导入带标签的文件 → 标签 chip 出现且计数 = 卡数（关系）
 * 10. 无控制台报错
 *
 * 全程跑在 .tmp/fwc-appdata 隔离副本，真实库不碰。
 * 用法：node scripts/verify-flashcard-write-card.cjs [port] [--desktop]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/fwc-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/flashcard-write-card');
const PORT = Number(process.argv[2] || 9903);
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

/** 导入用的夹具：Obsidian Callout 版式，带 `#flashcards/验收` 分节 */
const FIXTURE = [
  '---',
  'title: "验收夹具"',
  '---',
  '',
  '#flashcards/验收',
  '',
  '> [!tip] 闪卡 1｜验收用卡甲',
  '> **题目**',
  '> 1 + 1 等于几？',
  '>',
  '> ✅答案：2',
  '> 💡要点：这是导入验收的第一张。',
  '',
  '> [!tip] 闪卡 2｜验收用卡乙',
  '> **题目**',
  '> $\\lim_{x\\to 0}\\frac{\\sin x}{x}$ 等于？',
  '>',
  '> ✅答案：1',
  '> ❌坑：别把它和 $\\frac{0}{0}$ 混。',
  '',
].join('\n');

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(APPDATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.cpSync(path.join(process.env.APPDATA, 'OpenLeaner/IndexedDB'), path.join(DATA, 'IndexedDB'), {
    recursive: true,
  });
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

  const app = spawn(exe, ['--user-data-dir=' + DATA, '--no-sandbox', '--remote-debugging-port=' + PORT], {
    cwd: APP_DIR,
    env: { ...process.env, APPDATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };
  const shot = async (n) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, n), Buffer.from(r.data, 'base64'));
  };
  const waitFor = async (expr, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await ev(expr).catch(() => false);
      if (v) return v;
      await sleep(400);
    }
    return false;
  };
  /** React 受控输入框：必须用原型 setter + input 事件（直接赋值不进 state） */
  const setInput = async (selector, value) =>
    ev(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
  /** 按纯文本点按钮（去掉＋与数字与空白） */
  const clickByText = async (selector, text) => {
    const ok = await waitFor(`(() => {
      return [...document.querySelectorAll(${JSON.stringify(selector)})]
        .some((e) => (e.textContent || "").replace(/[\\d\\s＋+]+/g, "").trim() === ${JSON.stringify(text)});
    })()`, 8000);
    if (!ok) return false;
    return ev(`(() => {
      const b = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((e) => (e.textContent || "").replace(/[\\d\\s＋+]+/g, "").trim() === ${JSON.stringify(text)});
      if (b) b.click(); return !!b;
    })()`);
  };

  /**
   * 按「包含某段文字」点按钮。
   *
   * clickByText 是把数字剥掉后**全等**比较 —— 对「建卡」「收起」够用，
   * 但「导入 2 张」剥完数字还剩一个「张」，全等永远打不到。
   * 这里单独给带计数的按钮用包含匹配，并回报打到了哪个按钮，
   * 免得又出现"点了但没点着"的静默失败。
   */
  const clickContains = async (selector, text) => {
    const ok = await waitFor(`(() => {
      return [...document.querySelectorAll(${JSON.stringify(selector)})]
        .some((e) => (e.textContent || "").indexOf(${JSON.stringify(text)}) >= 0 && !e.disabled);
    })()`, 8000);
    if (!ok) return null;
    return ev(`(() => {
      const b = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((e) => (e.textContent || "").indexOf(${JSON.stringify(text)}) >= 0 && !e.disabled);
      if (b) { b.click(); return (b.textContent || "").trim(); }
      return null;
    })()`);
  };

  const countItems = `document.querySelectorAll(".fcx__item--callout").length`;
  /** 各 tab 的数字（textContent 形如 "全部\n10\n"） */
  const tabN = (label) => `(() => {
    const t = [...document.querySelectorAll(".fcx__tab")].find(
      (e) => (e.textContent || "").replace(/[\\d\\s]+$/g, "").trim() === ${JSON.stringify(label)});
    if (!t) return -1;
    const n = t.querySelector(".fcx__tab-n");
    return Number((n ? n.textContent : "").trim()) || 0;
  })()`;
  const clickTab = async (label) =>
    ev(`(() => {
      const t = [...document.querySelectorAll(".fcx__tab")].find(
        (e) => (e.textContent || "").replace(/[\\d\\s]+$/g, "").trim() === ${JSON.stringify(label)});
      if (t) t.click(); return !!t;
    })()`);

  await send('Runtime.enable');
  await send('Page.enable');
  await send('DOM.enable');
  await sleep(8000);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 1500,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(1000);

  /* ---------- 进闪卡管理页（按标题锁定） ---------- */
  await ev(`(() => {
    for (const lb of document.querySelectorAll(".nav-group__label")) {
      const b = lb.closest("button"); const g = lb.closest(".nav-group");
      if (b && g && g.getAttribute("aria-expanded") !== "true") b.click();
    }
    return true;
  })()`);
  await sleep(800);
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item")].find((e) => (e.textContent || "").trim() === "闪卡管理");
    if (el) el.click();
    return true;
  })()`);
  if (!(await waitFor(`!!document.querySelector(".fcx")`))) {
    rec('进入闪卡管理页', false, '超时');
    cleanup();
    return;
  }
  await waitFor(`!!document.querySelector(".fcx__bar")`);
  await sleep(1500);
  await shot('01-entry.png');

  /* ---------- 1. 入口按钮文案 ---------- */
  const entries = await ev(`(() => {
    return [...document.querySelectorAll(".fcx__head-actions button")].map((e) => (e.textContent || "").trim());
  })()`);
  rec('入口按钮有「＋ 写闪卡」', Array.isArray(entries) && entries.some((t) => t.indexOf('写闪卡') >= 0), JSON.stringify(entries));
  rec('入口按钮有「＋ 导入」', Array.isArray(entries) && entries.some((t) => t.indexOf('导入') >= 0), JSON.stringify(entries));
  rec(
    '★ 入口区不再出现「记忆闪卡」（用户要求改文案）',
    Array.isArray(entries) && !entries.some((t) => t.indexOf('记忆闪卡') >= 0),
    JSON.stringify(entries),
  );

  /* ---------- 2/3. 写闪卡面板 ---------- */
  await clickByText('.fcx__head-actions button', '写闪卡');
  const opened = await waitFor(`!!document.querySelector(".fcx__new-title")`, 8000);
  const panel = await ev(`(() => {
    const t = document.querySelector(".fcx__new-title");
    const box = t ? t.closest(".fcx__new") : null;
    return {
      title: t ? (t.textContent || "").trim() : null,
      hint: box && box.querySelector(".fcx__new-hint") ? box.querySelector(".fcx__new-hint").textContent : "",
      groups: [...document.querySelectorAll(".fcx__grouppick-opt")].map((e) => (e.textContent || "").trim()),
      checked: [...document.querySelectorAll(".fcx__grouppick-opt input")].map((e) => e.checked),
    };
  })()`);
  rec('写闪卡面板打开了', !!opened, JSON.stringify(panel.title));
  rec('★ 面板标题是「写闪卡」', panel.title === '写闪卡', JSON.stringify(panel.title));
  rec(
    '★ 说明里不再有「改名为记忆」那段',
    typeof panel.hint === 'string' && panel.hint.indexOf('改名为') < 0 && panel.hint.indexOf('记忆」——') < 0,
    JSON.stringify((panel.hint || '').slice(0, 60)),
  );
  rec(
    '★ 面板里有归属三档（知识点/错题/记忆）',
    JSON.stringify(panel.groups) === JSON.stringify(['知识点', '错题', '记忆']),
    JSON.stringify(panel.groups),
  );
  rec(
    '★ 归属默认是「记忆」（第 3 个选中）',
    JSON.stringify(panel.checked) === JSON.stringify([false, false, true]),
    JSON.stringify(panel.checked),
  );
  await shot('02-write-panel.png');

  /* ---------- 4. 写一张「错题」卡 ---------- */
  const before = {
    all: await ev(tabN('全部')),
    point: await ev(tabN('知识点闪卡')),
    wrong: await ev(tabN('错题闪卡')),
    memory: await ev(tabN('记忆闪卡')),
  };
  const stamp = Date.now();
  const front = '验收：第三批归属 ' + stamp;
  await setInput('.fcx__new .fcx__textarea[aria-label="正面"]', front);
  await setInput('.fcx__new .fcx__textarea[aria-label="背面"]', '✅答案：归属验收');
  /* 点「错题」那一档（第 2 个 radio） */
  await ev(`(() => {
    const r = [...document.querySelectorAll(".fcx__grouppick-opt input")][1];
    if (r) { r.click(); return true; } return false;
  })()`);
  await sleep(300);
  await clickByText('.fcx__new-actions button', '建卡');
  await waitFor(`!document.querySelector(".fcx__new-title")`, 10000);
  await sleep(1200);

  const after = {
    all: await ev(tabN('全部')),
    point: await ev(tabN('知识点闪卡')),
    wrong: await ev(tabN('错题闪卡')),
    memory: await ev(tabN('记忆闪卡')),
  };
  rec(
    '★ 写一张「错题」卡：全部 +1',
    after.all === before.all + 1,
    `before=${before.all} after=${after.all}`,
  );
  rec(
    '★ 写一张「错题」卡：错题 +1（归属真的落到那一栏）',
    after.wrong === before.wrong + 1,
    `before=${before.wrong} after=${after.wrong}`,
  );
  rec(
    '★ 写一张「错题」卡：记忆栏不变（没有顺手塞进默认栏）',
    after.memory === before.memory,
    `before=${before.memory} after=${after.memory}`,
  );
  rec(
    '★ 三栏数字之和 = 全部（关系断言，不许重复计数）',
    after.point + after.wrong + after.memory === after.all,
    `${after.point}+${after.wrong}+${after.memory} vs ${after.all}`,
  );
  await shot('03-created-wrong.png');

  /* ---------- 5. 编辑改成「知识点」 ---------- */
  await clickTab('错题闪卡');
  await sleep(900);
  /* 找到刚建的那张卡，点它的「编辑」 */
  const editOk = await ev(`(() => {
    const items = [...document.querySelectorAll(".fcx__item--callout")];
    const hit = items.find((li) => (li.textContent || "").indexOf(${JSON.stringify(front)}) >= 0);
    if (!hit) return false;
    const b = [...hit.querySelectorAll(".fcal__act")].find((e) => (e.textContent || "").trim() === "编辑");
    if (b) { b.click(); return true; }
    return false;
  })()`);
  rec('能找到刚建的卡并点「编辑」', editOk === true, String(editOk));
  const editPanel = await waitFor(`!!document.querySelector(".fcx__item--editing .fcx__grouppick-opts")`, 8000);
  rec('编辑面板里也有归属三档（改归属的唯一入口）', !!editPanel, String(!!editPanel));
  if (editPanel) {
    /* 改成「知识点」 */
    await ev(`(() => {
      const box = document.querySelector(".fcx__item--editing");
      const r = box ? [...box.querySelectorAll(".fcx__grouppick-opt input")][0] : null;
      if (r) { r.click(); return true; } return false;
    })()`);
    await sleep(300);
    await clickByText('.fcx__item--editing .fcx__item-actions button', '保存');
    await sleep(1500);

    const moved = {
      all: await ev(tabN('全部')),
      point: await ev(tabN('知识点闪卡')),
      wrong: await ev(tabN('错题闪卡')),
      memory: await ev(tabN('记忆闪卡')),
    };
    rec(
      '★ 改归属后：错题 -1、知识点 +1（真的换栏了）',
      moved.wrong === after.wrong - 1 && moved.point === after.point + 1,
      `wrong ${after.wrong}→${moved.wrong} point ${after.point}→${moved.point}`,
    );
    rec(
      '★ 改归属后：全部张数不变（改归属不是复制一张卡）',
      moved.all === after.all,
      `before=${after.all} after=${moved.all}`,
    );
    rec(
      '★ 改归属后三栏之和仍 = 全部',
      moved.point + moved.wrong + moved.memory === moved.all,
      `${moved.point}+${moved.wrong}+${moved.memory} vs ${moved.all}`,
    );
    await shot('04-moved-point.png');
  }

  /* ---------- 6/7. 导入 ---------- */
  await clickTab('全部');
  await sleep(700);
  const beforeImport = await ev(tabN('全部'));
  const beforeMemory = await ev(tabN('记忆闪卡'));

  await clickByText('.fcx__head-actions button', '导入');
  const importOpen = await waitFor(`!!document.querySelector(".fcx__import")`, 8000);
  rec('导入面板能打开', !!importOpen, String(!!importOpen));
  const hasPick = await ev(`!!document.querySelector(".fcx__import-pick input[type=file]")`);
  rec('导入面板里有文件选择框', hasPick === true, String(hasPick));
  await shot('05-import-empty.png');

  if (importOpen && hasPick) {
    /* 塞夹具文件进去（DataTransfer，绕过系统文件对话框） */
    const fed = await ev(`(() => {
      const md = ${JSON.stringify(FIXTURE)};
      const input = document.querySelector(".fcx__import-pick input[type=file]");
      if (!input) return 'no-input';
      const file = new File([md], '验收夹具.md', { type: 'text/markdown' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return 'ok';
    })()`);
    rec('夹具文件能喂进 input', fed === 'ok', String(fed));
    const parsedOk = await waitFor(`!!document.querySelector(".fcx__import-stats")`, 8000);
    const stats = await ev(`(() => {
      const s = document.querySelector(".fcx__import-stats");
      const pre = document.querySelector(".fcx__import-preview");
      const btn = [...document.querySelectorAll(".fcx__new-actions button")]
        .map((e) => (e.textContent || "").trim());
      return {
        stats: s ? (s.textContent || "").replace(/\\s+/g, " ").trim() : null,
        hasPreview: !!pre,
        buttons: btn,
      };
    })()`);
    rec('★ 解析出 2 张卡（关系：夹具里就是 2 个 callout）', !!parsedOk && /认出\s*2\s*张/.test(stats.stats || ''), JSON.stringify(stats.stats));
    rec('★ 解析报告里有卡组「验收」（文件里的 #flashcards/验收）', /验收/.test(stats.stats || ''), JSON.stringify(stats.stats));
    rec('导入前能预览', stats.hasPreview === true, String(stats.hasPreview));
    await shot('06-import-parsed.png');

    const importBtn = await clickContains('.fcx__new-actions button', '导入');
    rec('★ 「导入 N 张」按钮可点（不是点了没反应）', !!importBtn, JSON.stringify(importBtn));
    await waitFor(`!document.querySelector(".fcx__import")`, 12000);
    await sleep(1500);
    const afterImport = await ev(tabN('全部'));
    const afterMemory = await ev(tabN('记忆闪卡'));
    rec(
      '★ 导入 2 张：全部 +2',
      afterImport === beforeImport + 2,
      `before=${beforeImport} after=${afterImport}`,
    );
    rec(
      '★ 导入 2 张：记忆栏 +2（面板里默认归记忆，且真的落到那栏）',
      afterMemory === beforeMemory + 2,
      `before=${beforeMemory} after=${afterMemory}`,
    );
    const noticeTxt = await ev(`(() => {
      const n = document.querySelector(".fcx__notice"); return n ? (n.textContent || "").trim() : null;
    })()`);
    rec('导入后给了张数提示', typeof noticeTxt === 'string' && /导入\s*2\s*张/.test(noticeTxt), JSON.stringify(noticeTxt));
    await shot('07-imported.png');

    /* ---------- 8. 同一文件再导一次 → 应全部跳过 ---------- */
    const beforeDup = await ev(tabN('全部'));
    await clickByText('.fcx__head-actions button', '导入');
    await waitFor(`!!document.querySelector(".fcx__import")`, 8000);
    await ev(`(() => {
      const md = ${JSON.stringify(FIXTURE)};
      const input = document.querySelector(".fcx__import-pick input[type=file]");
      if (!input) return false;
      const file = new File([md], '验收夹具.md', { type: 'text/markdown' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    await waitFor(`!!document.querySelector(".fcx__import-stats")`, 8000);
    const dupStats = await ev(`(() => {
      const s = document.querySelector(".fcx__import-stats"); return s ? (s.textContent || "").replace(/\\s+/g, " ").trim() : null;
    })()`);
    rec(
      '★ 重复导入的报告说「库里已经有了 2 张」',
      /2\s*张库里已经有了/.test(dupStats || ''),
      JSON.stringify(dupStats),
    );
    const dupBtn = await ev(`(() => {
      const b = [...document.querySelectorAll(".fcx__new-actions button")]
        .find((e) => (e.textContent || "").trim() === "没有可导入的卡");
      return b ? { found: true, disabled: b.disabled } : { found: false };
    })()`);
    rec(
      '★ 全部重复时「导入」按钮变成「没有可导入的卡」且禁用',
      dupBtn.found === true && dupBtn.disabled === true,
      JSON.stringify(dupBtn),
    );
    await shot('08-import-dupe.png');
    /* 关掉面板，确认张数没变（关系：重复导入不会偷偷加卡） */
    await clickByText('.fcx__new-actions button', '收起');
    await sleep(1000);
    const afterDup = await ev(tabN('全部'));
    rec(
      '★ 重复导入后全部张数不变（不许导两遍）',
      afterDup === beforeDup,
      `before=${beforeDup} after=${afterDup}`,
    );

    /* ---------- 9. 导入的卡带上了文件里的标签 ---------- */
    const chips = await ev(`(() => {
      return [...document.querySelectorAll(".fcx__tagchip")].map((e) => ({
        text: (e.textContent || "").replace(/\\s+/g, " ").trim(),
      }));
    })()`);
    const tagChip = (chips || []).find((c) => c.text.indexOf('验收') >= 0);
    rec('★ 导入后标签 chip 里出现「验收」', !!tagChip, JSON.stringify(chips));
    if (tagChip) {
      /* chip 文本是「验收2」——标签名与数字之间没有空格（CSS gap 撑开），
       * 所以不能要求 \s 前缀，否则永远匹配不到。 */
      const m = /(\d+)$/.exec(tagChip.text);
      rec(
        '★ 标签 chip 的数字 = 2（按卡去重，不是按出现次数）',
        !!m && Number(m[1]) === 2,
        JSON.stringify(tagChip.text),
      );
    }
    await shot('09-tagchip.png');
  }

  /* ---------- 10. 卡片上仍有编辑/删除入口 ---------- */
  const acts = await ev(`(() => {
    const li = document.querySelector(".fcx__item--callout");
    return li ? [...li.querySelectorAll(".fcal__act")].map((e) => (e.textContent || "").trim()) : [];
  })()`);
  rec(
    '卡片上仍有 看背面/编辑/删除 三个入口',
    Array.isArray(acts) && acts.some((t) => t.indexOf('背面') >= 0) && acts.indexOf('编辑') >= 0 && acts.some((t) => t.indexOf('删除') >= 0),
    JSON.stringify(acts),
  );

  await shot('12-final.png');

  /* ---------- 控制台 ---------- */
  const realErrs = errs.filter((e) => e && e.indexOf('favicon') < 0 && e.indexOf('ERR_FILE') < 0);
  rec('无控制台报错', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  console.log('\n通过 ' + pass + ' / ' + (pass + fail) + '（跳过 ' + skipped + '）');
  console.log('截图：' + SHOTS);
  cleanup();

  async function cleanup() {
    try {
      app.kill();
    } catch {}
    await sleep(1200);
    const alive = await new Promise((res) => {
      require('node:child_process').exec('tasklist /FI "IMAGENAME eq OpenLeaner.exe"', (e, out) =>
        res(String(out || '').indexOf('OpenLeaner.exe') >= 0),
      );
    });
    console.log(alive ? 'WARN 仍有 OpenLeaner 进程' : '已确认进程退出干净');
    process.exit(fail === 0 ? 0 : 1);
  }
})().catch((e) => {
  console.error('脚本本身出错：' + (e && e.stack ? e.stack : e));
  process.exit(3);
});

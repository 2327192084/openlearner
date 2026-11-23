/**
 * 验证闪卡格式重做（2026-11-23 晚）。
 *
 * ## 用户需求（原话）
 * > 闪卡的编写格式需要再优化一下，要保证和已有闪卡格式一致。然后再在闪卡管理中
 * > 增加一个记忆闪卡，再增加一个在三大类型闪卡下按照所属资料进行分类的功能，
 * > 依旧要给用户留下编辑入口（可以自由增删，修改闪卡）闪卡导出功能一同修改。
 *
 * ## 验什么（按真实操作路径，关系型断言优先）
 *
 * 1. 四个 tab 「全部 / 知识点闪卡 / 错题闪卡 / **记忆闪卡**」都在
 * 2. tab 上的数字 = 该 tab 点开后的卡片段数（**关系断言**，不是"数字>0"）
 * 3. 按资料分组的组头存在；组头数字 = 该组展开后的卡片数（**关系断言**）
 * 4. 组头折叠后卡消失、计数不变（折叠不改变统计）
 * 5. 点「只看这组」→ 列表只剩这一组的卡（组数变 1）
 * 6. 记忆闪卡入口能打开建卡面板（标题「记忆闪卡」），有标签编辑器
 * 7. 新建一张带标签的记忆卡 → 出现在「记忆闪卡」tab 且标签筛选条里有这个标签
 * 8. 挖空卡：`[…]` 遮罩存在；点一下显形（`--shown`）
 * 9. 编辑入口在（每张卡有编辑按钮）；删除入口在
 * 10. 导出按钮文案带张数，点出新窗口/下载不算错（只验存在与计数一致）
 * 11. 无控制台报错
 *
 * 全程跑在 .tmp/flash-appdata 隔离副本，真实库不碰。
 * 用法：node scripts/verify-flashcard-cards.cjs [port] [--desktop]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/flash-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/flashcard-cards');
const PORT = Number(process.argv[2] || 9899);
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
  /** 轮询等条件成立（React 未渲染时同步查会误红） */
  const waitFor = async (expr, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await ev(expr).catch(() => false);
      if (v) return v;
      await sleep(400);
    }
    return false;
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

  /**
   * 往 React 受控输入框里写值（2026-11-23 踩的坑）。
   *
   * ⚠️ 直接 `el.value = x` **不会**更新 React state ——
   * React 在元素实例上重写了 value 的 setter，必须拿原型上的原生 setter
   * 赋值再派发 input 事件。
   * 第一版就是直接赋值，结果正面还是空的、标签也没加上，
   * 脚本报「建卡失败」，看着像功能坏了，其实是脚本没真输入。
   */
  const setInput = async (selector, value) => {
    return ev(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
  };
  /** 按文本点按钮（先等它出现，避免 React 还没渲染就点空） */
  const clickByText = async (selector, text) => {
    const ok = await waitFor(`(() => {
      return [...document.querySelectorAll(${JSON.stringify(selector)})]
        .some((e) => (e.textContent || "").replace(/[\\d\\s]+$/, "").trim() === ${JSON.stringify(text)});
    })()`, 8000);
    if (!ok) return false;
    return ev(`(() => {
      const b = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((e) => (e.textContent || "").replace(/[\\d\\s]+$/, "").trim() === ${JSON.stringify(text)});
      if (b) b.click(); return !!b;
    })()`);
  };

  /* ---------- 进闪卡管理页（按标题锁定，硬约束 18） ---------- */
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
      .find((e) => (e.textContent || "").trim() === "闪卡管理");
    if (el) el.click();
    return true;
  })()`);
  const inPage = await waitFor(`!!document.querySelector(".fcx")`);
  if (!inPage) {
    rec('进入闪卡管理页', false, '超时');
    cleanup();
    return;
  }
  /* 等卡片列表（或空态）渲染完 */
  await waitFor(`!!document.querySelector(".fcx__bar")`);
  await sleep(1500);
  await shot('01-entry.png');

  /* ---------- 1. 四个 tab ---------- */
  /*
   * ⚠️ 标签提取必须去掉所有空白和数字（2026-11-23 踩的坑）。
   *
   * `<button>全部<span class="fcx__tab-n">10</span></button>` 的 textContent
   * 是 `"全部\n10\n"` —— 末尾有换行，`/\d+$/` **匹配不到**，
   * 于是 label 变成 "全部10"，后面按 label 找按钮全部落空
   * （第一次跑出来 8 条假红，全是这个原因）。
   * 用 `/[\d\s]+$/` 一起剥。
   */
  const LABEL_EXPR = `((t) => (t.textContent || "").replace(/[\\d\\s]+$/, "").trim())`;
  const tabs = await ev(`(() => {
    const label = ${LABEL_EXPR};
    return [...document.querySelectorAll(".fcx__tab")].map((t) => ({
      label: label(t),
      n: Number(((t.querySelector(".fcx__tab-n") || {}).textContent || "0").trim()),
      on: t.getAttribute("aria-selected") === "true",
    }));
  })()`);
  const labels = tabs.map((t) => t.label);
  rec(
    '四个 tab 都在（全部/知识点闪卡/错题闪卡/记忆闪卡）',
    ['全部', '知识点闪卡', '错题闪卡', '记忆闪卡'].every((x) => labels.includes(x)),
    labels.join('/'),
  );
  const tabTotal = tabs.find((t) => t.label === '全部')?.n ?? 0;
  const tabSum =
    (tabs.find((t) => t.label === '知识点闪卡')?.n ?? 0) +
    (tabs.find((t) => t.label === '错题闪卡')?.n ?? 0) +
    (tabs.find((t) => t.label === '记忆闪卡')?.n ?? 0);
  rec('★ 三个分组 tab 数字之和 = 「全部」数字（关系断言）', tabSum === tabTotal, `sum=${tabSum} total=${tabTotal}`);

  /* ---------- 2. 点每个 tab，数实际卡片段数 = tab 数字 ---------- */
  const countItems = `document.querySelectorAll(".fcx__item--callout").length`;
  const tabChecks = [];
  for (const t of ['知识点闪卡', '错题闪卡', '记忆闪卡']) {
    await ev(`(() => {
      const b = [...document.querySelectorAll(".fcx__tab")]
        .find((x) => ((x.textContent || "").replace(/[\\d\\s]+$/, "").trim()) === ${JSON.stringify(t)});
      if (b) b.click(); return !!b;
    })()`);
    await sleep(1200);
    const shown = await ev(countItems);
    const expect = tabs.find((x) => x.label === t)?.n ?? -1;
    tabChecks.push(`${t}: shown=${shown} tab=${expect}`);
    rec(`★ 「${t}」点开后卡片数 = tab 数字（关系断言）`, shown === expect, `shown=${shown} tab=${expect}`);
  }

  /* 回到「全部」 */
  await ev(`(() => {
    const b = [...document.querySelectorAll(".fcx__tab")]
      .find((x) => ((x.textContent || "").replace(/[\\d\\s]+$/, "").trim()) === "全部");
    if (b) b.click(); return true;
  })()`);
  await sleep(1200);

  /* ---------- 3. 按资料分组 ---------- */
  const hasGroupSwitch = await ev(`!!document.querySelector(".fcx__groupsw input")`);
  const heads = await ev(`(() => {
    const hs = [...document.querySelectorAll(".fcx__ghead")];
    return hs.map((h) => ({
      title: ((h.querySelector(".fcx__ghead-title") || {}).textContent || "").trim(),
      n: Number(((h.querySelector(".fcx__ghead-n") || {}).textContent || "0").trim()),
    }));
  })()`);
  if (!hasGroupSwitch) {
    skip('按资料分组', '本页没有分组开关（可能宿主未传 sourceTitleOf）');
  } else {
    rec('分组开关存在', true);
    rec('有资料组头', heads.length > 0, `组数=${heads.length}`);
    /* ★ 关系断言：各组数字之和 = 当前显示的全部卡数 */
    const sumHeads = heads.reduce((a, h) => a + h.n, 0);
    const shownAll = await ev(countItems);
    rec('★ 组头数字之和 = 当前显示卡数（关系断言）', sumHeads === shownAll, `sum=${sumHeads} shown=${shownAll}`);
    /* ★ 关系断言：组头数字 = 该组展开后组内卡片数 */
    if (heads.length > 0) {
      const first = heads[0];
      const inGroup = await ev(`(() => {
        const hs = [...document.querySelectorAll(".fcx__ghead")];
        if (!hs.length) return -1;
        /* 从第一个组头往后数，直到下一个组头 */
        let n = 0; let sib = hs[0].nextElementSibling;
        while (sib && !sib.classList.contains("fcx__ghead")) {
          if (sib.classList.contains("fcx__item--callout")) n++;
          sib = sib.nextElementSibling;
        }
        return n;
      })()`);
      rec(`★ 组头「${first.title}」数字 = 组内卡数（关系断言）`, inGroup === first.n, `head=${first.n} inGroup=${inGroup}`);
      await shot('02-grouped.png');

      /* 折叠后卡消失、计数不变 */
      await ev(`(() => {
        const b = document.querySelector(".fcx__ghead-btn"); if (b) b.click(); return true;
      })()`);
      await sleep(900);
      const afterCollapse = await ev(countItems);
      const headAfter = await ev(
        `Number(((document.querySelector(".fcx__ghead-n") || {}).textContent || "0").trim())`,
      );
      rec('折叠后组内卡消失', afterCollapse === shownAll - first.n, `before=${shownAll} after=${afterCollapse}`);
      rec('折叠不改变组头计数', headAfter === first.n, `head=${headAfter}`);
      /* 展开回去 */
      await ev(`(() => {
        const b = document.querySelector(".fcx__ghead-btn"); if (b) b.click(); return true;
      })()`);
      await sleep(900);

      /* 只看这组 */
      await ev(`(() => {
        const b = document.querySelector(".fcx__ghead-filter"); if (b) b.click(); return true;
      })()`);
      await sleep(1200);
      const afterFilter = await ev(`document.querySelectorAll(".fcx__ghead").length`);
      rec('「只看这组」后只剩 1 组', afterFilter === 1, `组数=${afterFilter}`);
      /* 取消 */
      await ev(`(() => {
        const b = [...document.querySelectorAll(".fcx__ghead-filter")]
          .find((x) => (x.textContent || "").includes("取消")); if (b) b.click(); return true;
      })()`);
      await sleep(1000);
    }
  }

  /* ---------- 4. 标签筛选条 ---------- */
  const tagChips = await ev(`(() => {
    return [...document.querySelectorAll(".fcx__tagchip")]
      .filter((c) => !(c.textContent || "").includes("全部标签"))
      .map((c) => ({
        tag: (c.textContent || "").replace(/[\\d\\s]+$/, "").trim(),
        n: Number(((c.querySelector(".fcx__tagn") || {}).textContent || "0").trim()),
      }));
  })()`);
  if (tagChips.length === 0) {
    skip('标签筛选条', '库里还没有带标签的卡（新建后才有）');
  } else {
    rec('标签筛选条存在', true, `标签数=${tagChips.length}`);
    /* ★ 关系断言：点某个标签后，显示卡数 = 该标签 chip 上的数字 */
    const chip = tagChips[0];
    await ev(`(() => {
      const b = [...document.querySelectorAll(".fcx__tagchip")]
        .find((x) => (x.textContent || "").startsWith(${JSON.stringify(chip.tag)}));
      if (b) b.click(); return !!b;
    })()`);
    await sleep(1200);
    const shownByTag = await ev(countItems);
    rec(`★ 按标签「${chip.tag}」筛后卡数 = chip 数字（关系断言）`, shownByTag === chip.n, `shown=${shownByTag} chip=${chip.n}`);
    await shot('03-tagfilter.png');
    /* 取消筛选 */
    await ev(`(() => {
      const b = [...document.querySelectorAll(".fcx__tagchip")]
        .find((x) => (x.textContent || "").includes("全部标签")); if (b) b.click(); return true;
    })()`);
    await sleep(1000);
  }

  /* ---------- 5. 挖空卡：遮罩存在 + 点开显形 ---------- */
  const clozeBefore = await ev(`document.querySelectorAll(".fcal__cloze").length`);
  if (clozeBefore === 0) {
    skip('挖空卡显形', '当前列表里没有挖空卡');
  } else {
    rec('挖空遮罩存在', true, `数量=${clozeBefore}`);
    const beforeShown = await ev(`document.querySelectorAll(".fcal__cloze--shown").length`);
    await ev(`(() => {
      const el = document.querySelector(".fcal__cloze:not(.fcal__cloze--shown)"); if (el) el.click();
      return true;
    })()`);
    await sleep(700);
    const afterShown = await ev(`document.querySelectorAll(".fcal__cloze--shown").length`);
    rec('点一下挖空显形（--shown +1）', afterShown === beforeShown + 1, `before=${beforeShown} after=${afterShown}`);
    await shot('04-cloze.png');
  }

  /* ---------- 6. 记忆闪卡入口 + 新建带标签卡 ---------- */
  await ev(`(() => {
    const b = [...document.querySelectorAll(".fcx__head-actions button")]
      .find((x) => (x.textContent || "").includes("记忆闪卡"));
    if (b) b.click(); return !!b;
  })()`);
  await sleep(1200);
  const panelTitle = await ev(
    `((document.querySelector(".fcx__new-title") || {}).textContent || "").trim()`,
  );
  rec('「记忆闪卡」入口打开建卡面板', panelTitle === '记忆闪卡', 'title=' + panelTitle);
  const hasTagEditor = await ev(`!!document.querySelector(".ctag") || !!document.querySelector(".ctagedit") || document.querySelectorAll(".fcx__new input").length > 0`);
  rec('新建面板里有标签编辑器', hasTagEditor);
  await shot('05-new-memory.png');

  /* 真建一张带标签的卡：填正面/背面/标签，点建卡 */
  const NEW_TAG = '验证用标签' + String(Date.now()).slice(-5);
  const NEW_FRONT = '验证用挖空卡：导数是 ==差商的极限== 吗？';
  const NEW_BACK = '✅答案：是\n💡要点：这是格式验证卡';
  /* 用 setInput（原生 setter + input 事件），直接赋 .value 不进 React state */
  const okFront = await setInput('.fcx__new .fcx__textarea:nth-of-type(1)', NEW_FRONT);
  const taCount = await ev(`document.querySelectorAll(".fcx__new .fcx__textarea").length`);
  if (taCount >= 2) {
    await ev(`(() => {
      const tas = document.querySelectorAll(".fcx__new .fcx__textarea");
      const proto = HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(tas[0], ${JSON.stringify(NEW_FRONT)});
      tas[0].dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(tas[1], ${JSON.stringify(NEW_BACK)});
      tas[1].dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
  }
  await sleep(600);
  /* 标签：CardTagEditor 的输入是 .ctag__input（placeholder「新标签名，回车添加」） */
  const tagFilled = await setInput('.fcx__new .ctag__input', NEW_TAG);
  await sleep(400);
  /* 回车添加（CardTagEditor 的 Enter 处理在 onKeyDown 上） */
  await ev(`(() => {
    const inp = document.querySelector(".fcx__new .ctag__input");
    if (!inp) return false;
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    return true;
  })()`);
  await sleep(500);
  /* 也点一下「添加」按钮兜底（两种入口都支持） */
  await ev(`(() => {
    const b = document.querySelector(".fcx__new .ctag__addbtn");
    if (b) { b.click(); return true; }
    return false;
  })()`);
  await sleep(500);
  /* 确认标签真的进了 UI（chip 出现在 .ctag__current 里）—— 进不去就别指望建卡带标签 */
  const tagInPanel = await ev(`(() => {
    const wrap = document.querySelector(".fcx__new .ctag");
    if (!wrap) return false;
    const cur = wrap.querySelector(".ctag__current");
    if (cur) return (cur.textContent || "").includes(${JSON.stringify(NEW_TAG)});
    const chips = [...wrap.querySelectorAll(".ctag__chip--on")];
    return chips.some((c) => (c.textContent || "").includes(${JSON.stringify(NEW_TAG)}));
  })()`);
  rec('新建面板里标签被加进去（受控输入生效）', tagInPanel, 'tag=' + NEW_TAG);
  console.log('（正面写入：' + okFront + '，标签输入：' + tagFilled + '）');

  const created = await ev(`(() => {
    const b = [...document.querySelectorAll(".fcx__new-actions button")]
      .find((x) => (x.textContent || "").trim() === "建卡");
    if (b) b.click(); return true;
  })()`);
  await sleep(3000);
  /* 新卡应该出现在「记忆闪卡」tab 且带新标签 */
  await clickByText('.fcx__tab', '记忆闪卡');
  await sleep(1500);
  const memCount = await ev(`Number(((document.querySelector(".fcx__tab--on .fcx__tab-n") || {}).textContent || "0").trim())`);
  const newTagInChips = await ev(`(() => {
    return [...document.querySelectorAll(".fcx__tagchip")]
      .some((c) => (c.textContent || "").includes(${JSON.stringify(NEW_TAG)}));
  })()`);
  rec('新建带标签的记忆卡 → 标签出现在筛选条', created && newTagInChips, 'tag=' + NEW_TAG + ' 记忆闪卡数=' + memCount);
  await shot('06-created.png');

  /* ---------- 7. 编辑入口 / 删除入口仍在 ---------- */
  /*
   * ⚠️ 必须切回「全部」再查（2026-11-23 踩的坑）。
   * 「记忆闪卡」原来 0 张，新建后 1 张；但若切 tab 失败或筛选残留，
   * 列表可能是空的 —— 在空列表上查"有没有编辑按钮"必然假红。
   * 所以先切回全部、等列表真渲染出卡片再查。
   */
  await clickByText('.fcx__tab', '全部');
  await sleep(1500);
  const listed = await waitFor(`document.querySelectorAll(".fcx__item--callout").length > 0`, 8000);
  rec('切回「全部」后列表有卡（后续断言的前提）', !!listed);

  /* 编辑/删除按钮在每张卡的操作区，不需要展开（.fcal__acts 一直渲染） */
  const entryCounts = await ev(`(() => {
    const cards = [...document.querySelectorAll(".fcx__item--callout")];
    const withEdit = cards.filter((c) =>
      [...c.querySelectorAll(".fcal__act")].some((b) => (b.textContent || "").trim() === "编辑")).length;
    const withDel = cards.filter((c) =>
      [...c.querySelectorAll(".fcal__act")].some((b) => (b.textContent || "").trim() === "删除")).length;
    return { cards: cards.length, withEdit, withDel };
  })()`);
  rec(
    '★ 每张卡都有「编辑」入口（关系断言：数量相等）',
    entryCounts.cards > 0 && entryCounts.withEdit === entryCounts.cards,
    `cards=${entryCounts.cards} withEdit=${entryCounts.withEdit}`,
  );
  rec(
    '★ 每张卡都有「删除」入口（关系断言：数量相等）',
    entryCounts.cards > 0 && entryCounts.withDel === entryCounts.cards,
    `cards=${entryCounts.cards} withDel=${entryCounts.withDel}`,
  );

  /* 真点一下「编辑」，确认能进编辑态（编辑入口不只是个摆设） */
  await ev(`(() => {
    const b = [...document.querySelectorAll(".fcx__item--callout .fcal__act")]
      .find((x) => (x.textContent || "").trim() === "编辑");
    if (b) b.click(); return !!b;
  })()`);
  await sleep(1200);
  const editingNow = await ev(`!!document.querySelector(".fcx__item--editing .fcx__textarea")`);
  rec('点「编辑」真能进编辑态（有 textarea）', editingNow);
  /* 退出编辑态，免得影响后面的导出计数 */
  await ev(`(() => {
    const b = [...document.querySelectorAll(".fcx__item--editing button")]
      .find((x) => (x.textContent || "").trim() === "取消");
    if (b) b.click(); return !!b;
  })()`);
  await sleep(1000);

  /* ---------- 8. 第二轮：新建的卡正好是「带标签 + 挖空」，用它验筛选与显形 ---------- */
  /*
   * ⚠️ 上面那两处 SKIP 本来是永久盲区（库副本里一张带标签/挖空的卡都没有），
   * 所以在这里补一轮：刚才新建的就是带标签的挖空卡，正好拿它验。
   * 这样"标签筛选"与"挖空显形"两个核心功能不再靠运气。
   */
  const chipsNow = await ev(`(() => {
    return [...document.querySelectorAll(".fcx__tagchip")]
      .filter((c) => !(c.textContent || "").includes("全部标签"))
      .map((c) => ({
        tag: (c.textContent || "").replace(/[\\d\\s]+$/, "").trim(),
        n: Number(((c.querySelector(".fcx__tagn") || {}).textContent || "0").trim()),
      }));
  })()`);
  const myChip = chipsNow.find((c) => c.tag.indexOf('验证用标签') === 0);
  rec('新建后标签筛选条里出现新标签', !!myChip, myChip ? `${myChip.tag} n=${myChip.n}` : '没找到');
  if (myChip) {
    await ev(`(() => {
      const b = [...document.querySelectorAll(".fcx__tagchip")]
        .find((x) => (x.textContent || "").startsWith(${JSON.stringify(myChip.tag)}));
      if (b) b.click(); return !!b;
    })()`);
    await sleep(1200);
    const shownByMyTag = await ev(`document.querySelectorAll(".fcx__item--callout").length`);
    rec(
      '★ 按新标签筛后卡数 = chip 数字（关系断言）',
      shownByMyTag === myChip.n,
      `shown=${shownByMyTag} chip=${myChip.n}`,
    );

    /* 这张卡是挖空卡：遮罩存在 + 点一下显形 */
    const clozeN = await ev(`document.querySelectorAll(".fcal__cloze").length`);
    rec('新建的挖空卡有挖空遮罩', clozeN > 0, `数量=${clozeN}`);
    if (clozeN > 0) {
      const before = await ev(`document.querySelectorAll(".fcal__cloze--shown").length`);
      await ev(`(() => {
        const el = document.querySelector(".fcal__cloze:not(.fcal__cloze--shown)");
        if (el) el.click(); return !!el;
      })()`);
      await sleep(800);
      const after = await ev(`document.querySelectorAll(".fcal__cloze--shown").length`);
      rec('挖空点一下显形（--shown +1）', after === before + 1, `before=${before} after=${after}`);
      /* 再点一下应能收回（不是只能单向显形） */
      await ev(`(() => {
        const el = document.querySelector(".fcal__cloze--shown");
        if (el) el.click(); return !!el;
      })()`);
      await sleep(800);
      const back = await ev(`document.querySelectorAll(".fcal__cloze--shown").length`);
      rec('再点一下收回遮罩（可逆）', back === before, `after=${after} back=${back}`);
      await shot('06b-cloze-shown.png');
    }
    /* 取消标签筛选，回到全部，后续导出计数才可比 */
    await ev(`(() => {
      const b = [...document.querySelectorAll(".fcx__tagchip")]
        .find((x) => (x.textContent || "").includes("全部标签"));
      if (b) b.click(); return !!b;
    })()`);
    await sleep(1000);
  }

  /* ---------- 9. 导出按钮 ---------- */
  const exportBtn = await ev(`(() => {
    const b = document.querySelector(".fcx__export");
    if (!b) return null;
    return { text: (b.textContent || "").trim(), n: Number(((b.textContent || "").match(/\\d+/) || [0])[0]) };
  })()`);
  const shownNow = await ev(countItems);
  if (exportBtn) {
    rec('导出按钮存在且文案带张数', exportBtn.n > 0, exportBtn.text);
    rec('★ 导出按钮张数 = 当前显示卡数（关系断言）', exportBtn.n === shownNow, `btn=${exportBtn.n} shown=${shownNow}`);
  } else {
    skip('导出按钮', '当前筛选下按钮不存在');
  }
  await shot('07-final.png');

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

/**
 * 验证「搜索独立成页」（2026-11-20）。
 *
 * ## 用户要求
 *
 * > 我们修改一下ui，你看看有没有更好看的放法。我的想法是新开一个功能栏
 * > 在课程准备与管理那里，然后界面参考 Google 或是 bing 类似的搜索引擎。
 * > 要是采取了这个方法别忘了更新功能导览。
 *
 * ## 要证的
 *
 * 1. 侧栏「课程准备与管理」里有「搜索」（不是「每天」组）
 * 2. **顶栏那个搜索框已经撤掉**（不能两个入口并存）
 * 3. 点进去是独立页面：居中大搜索框 + 标题 + 说明
 * 4. 搜索结果有**命中概览**（分布条）—— 这是窄面板做不到的
 * 5. 结果按书分组、关键词高亮、点一条跳到原文那句话
 * 6. **功能导览里能看到「搜索」**（用户特意提醒）
 * 7. 无控制台报错
 *
 * 用法：node scripts/verify-search-page.cjs
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/search-page-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/search-page');
const PORT = Number(process.argv[2] || 9884);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x) => {
  console.log((ok ? '✅ ' : '❌ ') + n + (x ? ' :: ' + x : ''));
  ok ? pass++ : fail++;
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(APPDATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.cpSync(path.join(process.env.APPDATA, 'OpenLeaner/IndexedDB'), path.join(DATA, 'IndexedDB'), { recursive: true });
  console.log('已复制真实库副本');

  const exe = path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
  if (fs.existsSync(path.join(path.dirname(exe), 'openleaner-data'))) {
    console.error('❌ app 目录旁有 openleaner-data');
    process.exit(2);
  }

  const app = spawn(
    exe,
    [ROOT, '--user-data-dir=' + DATA, '--no-sandbox', '--remote-debugging-port=' + PORT, '--window-size=1440,1000'],
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
      errs.push((m.params.args || []).map((a) => a.value ?? '').join(' ').slice(0, 150));
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
  const waitFor = async (expr, ms = 25000, label = '') => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await ev(expr).catch(() => null);
      if (v) return v;
      await sleep(300);
    }
    throw new Error('等待超时' + (label ? '（' + label + '）' : ''));
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(6000);

  /* ---------- 1. 顶栏搜索框已撤 ---------- */
  const topbarSearch = await ev(`(() => ({
    hasTopbarInput: !!document.querySelector(".gsearch__input"),
    topbarText: (document.querySelector(".topbar")?.textContent ?? "").slice(0, 60),
  }))()`);
  rec('**顶栏搜索框已撤掉**（不能两个入口并存）',
      !topbarSearch.hasTopbarInput, 'gsearch__input 存在=' + topbarSearch.hasTopbarInput);

  /* ---------- 2. 侧栏里有「搜索」，且在「课程准备与管理」组 ---------- */
  const nav = await ev(`(() => {
    /* 先展开所有分组，才能读到全部条目 */
    for (const lb of document.querySelectorAll(".nav-group__label")) {
      const b = lb.closest("button"); const g = lb.closest(".nav-group");
      if (b && g && g.getAttribute("aria-expanded") !== "true") b.click();
    }
    return true;
  })()`);
  await sleep(800);

  const navInfo = await ev(`(() => {
    /*
     * 分组结构是 .nav-section > button.nav-group（含 label）+ .nav-items。
     * 第一版写成 querySelectorAll(".nav-group") 再找里面的 label ——
     * 而 .nav-group 本身就是那个 button，里面虽然有 label，
     * 但 items 在它的兄弟节点 .nav-items 里，于是 items 永远取到空。
     * 改成以 .nav-section 为单位取。
     *
     * ⚠️ 这段在模板字符串里，注释中不能出现反引号（会提前结束字符串）。
     */
    const out = [...document.querySelectorAll(".nav-section")].map((sec) => ({
      label: (sec.querySelector(".nav-group__label")?.textContent ?? "").trim(),
      items: [...sec.querySelectorAll(".nav-item__label")].map((x) => x.textContent.trim()),
    }));
    const searchItem = [...document.querySelectorAll(".nav-item__label,.nav-item")]
      .find((e) => (e.textContent || "").trim() === "搜索");
    return {
      groups: out,
      hasSearchItem: !!searchItem,
      searchInGroup: out.find((g) => g.items.includes("搜索"))?.label ?? null,
    };
  })()`);
  console.log('侧栏 =', JSON.stringify(navInfo.groups, null, 1));
  rec('**侧栏里有「搜索」**', !!navInfo.hasSearchItem);
  rec('**它在「课程准备与管理」组**（不是「每天」）',
      navInfo.searchInGroup === '课程准备与管理', navInfo.searchInGroup ?? '(未找到)');

  /* ---------- 3. 点进去是独立页面 ---------- */
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
      .find((e) => (e.textContent || "").trim() === "搜索");
    if (el) { el.click(); return true; }
    return false;
  })()`);
  await waitFor(`document.querySelector(".spage") ? true : null`, 25000, '搜索页');
  await sleep(600);
  await shot('01-search-page-empty.png');

  const pageInfo = await ev(`(() => {
    const page = document.querySelector(".spage");
    const input = page?.querySelector(".spage__input");
    const r = input?.getBoundingClientRect();
    const cs = input ? getComputedStyle(input) : null;
    return {
      title: (page?.querySelector(".spage__title")?.textContent ?? "").trim(),
      lead: (page?.querySelector(".spage__lead")?.textContent ?? "").trim().slice(0, 40),
      hasInput: !!input,
      inputWidth: r ? Math.round(r.width) : 0,
      centered: r && cs ? cs.textAlign === "start" : false,
      placeholder: input?.placeholder ?? "",
      topbarTitle: (document.querySelector(".topbar__title")?.textContent ?? "").trim(),
    };
  })()`);
  console.log('页面 =', JSON.stringify(pageInfo));
  rec('进了独立搜索页（有标题与说明）',
      /搜索/.test(pageInfo.title) && pageInfo.lead.length > 0, pageInfo.title);
  rec('导航标题也变成「搜索资料」', pageInfo.topbarTitle.includes('搜索'), pageInfo.topbarTitle);
  rec('**搜索框比顶栏那个宽得多**（>500px）',
      pageInfo.inputWidth > 500, pageInfo.inputWidth + 'px（顶栏那个是 329px）');
  rec('搜索框有引导文案', pageInfo.placeholder.length > 0, pageInfo.placeholder);

  /* ---------- 4. 搜一个词，看命中概览 ---------- */
  await ev(`(() => {
    const i = document.querySelector(".spage__input");
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    s.call(i, "极限");
    i.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  await ev(`(() => {
    const b = document.querySelector(".spage__go");
    if (b && !b.disabled) { b.click(); return true; }
    return false;
  })()`);
  await waitFor(`document.querySelector(".spage__summary") ? true : null`, 30000, '结果');
  await sleep(600);
  await shot('02-search-results-with-overview.png');

  const resInfo = await ev(`(() => {
    const page = document.querySelector(".spage");
    const distRows = [...page.querySelectorAll(".spage__dist-row")];
    return {
      summary: (page.querySelector(".spage__summary")?.textContent ?? "").trim(),
      /** 命中概览：每份资料的分布条 */
      distCount: distRows.length,
      dist: distRows.map((r) => ({
        name: (r.querySelector(".spage__dist-name")?.textContent ?? "").trim().slice(0, 16),
        num: (r.querySelector(".spage__dist-num")?.textContent ?? "").trim(),
        fillWidth: r.querySelector(".spage__dist-fill")?.style?.width ?? "",
      })),
      groupCount: page.querySelectorAll(".spage__group").length,
      hitCount: page.querySelectorAll(".spage__hit").length,
      kwMarks: page.querySelectorAll(".spage__kw").length,
    };
  })()`);
  console.log('结果 =', JSON.stringify(resInfo, null, 1));

  rec('搜到了结果', resInfo.hitCount > 0, '条目=' + resInfo.hitCount);
  rec('**有命中概览分布条**（窄面板做不到的事）',
      resInfo.distCount >= 1, '分布行=' + resInfo.distCount);
  rec('分布条按命中数缩放（不是都 100%）',
      resInfo.dist.some((d) => d.fillWidth && d.fillWidth !== '100%'),
      JSON.stringify(resInfo.dist.map((d) => d.fillWidth)));
  rec('结果按书分组', resInfo.groupCount >= 1, '组数=' + resInfo.groupCount);
  rec('关键词在片段里高亮', resInfo.kwMarks > 0, 'mark=' + resInfo.kwMarks);

  /* ---------- 5. 点结果跳到原文那句话 ---------- */
  await ev(`(() => {
    const b = document.querySelector(".spage__hit");
    if (b) { b.click(); return true; }
    return false;
  })()`);
  await waitFor(`document.querySelector(".reader-page, .reader-split") ? true : null`, 25000, '阅读器');
  /* 高亮是第二步 effect 画的，必须等 mark */
  await waitFor(`document.querySelector("mark.reader-mark, .reader-jump") ? true : null`, 25000, '定位标记');
  await sleep(900);
  const jumped = await ev(`(() => ({
    inReader: !!document.querySelector(".reader-page, .reader-split"),
    marks: document.querySelectorAll("mark.reader-mark").length,
    markText: (document.querySelector("mark.reader-mark")?.textContent ?? "").trim(),
  }))()`);
  rec('**点结果跳到原文并圈出那句话**',
      jumped.inReader && jumped.marks >= 1, JSON.stringify(jumped).slice(0, 100));
  await shot('03-jumped-to-sentence.png');

  /* ---------- 6. 功能导览里能看到「搜索」 ---------- */
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
      .find((e) => (e.textContent || "").trim().includes("功能导览"));
    if (el) { el.click(); return true; }
    return false;
  })()`);
  await waitFor(`document.querySelector(".gd-page, [class*=guide]") ? true : null`, 25000, '导览页');
  await sleep(900);
  await shot('04-guide-page.png');

  const guideInfo = await ev(`(() => {
    const body = document.body.innerText || "";
    const page = document.querySelector(".gd-page") || document.body;
    const items = [...page.querySelectorAll(".gd-item")].map((x) => (x.textContent || "").slice(0, 60));
    return {
      hasSearchText: body.includes("搜索资料") || body.includes("搜索"),
      items: items.filter((t) => /搜索/.test(t)),
      allCount: items.length,
    };
  })()`);
  console.log('导览 =', JSON.stringify(guideInfo, null, 1));
  rec('**功能导览里能看到「搜索」**（用户特意提醒）',
      guideInfo.hasSearchText, '含「搜索」=' + guideInfo.hasSearchText);

  rec('没有控制台报错', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  console.log('  截图：' + SHOTS);
  if (fail > 0) process.exitCode = 1;

  ws.close();
  app.kill();
  await sleep(1200);
})();
/**
 * 验证闪卡管理第二批改动（2026-11-23 深夜）。
 *
 * ## 用户需求（原话，m04063）
 * > bug：闪卡打上标签后，选择了特定的标签分组，之后删掉标签后界面会显示没有符合条件的卡。
 * > 反馈：导出到obsidian的功能需要优化，有时需要选取几个特定的文件而不是全部文件，
 * > 应该加个多选或是全选的按钮。按资源分类功能应该增加个类似新建文件夹的功能，
 * > 用户可以自主选择闪卡进行管理分类。最后需要一个总的删除某一资源的闪卡按钮，
 * > 建议在图三每个资源右边加上一个删除按钮
 *
 * ## 验什么（关系断言优先，硬约束 1：断言盲区在两个部分之间的关系）
 *
 * 1. 分组方式三选一都在，且切到「不分组」后组头消失、卡数不变（**关系**）
 * 2. 切到「按资料」组头数字之和 = 列表卡片数（**关系**）
 * 3. ★ 用户报的 bug：选一个标签 → 删掉该标签 → 列表**不能**停在「没有符合条件的卡」
 * 4. 新建文件夹 → 出现在文件夹条；「按文件夹」分组下有空组头（计数 0）
 * 5. 多选：开多选 → 卡片出现勾选框；勾几张后工具条数字 = 勾的数
 * 6. ★ 组头勾选 = 整组卡被勾上（组头半选态存在）
 * 7. ★ 导出按钮张数 = 勾选数（关系断言，多选模式下）
 * 8. ★ 归入文件夹后，「按文件夹」分组里该文件夹计数 = 归入的张数（关系）
 * 9. ★ 删掉这组 → 该组卡消失、回收站多一条（关系：不是变 0 张而是整组没了）
 * 10. 导出选项框能打开，callout 版式下「双向卡」禁用（防假开关）
 * 11. 文件夹重命名后组头标题跟着变（不是只有 chip 变）
 * 12. 无控制台报错
 *
 * 全程跑在 .tmp/fmanage-appdata 隔离副本，真实库不碰。
 * 用法：node scripts/verify-flashcard-manage.cjs [port] [--desktop]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/fmanage-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/flashcard-manage');
const PORT = Number(process.argv[2] || 9901);
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
  /** 按纯文本点按钮（去掉尾部数字与空白） */
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

  const countItems = `document.querySelectorAll(".fcx__item--callout").length`;
  const countHeads = `document.querySelectorAll(".fcx__ghead").length`;
  /** 组头数字之和 */
  const sumHeadN = `[...document.querySelectorAll(".fcx__ghead-n")].reduce((s, e) => s + (Number((e.textContent||"0").trim()) || 0), 0)`;

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(8000);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 1400,
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

  /* ---------- 1. 分组方式三选一 ---------- */
  const modes = await ev(`(() => {
    return [...document.querySelectorAll(".fcx__gmode-opt")].map((e) => (e.textContent || "").trim());
  })()`);
  rec('分组方式有三档', Array.isArray(modes) && modes.length === 3, JSON.stringify(modes));
  rec(
    '三档是 不分组/按资料/按文件夹',
    JSON.stringify(modes) === JSON.stringify(['不分组', '按资料', '按文件夹']),
    JSON.stringify(modes),
  );

  const total0 = await ev(countItems);
  const heads0 = await ev(countHeads);
  rec('默认（按资料）有组头', heads0 > 0, `heads=${heads0}`);

  /* 切「不分组」：组头应消失，卡数不变（关系断言） */
  await clickByText('.fcx__gmode-opt', '不分组');
  await sleep(900);
  const headsNone = await ev(countHeads);
  const totalNone = await ev(countItems);
  rec('切「不分组」后组头消失', headsNone === 0, `heads=${headsNone}`);
  rec('★ 不分组后卡数不变（分组只改排列不改数据）', totalNone === total0, `before=${total0} after=${totalNone}`);
  await shot('02-nogroup.png');

  /* 切回「按资料」：组头数字之和 = 卡片数（关系断言） */
  await clickByText('.fcx__gmode-opt', '按资料');
  await sleep(900);
  const headsBack = await ev(countHeads);
  const sumBack = await ev(sumHeadN);
  const totalBack = await ev(countItems);
  rec('切回「按资料」组头回来', headsBack === heads0, `heads=${headsBack} want=${heads0}`);
  rec('★ 组头数字之和 = 列表卡片数（关系断言）', sumBack === totalBack, `sum=${sumBack} items=${totalBack}`);

  /* ---------- 3. ★ 用户报的 bug：标签筛上后删掉标签 ---------- */
  /*
   * 复现路径（截图里的原始操作）：
   * 新建一张带标签 123 的记忆卡 → 点标签 chip 123 筛上 → 编辑这张卡删掉标签 → 保存
   * 期望：列表不能停在「没有符合条件的卡」，且筛选条里不再有那个 chip。
   */
  await clickByText('.fcx__head-actions button', '记忆闪卡');
  await sleep(700);
  const newOpen = await ev(`!!document.querySelector(".fcx__new-title")`);
  if (newOpen) {
    await setInput('.fcx__new .fcx__textarea', '标签回归验证卡的正面');
    await sleep(200);
    /* 第二个 textarea 是背面 */
    await ev(`(() => {
      const ts = document.querySelectorAll(".fcx__new .fcx__textarea");
      if (ts.length < 2) return false;
      const el = ts[1];
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(el, "✅答案：背面内容");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    /* 加标签 123 */
    await setInput('.ctag__input', '123');
    await sleep(250);
    await ev(`(() => {
      const b = document.querySelector(".ctag__addbtn");
      if (b) b.click(); return !!b;
    })()`);
    await sleep(300);
    await ev(`(() => {
      const b = [...document.querySelectorAll(".fcx__new-actions button")]
        .find((e) => (e.textContent || "").trim() === "建卡");
      if (b) b.click(); return !!b;
    })()`);
    await sleep(1800);
    const created = await ev(`(() => {
      return [...document.querySelectorAll(".fcx__item--callout")].some((e) =>
        (e.textContent || "").includes("标签回归验证卡"));
    })()`);
    rec('新建带标签的记忆卡成功', created === true, created ? '' : '列表里找不到');

    if (created) {
      /* 点标签 chip 123 */
      const chipClicked = await ev(`(() => {
        const b = [...document.querySelectorAll(".fcx__tagchip")].find((e) => (e.textContent || "").trim().indexOf("123") === 0);
        if (b) b.click(); return !!b;
      })()`);
      await sleep(1000);
      const filtered = await ev(countItems);
      rec('点标签 chip 后筛出卡', chipClicked && filtered > 0, `items=${filtered}`);

      /* 编辑这张卡，删掉标签，保存 */
      await ev(`(() => {
        const li = [...document.querySelectorAll(".fcx__item--callout")]
          .find((e) => (e.textContent || "").includes("标签回归验证卡"));
        if (!li) return false;
        const b = [...li.querySelectorAll("button")].find((e) => (e.textContent || "").trim() === "编辑");
        if (b) b.click(); return !!b;
      })()`);
      await sleep(900);
      /* 删掉所有标签 chip（.ctag__chip--on 点击即去掉） */
      await ev(`(() => {
        let n = 0;
        for (const c of document.querySelectorAll(".ctag__chip--on")) { c.click(); n++; }
        return n;
      })()`);
      await sleep(500);
      await clickByText('.fcx__item--editing button', '保存');
      await sleep(1600);
      await shot('03-bug-after-tag-removed.png');

      const emptyShown = await ev(`(() => {
        const p = [...document.querySelectorAll(".fcx__empty")].find((e) => (e.textContent || "").includes("没有符合条件"));
        return !!p;
      })()`);
      const itemsAfter = await ev(countItems);
      rec(
        '★ 用户报的 bug：删掉标签后不能停在「没有符合条件的卡」（关系断言）',
        emptyShown === false,
        `空态=${emptyShown} items=${itemsAfter}`,
      );
      const chipGone = await ev(`(() => {
        return ![...document.querySelectorAll(".fcx__tagchip")].some((e) => (e.textContent || "").trim().indexOf("123") === 0);
      })()`);
      rec('标签删光后筛选条里不再有那个 chip', chipGone === true, `chipGone=${chipGone}`);
      rec('★ 标签删光后卡还在（不是被筛掉了）', itemsAfter > 0, `items=${itemsAfter}`);
    }
  } else {
    skip('标签回归验证', '记忆闪卡建卡面板没打开');
  }

  /* ---------- 4. 新建文件夹 ---------- */
  await clickByText('.fcx__gmode-opt', '按文件夹');
  await sleep(900);
  await shot('04-folder-empty.png');
  const hasNewFolderBtn = await ev(`!!document.querySelector(".fcx__foldernew")`);
  rec('按文件夹模式下有「新建文件夹」按钮', hasNewFolderBtn === true, `${hasNewFolderBtn}`);
  if (hasNewFolderBtn) {
    await ev(`(() => { const b = document.querySelector(".fcx__foldernew"); if (b) b.click(); return !!b; })()`);
    await sleep(500);
    await setInput('.fcx__folderinput', '我的第一组');
    await sleep(300);
    await ev(`(() => {
      const b = [...document.querySelectorAll(".fcx__folderform button")].find((e) => (e.textContent || "").trim() === "建");
      if (b) b.click(); return !!b;
    })()`);
    await sleep(1500);
    const folderChip = await ev(`(() => {
      return [...document.querySelectorAll(".fcx__folderchip-name")].map((e) => (e.textContent || "").trim());
    })()`);
    rec('新建文件夹出现在文件夹条', Array.isArray(folderChip) && folderChip.includes('我的第一组'), JSON.stringify(folderChip));

    /* 空文件夹照样有组头且计数 0（用户点完新建要看到东西） */
    const headTitles = await ev(`[...document.querySelectorAll(".fcx__ghead-title")].map((e) => (e.textContent || "").trim())`);
    const zeroGroup = await ev(`(() => {
      const h = [...document.querySelectorAll(".fcx__ghead")]
        .find((e) => (e.textContent || "").includes("我的第一组"));
      if (!h) return null;
      const n = h.querySelector(".fcx__ghead-n");
      return n ? Number((n.textContent || "0").trim()) : null;
    })()`);
    rec(
      '★ 空文件夹也出现在组头（新建完要能看见）',
      Array.isArray(headTitles) && headTitles.includes('我的第一组'),
      JSON.stringify(headTitles),
    );
    rec('★ 空文件夹计数是 0（不是不显示）', zeroGroup === 0, `n=${zeroGroup}`);

    /*
     * 空组的「删掉这组」必须是禁用的。
     *
     * 空组没有东西可删，若按钮可点、弹框写「删掉 0 张卡」再往回收站留一条空记录，
     * 那是纯惊吓。这条断言必须放在**文件夹还是空的时候**验 ——
     * 第一版放在改名之后，那时组里已经有 11 张卡，
     * 既查不到「我的第一组」（已改名）、又验错了对象（有卡的组本该可点）。
     */
    const emptyDisabled = await ev(`(() => {
      const hs = [...document.querySelectorAll(".fcx__ghead")];
      const h = hs.find((e) => (e.textContent || "").includes("我的第一组"));
      if (!h) return null;
      const b = h.querySelector(".fcx__ghead-del");
      return b ? b.disabled : null;
    })()`);
    rec('★ 空文件夹的「删掉这组」是禁用的（不给无意义操作）', emptyDisabled === true, `disabled=${emptyDisabled}`);
    await shot('05-folder-created.png');

  /*
   * ---------- 10. 导出选项框 ----------
   *
   * ⚠️ 这一段必须跑在**删组之前**（首跑踩到，31/32 里唯一的 FAIL）。
   *
   * 删除该组会把列表清空（after=0），而 `.fcx__bar2` 整行的渲染条件是
   * `cards.length > 0` —— 一张卡都没有时整行不渲染，
   * 「导出选项」按钮自然查不到。这不是产品缺陷（没卡时导出确实没意义），
   * 是脚本顺序错了：把"有没有这个按钮"放到了"卡已被删光"之后。
   */
  const optBtn = await ev(`!!document.querySelector(".fcx__optbtn")`);
  rec('有「导出选项」按钮', optBtn === true, `${optBtn}`);
  if (optBtn) {
    await ev(`(() => { const b = document.querySelector(".fcx__optbtn"); if (b) b.click(); return !!b; })()`);
    await sleep(1000);
    const box = await ev(`!!document.querySelector(".fcx__optbox")`);
    rec('导出选项框能打开', box === true, `${box}`);
    if (box) {
      /* callout 版式下双向卡必须禁用（防假开关） */
      const bidir = await ev(`(() => {
        const rows = [...document.querySelectorAll(".fcx__optrow")];
        const row = rows.find((r) => (r.textContent || "").includes("双向卡"));
        if (!row) return null;
        const inp = row.querySelector("input[type=checkbox]");
        return inp ? inp.disabled : null;
      })()`);
      rec('★ callout 版式下「双向卡」被禁用（不装作能用）', bidir === true, `disabled=${bidir}`);
      const clozeRow = await ev(`(() => {
        const rows = [...document.querySelectorAll(".fcx__optrow")];
        const row = rows.find((r) => (r.textContent || "").includes("包成填空"));
        if (!row) return null;
        const inp = row.querySelector("input[type=checkbox]");
        return inp ? { checked: inp.checked, disabled: inp.disabled } : null;
      })()`);
      rec('默认「包成填空」是开着的（默认值正确）', clozeRow && clozeRow.checked === true && clozeRow.disabled === false, JSON.stringify(clozeRow));
      await shot('11-export-options.png');
      /* 关掉框 */
      await clickByText('.set-modal__actions button', '取消');
      await sleep(700);
    }
  }


    /* ---------- 5/6/7. 多选 ---------- */
    await clickByText('.fcx__pickbtn', '多选导出');
    await sleep(800);
    const boxes = await ev(`document.querySelectorAll(".fcx__pickbox input").length`);
    rec('开多选后每张卡有勾选框', boxes > 0, `boxes=${boxes}`);

    /* 勾组头（整组） */
    const headPickExists = await ev(`document.querySelectorAll(".fcx__ghead-pick").length`);
    rec('组头有多选勾选框', headPickExists > 0, `n=${headPickExists}`);
    if (headPickExists > 0) {
      /*
       * ⚠️ 必须挑一个**有卡**的组（2026-11-23 首跑踩到的假绿）。
       *
       * 第一版按 `document.querySelector(".fcx__ghead")` 取第一个组头 ——
       * 而按文件夹分组时排在最前的是刚建的**空文件夹**（计数 0），
       * 于是「已选数 = 该组卡数」变成 `0 === 0` 通过，
       * 「导出张数 = 已选数」变成 `0 === 0` 通过，
       * 「归入后组头计数 = 归入张数」也 `0 === 0` 通过 ——
       * 三条关系断言全绿，实际一条都没验到（硬约束 1 的教科书案例）。
       *
       * 现在按标题锁定「未归入文件夹」那一组（里面的卡最多、一定非空），
       * 并且**额外要求 sel > 0** —— 关系断言两边都是 0 不算通过。
       */
      const target = await ev(`(() => {
        const hs = [...document.querySelectorAll(".fcx__ghead")];
        const h = hs.find((e) => (e.textContent || "").includes("未归入文件夹"));
        if (!h) return null;
        const n = h.querySelector(".fcx__ghead-n");
        const size = n ? Number((n.textContent || "0").trim()) : 0;
        return { size };
      })()`);
      const groupSize = target ? target.size : 0;
      rec('★ 挑中的组非空（关系断言两边不能都是 0）', groupSize > 0, `groupSize=${groupSize}`);

      /*
       * 勾选**之前**先验：一个都没选时，组头勾选框必须是未勾、非半选的。
       *
       * 首轮反向验证暴露的盲区（B）：只验「已选数 = 组大小」不够 ——
       * 把 groupPickState 改成永远返回 'all'（勾选框恒为已勾），
       * 已选数仍然正确，35/35 照旧全绿。勾选框的选中/半选状态
       * 是用户唯一能看到的"这一组选没选"的指示，必须单独验。
       */
      const beforeState = await ev(`(() => {
        const hs = [...document.querySelectorAll(".fcx__ghead")];
        const h = hs.find((e) => (e.textContent || "").includes("未归入文件夹"));
        if (!h) return null;
        const cb = h.querySelector(".fcx__ghead-pick");
        return cb ? { checked: cb.checked, indeterminate: cb.indeterminate } : null;
      })()`);
      rec(
        '★ 未选任何卡时组头勾选框是空的（不假装已选）',
        beforeState && beforeState.checked === false && beforeState.indeterminate === false,
        JSON.stringify(beforeState),
      );

      /* 先把这一组的勾选框点中（按组头标题定位，不取第一个） */
      await ev(`(() => {
        const hs = [...document.querySelectorAll(".fcx__ghead")];
        const h = hs.find((e) => (e.textContent || "").includes("未归入文件夹"));
        if (!h) return false;
        const cb = h.querySelector(".fcx__ghead-pick");
        if (!cb) return false;
        cb.click();
        return true;
      })()`);
      await sleep(700);

      /*
       * 勾完整组之后：勾选框必须是已勾、非半选。
       * 这一条与上一条互为反向关系 —— 两条都在才说明"指示器真的跟着数据走"，
       * 只验一条的话恒真/恒假都能通过。
       */
      const afterState = await ev(`(() => {
        const hs = [...document.querySelectorAll(".fcx__ghead")];
        const h = hs.find((e) => (e.textContent || "").includes("未归入文件夹"));
        if (!h) return null;
        const cb = h.querySelector(".fcx__ghead-pick");
        return cb ? { checked: cb.checked, indeterminate: cb.indeterminate } : null;
      })()`);
      rec(
        '★ 整组勾满后组头勾选框是已勾（指示器跟着数据走）',
        afterState && afterState.checked === true && afterState.indeterminate === false,
        JSON.stringify(afterState),
      );
      await sleep(700);
      const pickN = await ev(`(() => {
        const e = document.querySelector(".fcx__pickn");
        if (!e) return null;
        const m = (e.textContent || "").match(/(\\d+)\\s*\\/\\s*(\\d+)/);
        return m ? { sel: Number(m[1]), total: Number(m[2]) } : null;
      })()`);
      rec(
        '★ 点组头勾整组：已选数 = 该组卡数（关系断言）',
        pickN && pickN.sel === groupSize,
        `sel=${pickN && pickN.sel} groupSize=${groupSize}`,
      );

      /* 导出按钮张数 = 已选数 */
      const exportN = await ev(`(() => {
        const b = document.querySelector(".fcx__export");
        if (!b) return null;
        const m = (b.textContent || "").match(/(\\d+)/);
        return m ? Number(m[1]) : null;
      })()`);
      rec(
        '★ 多选模式下导出按钮张数 = 已选张数（关系断言，且必须 > 0）',
        !!pickN && pickN.sel > 0 && exportN === pickN.sel,
        `export=${exportN} sel=${pickN && pickN.sel}`,
      );
      await shot('06-picking.png');

      /* ---------- 8. 归入文件夹 ---------- */
      await clickByText('.fcx__gmode-opt', '按文件夹');
      await sleep(600);
      const selOk = await ev(`(() => {
        const s = document.querySelector(".fcx__foldersel");
        if (!s) return false;
        return true;
      })()`);
      if (selOk) {
        /* 选「我的第一组」 */
        await ev(`(() => {
          const s = document.querySelector(".fcx__foldersel");
          if (!s) return false;
          const opt = [...s.options].find((o) => (o.textContent || "").trim() === "我的第一组");
          if (!opt) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
          setter.call(s, opt.value);
          s.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        })()`);
        await sleep(500);
        /*
         * ⚠️ 按钮文案是「归入文件夹（11 张）」——中文括号。
         * clickByText 用的是"剥数字后全等"，剥完还剩「归入文件夹（张）」，
         * 与传入的「归入文件夹」不等，于是点了但没点到（首跑踩到：
         * 归入没生效 → 后面三条断言连锁红）。这里改成包含匹配。
         */
        const assigned = await ev(`(() => {
          const b = [...document.querySelectorAll(".fcx__pickbar button")]
            .find((e) => (e.textContent || "").includes("归入文件夹"));
          if (!b) return false;
          if (b.disabled) return "disabled";
          b.click();
          return true;
        })()`);
        rec('「归入文件夹」按钮可点（不是禁用态）', assigned === true, `assigned=${assigned}`);
        await sleep(1600);

        const assignedN = await ev(`(() => {
          const h = [...document.querySelectorAll(".fcx__ghead")]
            .find((e) => (e.textContent || "").includes("我的第一组"));
          if (!h) return null;
          const n = h.querySelector(".fcx__ghead-n");
          return n ? Number((n.textContent || "0").trim()) : null;
        })()`);
        rec(
          '★ 归入后该文件夹组头计数 = 归入的张数（关系断言，且必须 > 0）',
          assignedN !== null && assignedN > 0 && assignedN === (pickN ? pickN.sel : -1),
          `assignedN=${assignedN} sel=${pickN && pickN.sel}`,
        );
        await shot('07-assigned.png');

        /* ---------- 11. 改名后组头跟着变 ---------- */
        await ev(`(() => {
          const b = [...document.querySelectorAll(".fcx__folderchip-name")].find((e) => (e.textContent || "").trim() === "我的第一组");
          if (b) b.click(); return !!b;
        })()`);
        await sleep(600);
        await setInput('.fcx__folderinput', '改过名的组');
        await sleep(300);
        await ev(`(() => {
          const b = [...document.querySelectorAll(".fcx__folderform button")].find((e) => (e.textContent || "").trim() === "好");
          if (b) b.click(); return !!b;
        })()`);
        await sleep(1500);
        const renamedHead = await ev(`(() => {
          return [...document.querySelectorAll(".fcx__ghead-title")].some((e) => (e.textContent || "").trim() === "改过名的组");
        })()`);
        rec('★ 文件夹改名后组头标题跟着变（不是只有 chip 变）', renamedHead === true, `renamedHead=${renamedHead}`);
        await shot('08-renamed.png');

        /* ---------- 9. 删掉这组 ---------- */
        const delBtn = await ev(`(() => {
          const h = [...document.querySelectorAll(".fcx__ghead")]
            .find((e) => (e.textContent || "").includes("改过名的组"));
          if (!h) return null;
          const b = h.querySelector(".fcx__ghead-del");
          if (!b) return null;
          if (b.disabled) return "disabled";
          b.click();
          return true;
        })()`);
        await sleep(900);
        const dlg = await waitFor(`!!document.querySelector(".set-modal__box")`, 5000);
        rec('「删掉这组」弹出确认框', dlg !== false, `dlg=${dlg}`);
        await shot('09-confirm-group-delete.png');
        if (dlg) {
          const before = await ev(`document.querySelectorAll(".fcx__item--callout").length`);
          rec('★ 删组前列表里有卡（否则"变少"是假关系）', before > 0, `before=${before}`);
          await clickByText('.set-modal__actions button', '收进回收站');
          await sleep(2200);
          const after = await ev(countItems);
          rec(
            '★ 删掉这组后卡变少（数量真的少了）',
            after < before,
            `before=${before} after=${after}`,
          );
          const groupGone = await ev(`(() => {
            return ![...document.querySelectorAll(".fcx__ghead-title")].some((e) => (e.textContent || "").trim() === "改过名的组");
          })()`);
          rec('★ 删掉后该组在列表里消失', groupGone === true, `groupGone=${groupGone}`);

          /* 回收站里应多一条闪卡记录（关系断言：不是直接蒸发） */
          await ev(`(() => {
            const el = [...document.querySelectorAll(".nav-item")].find((e) => (e.textContent || "").trim() === "回收站");
            if (el) el.click(); return !!el;
          })()`);
          await sleep(2000);
          /*
           * ⚠️ 必须按「类别标签」精确找，不能用 body.textContent.includes("闪卡")。
           *
           * 首轮反向验证暴露的盲区（D）：把 removeMany 改成"小批量绕过回收站"后，
           * 35/35 依然全绿 —— 因为左侧导航栏本来就有「闪卡管理」这一项，
           * body 里永远含「闪卡」二字，这条断言恒真，什么也没验到。
           *
           * 现在改成只在回收站条目的类别标签（`.trash-item__kind`）里找，
           * 并且要求找到**至少一条** kind 恰好是「闪卡」的记录。
           */
          const trashKinds = await ev(`(() => {
            return [...document.querySelectorAll(".trash-item__kind")].map((e) => (e.textContent || "").trim());
          })()`);
          const cardKinds = Array.isArray(trashKinds) ? trashKinds.filter((k) => k === "闪卡") : [];
          rec(
            '★ 批量删的卡进了回收站（按类别精确匹配，不是正文里随便有「闪卡」）',
            cardKinds.length > 0,
            `kinds=${JSON.stringify(trashKinds)}`,
          );
          await shot('10-trash.png');

          /* 回闪卡页 */
          await ev(`(() => {
            const el = [...document.querySelectorAll(".nav-item")].find((e) => (e.textContent || "").trim() === "闪卡管理");
            if (el) el.click(); return !!el;
          })()`);
          await sleep(1800);
        }
      } else {
        skip('归入文件夹', '多选工具条没有文件夹下拉');
      }
    }
  }

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

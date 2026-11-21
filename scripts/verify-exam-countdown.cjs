/**
 * 验证「考期」功能（2026-11-21）。
 *
 * ## 用户要求
 *
 * > 考期这个概念可以和已有的待办功能融合
 * > 学习库页面不是有插件功能吗？可以放在待办那，后续可以通过小组件放在学习库首页
 *
 * ## 要证的（每条都要能在截图里看见）
 *
 * 1. 待办页添加区有「这是考试」勾选
 * 2. 勾了但没填截止日 → 当场提示「要填截止日才有倒计时」，**不阻止添加**
 * 3. 加一条带日期的考试 → 列表里出现「距 N 天」徽标
 * 4. 今天到期的考期 → 徽标写「今天」，不是「距 0 天」
 * 5. 过期的考期 → 徽标写「已过期」
 * 6. 普通待办**没有**徽标（不能每条待办都挂倒计时）
 * 7. 概览区出现「N 天后考『…』」，且取的是**最近**那一场
 * 8. 已有待办能被标成考试（「考」按钮）—— 不只是新增时能勾
 * 9. 首页「今日学习」小组件出现倒计时行
 * 10. 没有未来考期时，首页那一行**整行不渲染**（不摆假行）
 * 11. 控制台无报错
 * 12. **真实库没被动过**（前后哈希一致）
 *
 * ## 隔离
 *
 * - `APPDATA` 指 `.tmp/exam-todo-appdata`
 * - `--user-data-dir` 指同一个副本下的 `OpenLeaner`
 * - 启动前显式检查 app 目录旁**没有** `openleaner-data`
 *   （`electron/main.cjs` 的 `ensureUserDataDir()` 第 3 候选会抢先）
 * - 真实库（`%APPDATA%\OpenLeaner\IndexedDB`）跑前跑后各算一次哈希，不一致就报警
 *
 * 用法：node scripts/verify-exam-countdown.cjs [port]
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/exam-todo-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/exam-todo');
const PORT = Number(process.argv[2] || 9911);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x) => {
  console.log((ok ? '✅ ' : '❌ ') + n + (x ? ' :: ' + x : ''));
  ok ? pass++ : fail++;
};

/** 给一个目录算内容哈希（不存在返回 'missing'） */
function dirHash(dir) {
  if (!fs.existsSync(dir)) return 'missing';
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        h.update(path.relative(dir, p));
        const st = fs.statSync(p);
        h.update(String(st.size));
        /* 只读文件内容会让 12MB 的库跑很久；大小 + mtime 足够判「有没有被写」 */
        h.update(String(st.mtimeMs));
      }
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 16);
}

/** 本地日期串（与 srs.ts 的 todayLocal 同口径：本地字段，不是 UTC） */
function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const REAL_DB = path.join(process.env.APPDATA || '', 'OpenLeaner', 'IndexedDB');

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });

  /* ---------- 0. 先把真实库的指纹记下来 ---------- */
  const realBefore = dirHash(REAL_DB);
  console.log('真实库指纹（跑前）= ' + realBefore);

  /* ---------- 1. 造隔离副本 ---------- */
  fs.rmSync(APPDATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  if (!fs.existsSync(REAL_DB)) {
    console.error('❌ 找不到真实库 ' + REAL_DB + '，无法复制副本');
    process.exit(2);
  }
  fs.cpSync(REAL_DB, path.join(DATA, 'IndexedDB'), { recursive: true });
  console.log('已复制真实库副本 → ' + path.join(DATA, 'IndexedDB'));

  const exe = path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
  if (!fs.existsSync(exe)) {
    console.error('❌ 找不到 ' + exe);
    process.exit(2);
  }
  /*
   * `ensureUserDataDir()` 的第 3 候选是 exe 旁边的 `openleaner-data`。
   * 它一旦存在就可能抢在 `--user-data-dir` 前面生效 —— 那我们就可能在
   * 不知情的情况下写到另一个库。显式检查并退出。
   */
  if (fs.existsSync(path.join(path.dirname(exe), 'openleaner-data'))) {
    console.error('❌ app 目录旁存在 openleaner-data，--user-data-dir 可能不生效，终止');
    process.exit(2);
  }
  console.log('✅ app 目录旁没有 openleaner-data');

  /* 副本里不该有「用户指定库位置」的偏好文件，否则它会盖掉 --user-data-dir */
  const locFile = path.join(DATA, 'library-location.json');
  if (fs.existsSync(locFile)) fs.rmSync(locFile);

  const app = spawn(
    exe,
    [ROOT, '--user-data-dir=' + DATA, '--no-sandbox', '--remote-debugging-port=' + PORT, '--window-size=1440,1050'],
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
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  if (!target) {
    console.error('起不来：' + log.slice(-1500));
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
    if (m.method === 'Runtime.consoleAPICalled' && m.params && m.params.type === 'error') {
      errs.push((m.params.args || []).map((a) => a.value ?? '').join(' ').slice(0, 180));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params && m.params.exceptionDetails;
      errs.push('EXCEPTION: ' + String(d && (d.text || '')).slice(0, 180));
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
          rej(new Error('CDP timeout: ' + me));
        }
      }, 60000);
    });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };
  /** 全页截图（界面比 1000px 高时要看到下面） */
  const shot = async (name) => {
    let clip;
    try {
      const m = await send('Page.getLayoutMetrics');
      const cs = m.cssContentSize || m.contentSize;
      if (cs && cs.height > 0) {
        clip = { x: 0, y: 0, width: Math.ceil(cs.width), height: Math.ceil(Math.min(cs.height, 4000)), scale: 1 };
      }
    } catch {
      /* 拿不到就按视口截 */
    }
    const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip, captureBeyondViewport: true } : { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
    console.log('   📸 ' + path.join('.verify-shots/exam-todo', name));
  };
  const waitFor = async (expr, ms = 20000, label = '') => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await ev(expr).catch(() => null);
      if (v) return v;
      await sleep(300);
    }
    throw new Error('等待超时' + (label ? '（' + label + '）' : ''));
  };
  const clickNav = async (label) => {
    const ok = await ev(`(() => {
      const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
        .find((e) => (e.textContent || "").trim() === ${JSON.stringify(label)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    await sleep(1200);
    return ok;
  };
  /** 读 todos 全量（含 isExam 字段，用来证「真的落库了」） */
  const readTodos = () =>
    ev(`(async () => {
      const d = await new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      if (!d.objectStoreNames.contains('todos')) return [];
      return await new Promise((res, rej) => {
        const tx = d.transaction('todos', 'readonly');
        const q = tx.objectStore('todos').getAll();
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
    })()`);
  /** 直接写库造数据（考期边界的几条用这个造，比逐条点 UI 快且能控制日期） */
  const seed = (rows) =>
    ev(`(async () => {
      const rows = ${JSON.stringify(rows)};
      const d = await new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      await new Promise((res, rej) => {
        const tx = d.transaction('todos', 'readwrite');
        for (const row of rows) tx.objectStore('todos').put(row);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      return rows.length;
    })()`);

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(6000);
  await shot('00-home.png');

  /* ================= 进待办页 ================= */
  const navOk = await clickNav('待办');
  rec('侧栏能点到「待办」', navOk);
  await waitFor('document.querySelector(".bd-add") ? true : null', 20000, '待办页');
  await sleep(600);
  await shot('01-board-empty-add-row.png');

  /* ---------- 1. 添加区有「这是考试」 ---------- */
  const addRow = await ev(`(() => {
    const row = document.querySelector(".bd-add");
    const chk = document.querySelector(".bd-exam__check");
    const lab = document.querySelector(".bd-exam__label");
    const r = chk ? chk.getBoundingClientRect() : null;
    return {
      hasCheck: !!chk,
      label: (lab?.textContent ?? "").trim(),
      checked: chk ? chk.checked : null,
      w: r ? Math.round(r.width) : 0,
      h: r ? Math.round(r.height) : 0,
      accentColor: chk ? getComputedStyle(chk).accentColor : "",
      rowText: (row?.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 120),
    };
  })()`);
  rec('**添加区有「这是考试」勾选**', addRow.hasCheck === true, addRow.label);
  rec('勾选框默认不勾（多数待办不是考试）', addRow.checked === false);
  rec('勾选框尺寸正常（不是 0×0 被压扁）', addRow.w >= 12 && addRow.h >= 12, `${addRow.w}×${addRow.h}px`);

  /* ---------- 2. 勾了但没日期 → 提示，且不阻止添加 ---------- */
  await ev(`(() => { document.querySelector(".bd-exam__check").click(); return true; })()`);
  await sleep(400);
  const warn = await ev(`(() => {
    const w = document.querySelector(".bd-exam__warn");
    const btn = [...document.querySelectorAll(".bd-add button")].find(b => (b.textContent||"").trim() === "添加");
    return {
      hasWarn: !!w,
      warnText: (w?.textContent ?? "").trim(),
      addDisabled: btn ? btn.disabled : null,
    };
  })()`);
  rec('**勾了「这是考试」但没填截止日 → 当场提示**', warn.hasWarn === true, warn.warnText);
  rec('提示里说明「没有日期就算不出距几天」', /截止日|日期/.test(warn.warnText), warn.warnText);
  await shot('02-board-exam-warn.png');

  /* ---------- 3. 填标题 + 日期 → 添加，徽标应出现 ---------- */
  const FUTURE = localDate(14);
  const TODAY = localDate(0);
  const PAST = localDate(-6);
  console.log('本次用到的日期：今天=' + TODAY + ' 未来=' + FUTURE + ' 过期=' + PAST);

  const fill = async (sel, val) =>
    ev(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return false;
      const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, ${JSON.stringify(val)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);

  await fill('.bd-add input[type="text"]', '高数期末');
  await fill(".bd-date", FUTURE);
  await sleep(300);
  await ev(`(() => {
    const btn = [...document.querySelectorAll(".bd-add button")].find(b => (b.textContent||"").trim() === "添加");
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(1500);

  const afterAdd = await readTodos();
  const examRow = (afterAdd || []).find((t) => t.title === '高数期末');
  rec('**考试真的写进 IndexedDB 且 isExam 为 true**', Boolean(examRow && examRow.isExam === true),
      examRow ? `id=${examRow.id} dueAt=${examRow.dueAt} isExam=${JSON.stringify(examRow.isExam)}` : '没找到');

  const badge = await ev(`(() => {
    const items = [...document.querySelectorAll(".bd-item")];
    const row = items.find(li => (li.querySelector(".bd-item__title")?.textContent ?? "").includes("高数期末"));
    if (!row) return { found: false };
    const b = row.querySelector(".bd-exam-badge");
    const r = b ? b.getBoundingClientRect() : null;
    return {
      found: true,
      badgeText: (b?.textContent ?? "").trim(),
      w: r ? Math.round(r.width) : 0,
      h: r ? Math.round(r.height) : 0,
      color: b ? getComputedStyle(b).color : "",
    };
  })()`);
  rec('**列表项出现「距 N 天」徽标**', badge.found && /距 1?[0-9] 天|距 [0-9]+ 天/.test(badge.badgeText || ''), badge.badgeText);
  rec('徽标有实际尺寸（不是被挤成 0 宽）', badge.w > 20 && badge.h > 12, `${badge.w}×${badge.h}px`);

  /* ---------- 4~6. 用直接写库造边界数据 ---------- */
  const nowIso = new Date().toISOString();
  await seed([
    {
      id: 'todo_exam_today',
      title: '英语四级',
      note: '',
      dueAt: TODAY,
      done: false,
      doneAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      order: -50,
      isExam: true,
    },
    {
      id: 'todo_exam_past',
      title: '上周的模考',
      note: '',
      dueAt: PAST,
      done: false,
      doneAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      order: -49,
      isExam: true,
    },
    {
      id: 'todo_plain_due',
      title: '普通待办也有截止日',
      note: '',
      dueAt: FUTURE,
      done: false,
      doneAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      order: -48,
      /* 没有 isExam 键 —— 旧数据的形态 */
    },
    {
      id: 'todo_old_noexam',
      title: '旧数据（整条没有 isExam）',
      note: '',
      dueAt: null,
      done: false,
      doneAt: null,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
      order: -47,
    },
  ]);
  /* 回首页再回来：让 BoardPage 重新 list() */
  await clickNav('学习库');
  await clickNav('待办');
  await waitFor('document.querySelector(".bd-add") ? true : null', 20000, '待办页二次');
  await sleep(800);
  await shot('03-board-badges.png');

  const badges = await ev(`(() => {
    const read = (title) => {
      const row = [...document.querySelectorAll(".bd-item")]
        .find(li => (li.querySelector(".bd-item__title")?.textContent ?? "").trim() === title);
      if (!row) return null;
      const b = row.querySelector(".bd-exam-badge");
      return {
        badge: (b?.textContent ?? "").trim() || null,
        cls: b ? b.className : null,
        hasExamMark: !!row.querySelector(".bd-exam-mark"),
        hasExamAdd: !!row.querySelector(".bd-item__exam-add"),
      };
    };
    return {
      today: read("英语四级"),
      past: read("上周的模考"),
      plain: read("普通待办也有截止日"),
      old: read("旧数据（整条没有 isExam）"),
      stats: [...document.querySelectorAll(".bd-stat")].map(s => (s.textContent || "").replace(/\\s+/g, " ").trim()),
    };
  })()`);

  rec('**今天到期的考期徽标写「今天」**（不是「距 0 天」）', badges.today && badges.today.badge === '今天', badges.today && badges.today.badge);
  rec('今天那一档用了实心强调色（--bd-exam-badge--today）',
      !!(badges.today && /bd-exam-badge--today/.test(badges.today.cls || '')));
  rec('**过期的考期徽标写「已过期」**', badges.past && badges.past.badge === '已过期', badges.past && badges.past.badge);
  rec('**普通待办没有徽标**（不能每条待办都挂倒计时）', badges.plain && badges.plain.badge === null,
      badges.plain ? String(badges.plain.badge) : '(行没渲染)');
  rec('旧数据（没有 isExam）也正常渲染、无徽标', badges.old !== null && badges.old.badge === null);
  rec('旧数据有「考」按钮（能被改成考试，不用删了重加）', !!(badges.old && badges.old.hasExamAdd));
  rec('已标为考试的条目有「考期」小标', !!(badges.today && badges.today.hasExamMark));

  /*
   * 「今天 · 前缀」的回归检查（2026-11-21）。
   *
   * 为了去掉考期行里重复的「今天」，我把前缀的显示条件改成了「没有徽标才写」。
   * 这个改动很容易顺手改坏普通待办：一条**今天到期的普通待办**没有徽标，
   * 它必须继续显示「今天 · 2026-11-21」—— 那是那一行唯一的状态来源，
   * 删掉它，「今天到期」这个信息就没了。
   * 所以专门再造一条今天到期的普通待办来验。
   */
  const nowIso2 = new Date().toISOString();
  await seed([
    {
      id: 'todo_plain_today',
      title: '普通待办今天到期',
      note: '',
      dueAt: TODAY,
      done: false,
      doneAt: null,
      createdAt: nowIso2,
      updatedAt: nowIso2,
      order: -60,
    },
  ]);
  await clickNav('学习库');
  await clickNav('待办');
  await waitFor('document.querySelector(".bd-add") ? true : null', 20000, '待办页三次');
  await sleep(800);

  const prefixCheck = await ev(`(() => {
    const read = (title) => {
      const row = [...document.querySelectorAll(".bd-item")]
        .find(li => (li.querySelector(".bd-item__title")?.textContent ?? "").trim() === title);
      if (!row) return null;
      return {
        due: (row.querySelector(".bd-item__due")?.textContent ?? "").trim(),
        badge: (row.querySelector(".bd-exam-badge")?.textContent ?? "").trim() || null,
      };
    };
    return { plainToday: read("普通待办今天到期"), examToday: read("英语四级") };
  })()`);
  console.log('   前缀核对 = ' + JSON.stringify(prefixCheck));
  rec('**普通待办今天到期仍显示「今天 ·」前缀**（改了考期行不能弄坏普通行）',
      !!(prefixCheck.plainToday && /^今天 · /.test(prefixCheck.plainToday.due)),
      prefixCheck.plainToday && prefixCheck.plainToday.due);
  rec('普通待办今天到期没有徽标（它本来就不是考试）',
      !!(prefixCheck.plainToday && prefixCheck.plainToday.badge === null));
  rec('**考期行不再重复「今天」前缀**（徽标已经说了）',
      !!(prefixCheck.examToday && !/今天/.test(prefixCheck.examToday.due)),
      prefixCheck.examToday && prefixCheck.examToday.due);
  await shot('06-board-prefix-check.png');

  /* 把这条临时数据清掉，后面的首页检查只留考期 */
  await ev(`(async () => {
    const d = await new Promise((res, rej) => {
      const r = indexedDB.open('openleaner');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const tx = d.transaction('todos', 'readwrite');
      tx.objectStore('todos').delete('todo_plain_today');
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    return true;
  })()`);

  /* ---------- 6.5 徽标文字对比度（WCAG AA） ---------- */
  /*
   * 为什么必须在这里量、而且必须单独量：
   *
   *  - `check-contrast.cjs` 跑的是它自己的种子数据，里面**没有考期行** ——
   *    它报「待办页 0 处不达标」不等于这一行达标。
   *  - 项目踩过「写了不存在的 token → 回退成深色主题色 → 压在纸上 1.66:1」，
   *    徽标正是「浅字压半透明底」最容易出这类问题的地方。
   *  - 这一段必须在**待办页还开着、徽标还在 DOM 里**时跑。
   *    第一版把它放在末尾（已经切到首页），量到空数组、
   *    而那条断言当时写的是「不达标数 == 0」，空数组也成立 ——
   *    幸好另加了一条「至少量到一枚」把它抓出来了。
   */
  const contrast = await ev(`(() => {
    /*
     * 解析 computed color —— 必须同时认 rgb()/rgba() 与
     * color(srgb r g b / a)（后者是 color-mix() 在 Chromium 里的序列化形式，
     * 分量是 0..1，不是 0..255）。只认 rgb() 会让这类节点被静默跳过。
     */
    const parse = (s) => {
      if (!s) return null;
      let m = /rgba?\\(([^)]+)\\)/.exec(s);
      if (m) {
        const p = m[1].split(/[,\\s/]+/).filter(Boolean).map((x) => parseFloat(x));
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      }
      m = /color\\(\\s*srgb\\s+([^)]+)\\)/.exec(s);
      if (m) {
        const p = m[1].split(/[\\s/]+/).filter(Boolean).map((x) => parseFloat(x));
        return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 };
      }
      return null;
    };
    const lum = (c) => {
      const f = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const mix = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    /* 页面底色（--bg-canvas 深色 #161412 = 22,20,18），半透明底先混到它上面 */
    const PAGE = { r: 22, g: 20, b: 18, a: 1 };
    const bgOf = (el) => {
      let cur = el;
      while (cur && cur !== document.documentElement) {
        const c = parse(getComputedStyle(cur).backgroundColor);
        if (c && c.a > 0) return c.a < 1 ? mix(c, PAGE) : c;
        cur = cur.parentElement;
      }
      return PAGE;
    };
    const out = [];
    for (const b of document.querySelectorAll('.bd-exam-badge, .bd-exam-mark')) {
      const cs = getComputedStyle(b);
      const fg = parse(cs.color);
      const bg = bgOf(b);
      if (!fg) continue;
      const f = mix(fg, bg);
      const L1 = lum(f);
      const L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      out.push({
        text: (b.textContent || '').trim(),
        ratio: Math.round(ratio * 100) / 100,
        fg: cs.color,
        bg: cs.backgroundColor,
      });
    }
    return out;
  })()`);
  console.log('   徽标对比度 = ' + JSON.stringify(contrast));
  rec('确实量到了徽标（不然下一条是空过）', (contrast || []).length >= 3,
      `${(contrast || []).length} 枚`);
  const badContrast = (contrast || []).filter((c) => c.ratio < 4.5);
  rec('**考期徽标文字对比度 ≥ 4.5:1**（WCAG AA）', badContrast.length === 0,
      (contrast || []).map((c) => `${c.text}=${c.ratio}:1`).join(' · '));

  /* ---------- 7. 概览区取最近那一场 ---------- */
  const examStat = await ev(`(() => {
    const s = document.querySelector(".bd-stat--exam");
    return { has: !!s, text: (s?.textContent ?? "").replace(/\\s+/g, " ").trim() };
  })()`);
  rec('**概览区有考期一格**', examStat.has === true, examStat.text);
  rec('概览取的是最近的「今天到期」那一场，不是 14 天后那场',
      /今天/.test(examStat.text) && /英语四级/.test(examStat.text), examStat.text);
  rec('概览里没有把两周后的「高数期末」当成最近一场', !/高数期末/.test(examStat.text));

  /* ---------- 8. 已有待办能被标成考试（点「考」） ---------- */
  const toggled = await ev(`(() => {
    const row = [...document.querySelectorAll(".bd-item")]
      .find(li => (li.querySelector(".bd-item__title")?.textContent ?? "").trim() === "普通待办也有截止日");
    if (!row) return 'no-row';
    const btn = row.querySelector(".bd-item__exam-add");
    if (!btn) return 'no-btn';
    btn.click();
    return 'clicked';
  })()`);
  await sleep(1500);
  const plainAfter = (await readTodos() || []).find((t) => t.id === 'todo_plain_due');
  rec('**点「考」能把已有待办改成考试并落库**', toggled === 'clicked' && plainAfter && plainAfter.isExam === true,
      toggled + ' isExam=' + JSON.stringify(plainAfter && plainAfter.isExam));

  const plainBadgeNow = await ev(`(() => {
    const row = [...document.querySelectorAll(".bd-item")]
      .find(li => (li.querySelector(".bd-item__title")?.textContent ?? "").trim() === "普通待办也有截止日");
    const b = row ? row.querySelector(".bd-exam-badge") : null;
    return (b?.textContent ?? "").trim() || null;
  })()`);
  rec('改成考试后徽标立刻出现', plainBadgeNow !== null, String(plainBadgeNow));

  /* 改回去：点「考期」小标应删除字段 */
  const undoOk = await ev(`(() => {
    const row = [...document.querySelectorAll(".bd-item")]
      .find(li => (li.querySelector(".bd-item__title")?.textContent ?? "").trim() === "普通待办也有截止日");
    if (!row) return 'no-row';
    const btn = row.querySelector(".bd-exam-mark");
    if (!btn) return 'no-mark';
    btn.click();
    return 'clicked';
  })()`);
  await sleep(1500);
  const plainUndo = (await readTodos() || []).find((t) => t.id === 'todo_plain_due');
  rec('**再点「考期」能改回普通待办，且库里删掉 isExam 键**（不存 false）',
      undoOk === 'clicked' && plainUndo && !('isExam' in plainUndo),
      undoOk + ' hasKey=' + JSON.stringify(plainUndo && 'isExam' in plainUndo));

  /* ---------- 9. 首页「今日学习」小组件有倒计时行 ---------- */
  await clickNav('学习库');
  await sleep(2500);
  await shot('04-home-with-exam.png');

  const homeExam = await ev(`(() => {
    const p = document.querySelector(".home-widget__exam");
    const planCard = document.querySelector(".home-widgets");
    return {
      has: !!p,
      text: (p?.textContent ?? "").replace(/\\s+/g, " ").trim(),
      n: (p?.querySelector(".home-widget__exam-n")?.textContent ?? "").trim(),
      title: (p?.querySelector(".home-widget__exam-title")?.textContent ?? "").trim(),
      hasPlanWidget: !!planCard,
    };
  })()`);
  rec('**首页「今日学习」小组件出现考试倒计时行**', homeExam.has === true, homeExam.text);
  rec('倒计时行写的是「今天 … 英语四级 开考」', /今天/.test(homeExam.n) && homeExam.title === '英语四级',
      `n=${homeExam.n} title=${homeExam.title}`);
  rec('首页这一行的标题没被截成空串（宽度够）', homeExam.title.length >= 2, homeExam.title);

  /*
   * 首页倒计时行的对比度（2026-11-21）。
   *
   * ## 为什么必须单独量这一处
   *
   * 这一行画在**纸张卡**上（`.paper`，深色主题是 #ece4d6 米黄纸），
   * 而 accent 系列是照着深色画布调的。实测：
   *   --accent      on 纸 → 3.99:1  ❌
   *   --accent-text on 纸 → 2.47:1  ❌
   * 两者都低于 WCAG AA。`check-contrast.cjs` 抓不到，因为它跑的时候
   * 首页还没有考期，这一行根本不存在（渲染都不渲染，自然没有节点可量）。
   *
   * 现在的实现是 color-mix(accent 75%, paper-ink)：
   *   深色纸 5.54:1 ✅ · 浅色纸 7.35:1 ✅
   *
   * ⚠️ 这条断言必须量**实际的 getComputedStyle**，不能拿 CSS 里的字面值
   * 反推 —— 否则它只是在重复 CSS 的写法，不验证浏览器算出来的结果。
   */
  const homeContrast = await ev(`(() => {
    /*
     * 解析 computed color。
     *
     * ⚠️ 必须同时认两种序列化：
     *  - rgb()/rgba()  —— 普通色值
     *  - color(srgb r g b / a) —— **color-mix() 在 Chromium 里的 computed 结果**
     *    分量是 0..1 的小数，不是 0..255。
     *
     * 第一版只写了 rgb()，于是 color-mix 出来的前景色解析成 null、
     * 那条 .home-widget__exam-n 被静默跳过 —— 所以断言里只剩 title 一行，
     * 失败信息里也看不出「根本没量到」。教训：量对比度的代码本身也要验
     * 「量到了几个」，不能只验「不达标数 == 0」。
     *
     * ⚠️ 这段整个在模板字符串里：注释中**不能出现反引号**，会提前结束字符串
     * （项目硬约束 10；这次踩了一次，报错是 widget__exam is not defined）。
     */
    const parse = (s) => {
      if (!s) return null;
      let m = /rgba?\\(([^)]+)\\)/.exec(s);
      if (m) {
        const p = m[1].split(/[,\\s/]+/).filter(Boolean).map((x) => parseFloat(x));
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      }
      m = /color\\(\\s*srgb\\s+([^)]+)\\)/.exec(s);
      if (m) {
        const p = m[1].split(/[\\s/]+/).filter(Boolean).map((x) => parseFloat(x));
        return {
          r: p[0] * 255,
          g: p[1] * 255,
          b: p[2] * 255,
          a: p.length > 3 ? p[3] : 1,
        };
      }
      return null;
    };
    const lum = (c) => {
      const f = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const mix = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const PAPER = { r: 236, g: 228, b: 214, a: 1 };
    const bgOf = (el) => {
      let cur = el;
      while (cur && cur !== document.documentElement) {
        const c = parse(getComputedStyle(cur).backgroundColor);
        if (c && c.a > 0) return c.a < 1 ? mix(c, PAPER) : c;
        cur = cur.parentElement;
      }
      return PAPER;
    };
    const p = document.querySelector('.home-widget__exam');
    if (!p) return { rows: [], missing: 'no .home-widget__exam' };
    const rows = [];
    for (const sel of ['.home-widget__exam-n', '.home-widget__exam-title']) {
      const el = p.querySelector(sel);
      if (!el) {
        rows.push({ sel, text: null, ratio: null, note: '元素不存在' });
        continue;
      }
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      if (!fg) {
        rows.push({ sel, text: (el.textContent || '').trim(), ratio: null, note: '颜色解析失败: ' + cs.color });
        continue;
      }
      const bg = bgOf(el);
      const f = mix(fg, bg);
      const L1 = lum(f);
      const L2 = lum(bg);
      rows.push({
        sel,
        text: (el.textContent || '').trim(),
        ratio: Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100,
        fg: cs.color,
        bg: cs.backgroundColor,
      });
    }
    return { rows };
  })()`);
  const homeRows = (homeContrast && homeContrast.rows) || [];
  console.log('   首页倒计时行对比度 = ' + JSON.stringify(homeRows));
  const badHome = homeRows.filter((c) => typeof c.ratio !== 'number' || c.ratio < 4.5);
  rec('**首页倒计时行文字对比度 ≥ 4.5:1**（WCAG AA，压在米黄纸上）',
      homeRows.length >= 2 && badHome.length === 0,
      homeRows.map((c) => `${c.sel.replace('.home-widget__exam', '') || '-both'}=${String(c.ratio)}:1${c.note ? '(' + c.note + ')' : ''}`).join(' · ') || '(没量到)');

  /* ---------- 10. 没有未来考期时整行不渲染 ---------- */
  const allTodos = (await readTodos()) || [];
  /* 把所有考期标成普通待办（直接写库，别在 UI 里一条条点） */
  await seed(allTodos.filter((t) => t.isExam === true).map((t) => {
    const copy = { ...t };
    delete copy.isExam;
    return copy;
  }));
  await clickNav('待办');
  await sleep(1000);
  await clickNav('学习库');
  await sleep(2200);
  const homeNoExam = await ev(`(() => {
    const p = document.querySelector(".home-widget__exam");
    const card = document.querySelector(".home-widget");
    return { has: !!p, cardText: (card?.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 80) };
  })()`);
  rec('**没有未来考期时，首页倒计时整行不渲染**（不摆假行）', homeNoExam.has === false, homeNoExam.cardText);
  await shot('05-home-no-exam.png');

  /* ---------- 11. 控制台无报错 ---------- */
  const realErrs = errs.filter((e) => !/Autofill|Failed to load resource|net::ERR/i.test(e));
  rec('**控制台无报错**', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  /* ---------- 13. 截图里的可见证据 ---------- */
  const shots = fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS).filter((f) => f.endsWith('.png')) : [];
  rec('截图已落盘', shots.length >= 5, shots.join(', '));

  ws.close();
  try {
    app.kill();
  } catch {
    /* 已经退出 */
  }
  await sleep(1500);
  try {
    spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  await sleep(1200);

  /* ---------- 14. 真实库没被动过 ---------- */
  const realAfter = dirHash(REAL_DB);
  rec('**真实用户库没被动过**（前后指纹一致）', realAfter === realBefore, `${realBefore} → ${realAfter}`);

  console.log('\n' + (fail === 0 ? '全部通过' : `失败 ${fail} 条`) + `：${pass} passed / ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('脚本异常：' + (e && e.stack ? e.stack : e));
  try {
    spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  process.exit(2);
});
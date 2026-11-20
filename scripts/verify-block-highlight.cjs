/**
 * 验证「整段也高亮」（2026-11-20）。
 *
 * ## 用户原话
 *
 * > 我看了复习库中所有题都标注了不能跳转到某一句子，那我们退而求其次
 * > 具体不到某一句子就让那一段落也高亮显示
 *
 * ## 要证的
 *
 * 1. 点整段出处的题，阅读器里**真的出现 mark**
 * 2. mark 覆盖**整段**（不是几个字）
 * 3. 它**明显比句子级淡**（用户 11-09 说过「满屏高光很抽象」）
 * 4. 仍是橙色（与标注的琥珀黄区分）
 * 5. 说明文字说清「这是整段、精确不到某一句」
 * 6. 翻页仍消失（临时性没被破坏）
 *
 * ## 为什么用真实库副本
 *
 * 用户库里那 23 道已发布题的锚点**全是整段** —— 正好是这个功能的
 * 真实场景，比造假数据有意义。
 *
 * 用法：node scripts/verify-block-highlight.cjs
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APPDATA = path.resolve(ROOT, '.tmp/block-hl-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/block-highlight');
const PORT = Number(process.argv[2] || 9858);
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
  const trap = path.join(path.dirname(exe), 'openleaner-data');
  if (fs.existsSync(trap)) {
    console.error('❌ app 目录旁有 openleaner-data，会抢先');
    process.exit(2);
  }

  const app = spawn(
    exe,
    [ROOT, '--user-data-dir=' + DATA, '--no-sandbox', '--remote-debugging-port=' + PORT, '--window-size=1440,1100'],
    { cwd: ROOT, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  app.stdout.on('data', (d) => (log += d.toString()));
  app.stderr.on('data', (d) => (log += d.toString()));

  let target = null;
  for (let i = 0; i < 240; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
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
  const waitFor = async (expr, ms = 20000, label = '') => {
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

  /* 进复习巩固 */
  await ev(`(() => {
    for (const lb of document.querySelectorAll(".nav-group__label")) {
      const b = lb.closest("button"); const g = lb.closest(".nav-group");
      if (b && g && g.getAttribute("aria-expanded") !== "true") b.click();
    }
    return true;
  })()`);
  await sleep(700);
  await ev(`(() => {
    const el = [...document.querySelectorAll(".nav-item__label,.nav-item")]
      .find((e) => e.textContent.trim().includes("复习巩固"));
    if (el) { el.click(); return true; }
    return false;
  })()`);
  await waitFor(`document.querySelector(".bk-toolbar") ? true : null`, 20000, '复习巩固页');
  await sleep(1000);
  await shot('01-book-before-click.png');

  /* 入口文案：应说「会把那一段标出来」，不再说「不高亮」 */
  const entry = await ev(`(() => {
    const li = document.querySelector(".bk-q");
    return {
      btnText: (li?.querySelector(".bk-q__locate")?.textContent ?? "").trim(),
      note: (li?.querySelector(".bk-q__locate-note")?.textContent ?? "").trim(),
    };
  })()`);
  console.log('入口 =', JSON.stringify(entry));
  rec('**入口说明改成「会标出来」**', /标出来/.test(entry.note), entry.note);
  rec('入口说明不再说「不高亮」', !/不高亮/.test(entry.note));

  /* 点第一道题 */
  await ev(`(() => {
    const b = document.querySelector(".bk-q__locate");
    if (b) { b.click(); return true; }
    return false;
  })()`);
  await waitFor(`document.querySelector(".reader-page, .reader-split") ? true : null`, 20000, '阅读器');
  /* 等 mark 出现 —— 高亮是第二步 effect 画的，只等 .reader-page 会查到 0 */
  await waitFor(`document.querySelector("mark.reader-mark") ? true : null`, 20000, '高亮出现');
  await sleep(1200);
  await shot('02-block-highlight.png');

  const mark = await ev(`(() => {
    const marks = [...document.querySelectorAll("mark.reader-mark")];
    if (!marks.length) return { count: 0 };
    const m = marks[0];
    const cs = getComputedStyle(m);
    /*
     * ⚠️ 覆盖率必须**累加所有 mark**，不能只看第一个。
     *
     * 整段高亮会被 Markdown 解析拆成几十个片段（标题、段落、公式各一段），
     * 实测这段正文被拆成 44 个 <mark>。第一版只量 marks[0] 的 9 个字，
     * 算出 1% 覆盖率 —— 断言错，不是功能错。
     */
    const body = document.querySelector(".reader-body") || document.body;
    const total = (body.textContent || "").replace(/\\s/g, "").length;
    const markedLen = marks.reduce(
      (n, x) => n + (x.textContent || "").replace(/\\s/g, "").length,
      0,
    );
    /* 有几个 mark 属实用「段落级」样式 */
    const blockCount = marks.filter((x) => /reader-mark--block/.test(x.className)).length;
    return {
      count: marks.length,
      blockCount,
      firstTextLen: (m.textContent || "").length,
      isBlock: /reader-mark--block/.test(m.className),
      isTransient: /reader-mark--transient/.test(m.className),
      bg: cs.backgroundColor,
      shadow: cs.boxShadow,
      radius: cs.borderRadius,
      coverage: total > 0 ? Math.round((markedLen / total) * 100) : 0,
      markedLen,
      totalLen: total,
    };
  })()`);
  console.log('mark =', JSON.stringify(mark, null, 1));

  rec('**点整段出的题，正文里出现了高亮**', mark.count >= 1, 'mark 数=' + mark.count);
  rec('**带段落级 class**', !!mark.isBlock);
  rec('**仍带临时标记**（橙光语义不变）', !!mark.isTransient);
  rec(
    '**覆盖了整段（不是几个字）**',
    mark.coverage >= 80,
    '覆盖 ' + mark.coverage + '%（' + mark.markedLen + '/' + mark.totalLen + ' 字）',
  );

  const rgb = (s) => {
    const m = String(s).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const c = rgb(mark.bg);
  rec('**底色仍是橙色**（不是琥珀黄）', !!c && c.r > c.g && c.g > c.b && c.r - c.b > 60, mark.bg || '');
  /*
   * 淡度是这次的关键：11-09 用户说「整个页面都是高光，这有点抽象」。
   * 所以段落级的 alpha 必须明显低于句子级（0.28）。
   */
  rec(
    '**比句子级明显更淡**（alpha < 0.2）',
    !!c && c.a < 0.2,
    'alpha=' + (c ? c.a : '?') + '（句子级是 0.28）',
  );
  rec('**没有描边**（描边是「选中」语义，整段用太重）', mark.shadow === 'none', mark.shadow);

  /* 说明文字 */
  const notes = await ev(`(() => [...document.querySelectorAll(".reader-jump")].map((n) => n.textContent.trim()))()`);
  console.log('说明 =', JSON.stringify(notes));
  rec('**说明文字解释「整段、精确不到某一句」**',
      notes.some((t) => /整段/.test(t) && /(精确不到|不是某一句)/.test(t)),
      JSON.stringify(notes));
  rec('说明不再说「不单独高亮」', !notes.some((t) => /不单独高亮/.test(t)));

  /* 临时性仍成立 */
  const beforeFlip = await ev(`document.querySelectorAll("mark.reader-mark").length`);
  const flipped = await ev(`(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "下一段");
    if (b && !b.disabled) { b.click(); return true; }
    return false;
  })()`);
  await sleep(1600);
  const afterFlip = await ev(`document.querySelectorAll("mark.reader-mark").length`);
  rec('**翻页后高亮消失**（临时性没被破坏）',
      !!flipped && beforeFlip >= 1 && afterFlip === 0,
      beforeFlip + ' → ' + afterFlip);

  rec('没有控制台报错', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  console.log('  截图：' + SHOTS);
  if (fail > 0) process.exitCode = 1;

  ws.close();
  app.kill();
  await sleep(1200);
})();
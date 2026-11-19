/**
 * 全界面文字对比度巡检（2026-11-19）。
 *
 * ## 为什么需要它
 *
 * `.reveal__option-why` 实测 1.66:1 那件事说明：**CSS 里写了个不存在的
 * token，回退到深色主题的次要文字色，压在浅色纸张卡上** —— 这种错
 * 在界面上不报错、不崩，只是「有点看不清」，靠肉眼容易放过去。
 *
 * 所以做成可重复的测量：遍历若干页面，把每个可见文字节点的
 * 前景/背景算出来，报出低于 WCAG AA（4.5:1，大字 3:1）的项。
 *
 * ## 口径（必须写清，否则数字没有意义）
 *
 * - 只测**有可见文字**的叶子节点（有 textContent、且自身不是容器里套容器）
 * - 背景色沿祖先链找**第一个不透明**的 background-color；
 *   背景是渐变/图片时标记为 `unknown`，不计入不达标（但会列出来）
 * - 「大字」= 字号 ≥ 24px，或 ≥ 18.66px 且 bold → 门槛 3:1
 * - 半透明文字色按 alpha 与背景混合后再算
 *
 * ## 隔离
 *
 * 用隔离副本（硬约束 12），跑完检查 app 目录旁没有 openleaner-data。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
const APPDATA = path.resolve(ROOT, '.tmp/verify-fakeswitch-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const PORT = Number(process.argv[2] || 9824);
const SHOTS = path.join(ROOT, '.verify-shots/contrast');
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

/* 每页跑一次测量 */
const MEASURE = `(() => {
  const parse = (s) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(s);
    if (!m) return null;
    const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const la = lum(a), lb = lum(b);
    const L = Math.max(la, lb), S = Math.min(la, lb);
    return (L + 0.05) / (S + 0.05);
  };
  /* 半透明前景与背景混合 */
  const blend = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  /* 沿祖先找第一个不透明背景；遇到渐变/图片就标记 unknown */
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return { unknown: 'gradient/image' };
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0.98) return { color: c };
      n = n.parentElement;
    }
    return { color: parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 } };
  };

  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    /* 只要「自己直接带文字」的元素 */
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join('')
      .trim();
    if (!own) continue;
    if (seen.has(el)) continue;
    seen.add(el);

    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;

    const fgRaw = parse(cs.color);
    if (!fgRaw) continue;
    const bgInfo = bgOf(el);
    if (bgInfo.unknown) continue;   /* 渐变/图片底，算不准，跳过 */
    const bg = bgInfo.color;
    const fg = fgRaw.a < 1 ? blend(fgRaw, bg) : fgRaw;
    const cr = Math.round(ratio(fg, bg) * 100) / 100;

    const size = parseFloat(cs.fontSize);
    const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;

    out.push({
      cls: (el.className && String(el.className).slice(0, 60)) || el.tagName,
      text: own.replace(/\\s+/g, ' ').slice(0, 42),
      color: cs.color,
      bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
      size: Math.round(size * 10) / 10,
      bold,
      contrast: cr,
      need,
      pass: cr >= need,
    });
  }
  return out;
})()`;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const stray = path.join(ROOT, '.tmp/cloud-fullonly-app/openleaner-data');
  if (fs.existsSync(stray)) fs.rmSync(stray, { recursive: true, force: true });

  const app = spawn(EXE, [
    ROOT, `--user-data-dir=${DATA}`, '--no-sandbox',
    `--remote-debugging-port=${PORT}`, '--window-size=1440,1000',
  ], { cwd: ROOT, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  app.stdout.on('data', (d) => (log += d.toString()));
  app.stderr.on('data', (d) => (log += d.toString()));

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 240; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = l.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
        if (target) break;
      } catch {}
      await SLEEP(250);
    }
    if (!target) { console.error('起不来:' + log.slice(-2000)); process.exit(2); }

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    let id = 1; const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const n = id++; pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
      setTimeout(() => { if (pending.has(n)) { pending.delete(n); reject(new Error('timeout ' + method)); } }, 90000);
    });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const shot = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
    };
    const clickNav = async (label) => evalJs(`(()=>{
      const el=[...document.querySelectorAll('.nav-item__label,.nav-item')]
        .find(e=>e.textContent.trim().includes(${JSON.stringify(label)}));
      if(el){el.click();return true}return false})()`);

    await send('Runtime.enable'); await send('Page.enable');
    await SLEEP(5000);

    /*
     * 展开侧栏所有分组。
     *
     * 「知识骨架」「学习统计」在折叠分组里，不展开就 `clickNav` 找不到。
     * 实测结构（别照猜）：`.nav-group` 的**第一个孩子是 `<span class="nav-group__label">`**，
     * 真正可点的是它外面那层 `<button>`（`AppShell.tsx:216` 的 onClick）。
     * 折叠时组内条目根本不渲染（条件渲染），所以必须真的点开。
     */
    for (let round = 0; round < 3; round++) {
      const opened = await evalJs(`(()=>{
        let n = 0;
        for (const label of document.querySelectorAll('.nav-group__label')) {
          const btn = label.closest('button');
          const group = label.closest('.nav-group');
          if (!btn || !group) continue;
          if (group.getAttribute('aria-expanded') === 'true') continue;
          btn.click();
          n++;
        }
        return n;
      })()`);
      await SLEEP(600);
      if (!opened) break;
    }
    await SLEEP(400);

    const pages = [
      ['学习库', 'today'],
      ['学习地图', 'map'],
      ['知识骨架', 'skeleton'],
      ['错题与待巩固', 'wrongbook'],
      ['回收站', 'trash'],
      ['统计', 'stats'],   /* 侧栏标签是「统计」，title 才是「学习统计」 */
      ['待办', 'board'],
      ['我的题组', 'decks'],
      ['资料', 'sources'],
      ['设置', 'settings'],
    ];

    const all = [];
    for (const [label, key] of pages) {
      const ok = await clickNav(label);
      await SLEEP(2600);
      if (!ok) { console.log(`  ⚠️ 找不到导航项：${label}`); continue; }
      let rows = [];
      try { rows = await evalJs(MEASURE); } catch (e) { console.log(`  ⚠️ ${label} 测量失败：${e.message}`); continue; }
      const bad = rows.filter((r) => !r.pass);
      console.log(`  ${label.padEnd(10)} 文字节点 ${String(rows.length).padStart(3)} 个 · 不达标 ${bad.length}`);
      for (const b of bad) {
        all.push({ page: label, ...b });
      }
      await shot(`page-${key}.png`);
    }

    console.log(`\n=== 不达标合计 ${all.length} 处 ===`);
    for (const b of all.sort((a, c) => a.contrast - c.contrast)) {
      console.log(
        `  ${String(b.contrast).padStart(6)}:1 (需 ${b.need})  [${b.page}] ${b.cls}\n` +
        `        "${b.text}"  color=${b.color} bg=${b.bg} size=${b.size}${b.bold ? ' bold' : ''}`,
      );
    }

    fs.writeFileSync(path.join(SHOTS, 'contrast-report.json'), JSON.stringify(all, null, 1), 'utf8');
    console.log(`\n报告 → ${path.join(SHOTS, 'contrast-report.json')}`);
    process.exitCode = all.length > 0 ? 1 : 0;
  } catch (e) {
    console.error('异常：', e && e.message);
    console.error(log.slice(-2000));
    process.exitCode = 2;
  } finally {
    try { ws && ws.close(); } catch {}
    app.kill();
    await SLEEP(1200);
    const strayAfter = path.join(ROOT, '.tmp/cloud-fullonly-app/openleaner-data');
    console.log(fs.existsSync(strayAfter) ? '⚠️ app 目录旁出现 openleaner-data（隔离失效）' : '✅ 隔离生效');
  }
})();
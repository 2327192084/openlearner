/**
 * 验证打包产物（app.asar）里的 dist 在 file:// 下能否正常跑。
 *
 * 为什么不直接启动 OpenLeaner.exe：本会话没有可用显示环境，
 * Electron 建窗口时会在 Chromium Mojo 创建命名管道处被拒（EACCES）。
 *
 * 替代做法：把 asar 里的 dist 解出来，用与 Electron 相同的 file:// 方式加载。
 * 这验证的是「打进包里的那些字节」而不是「工作区里的 dist」——
 * 两者可能不同（比如 files 配置漏了 assets），这类问题只有验产物才能发现。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const EXTRACT_DIR = path.join(OUT_DIR, 'asar-dist');
const PORT = 9225;
const LOG = path.join(OUT_DIR, 'log-packaged.txt');

const results = [];
function say(line) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(LOG, `${line}\n`);
  console.log(line);
}
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    }
    return res.result.value;
  }
  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) break;
    } catch {
      /* wait */
    }
    await sleep(250);
  }
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, {
    method: 'PUT',
  }).then((r) => r.json());
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new Cdp(ws);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LOG, '');
  say(`打包产物验收开始 ${new Date().toISOString()}`);

  const asarPath = path.join(__dirname, '..', 'release', 'win-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) {
    say(`找不到 ${asarPath}，请先跑 electron-builder --dir`);
    return 1;
  }

  // ---------- 1. asar 结构检查 ----------
  const entries = asar.listPackage(asarPath).map((e) => e.replace(/\\/g, '/'));
  const hasMain = entries.includes('/electron/main.cjs');
  const hasPreload = entries.includes('/electron/preload.cjs');
  const hasIndexHtml = entries.includes('/dist/index.html');
  const assets = entries.filter((e) => /^\/dist\/assets\/.+\.(js|css)$/.test(e));

  record(
    '打包产物含主进程、preload、界面入口',
    hasMain && hasPreload && hasIndexHtml,
    `main=${hasMain} preload=${hasPreload} index=${hasIndexHtml}`,
  );
  record(
    '打包产物含构建后的 js 与 css 资源',
    assets.length >= 2,
    `资源 ${assets.length} 个：${assets.slice(0, 3).join(', ')}`,
  );

  // ---------- 2. 解出 dist 用 file:// 加载 ----------
  fs.rmSync(EXTRACT_DIR, { recursive: true, force: true });
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  asar.extractAll(asarPath, EXTRACT_DIR);
  const packagedIndex = path.join(EXTRACT_DIR, 'dist', 'index.html');
  if (!fs.existsSync(packagedIndex)) {
    say('解包后没有 dist/index.html');
    return 1;
  }
  const fileUrl = `file:///${packagedIndex.replace(/\\/g, '/')}`;
  say(`加载解包后的产物: ${fileUrl}\n`);

  const userDataDir = path.join(OUT_DIR, 'edge-profile-packaged');
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      '--allow-file-access-from-files',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=1280,860',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp;
  try {
    cdp = await connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const consoleErrors = [];
    cdp.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(
          msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text,
        );
      }
    });

    await cdp.send('Page.navigate', { url: fileUrl });
    await sleep(3500);

    const first = await cdp.eval(`(() => ({
      hash: location.hash,
      hasShell: !!document.querySelector('.shell'),
      title: document.querySelector('.shell__page-title')?.textContent ?? null,
      navCount: document.querySelectorAll('.shell__link').length,
      contentText: (document.querySelector('.shell__content')?.innerText ?? '').slice(0, 120),
    }))()`);

    record(
      '打包产物 file:// 下首屏正常（不是白屏、不是 404）',
      first.hasShell && !first.contentText.includes('页面不存在') && first.title === '资料库',
      `hash=${first.hash} 顶栏=${first.title}`,
    );
    record('打包产物导航条目齐全', first.navCount === 7, `实际 ${first.navCount} 条`);

    // 点通几个页面
    for (const [id, title] of [
      ['knowledge', '知识点'],
      ['settings', '设置'],
    ]) {
      await cdp.eval(`[...document.querySelectorAll('.shell__link')]
        .find(a => (a.getAttribute('href') ?? '').endsWith('/${id}')).click()`);
      await sleep(500);
      const st = await cdp.eval(`(() => ({
        title: document.querySelector('.shell__page-title')?.textContent ?? null,
        alive: !!document.querySelector('.shell'),
      }))()`);
      record(`打包产物页面「${title}」可点通`, st.title === title && st.alive, `顶栏=${st.title}`);
    }

    // 建库并刷新
    const built = await cdp.eval(`(async () => {
      const input = document.querySelector('.card input.input');
      if (!input) return { ok: false };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '打包产物测试库');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库')).click();
      await new Promise(r => setTimeout(r, 1800));
      return { ok: [...document.querySelectorAll('button')].some(b => b.textContent.includes('导出学习库')) };
    })()`);
    await cdp.send('Page.reload');
    await sleep(3000);
    const persisted = await cdp.eval(`(async () => {
      [...document.querySelectorAll('.shell__link')]
        .find(a => (a.getAttribute('href') ?? '').endsWith('/settings'))?.click();
      await new Promise(r => setTimeout(r, 1000));
      return { name: document.querySelector('.card input.input')?.value ?? null };
    })()`);
    record(
      '打包产物能建库且刷新后仍在',
      built.ok && persisted.name === '打包产物测试库',
      `库名=${persisted.name}`,
    );

    record(
      '打包产物运行无 console 错误',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 2).join(' | '),
    );

    await cdp.screenshot(path.join(OUT_DIR, 'packaged-result.png'));

    const failed = results.filter((r) => !r.ok);
    say('\n================ 汇总 ================');
    say(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    if (failed.length > 0) {
      for (const f of failed) say(`  - ${f.name}${f.detail ? `  ${f.detail}` : ''}`);
    }
    fs.writeFileSync(
      path.join(OUT_DIR, 'report-packaged.json'),
      JSON.stringify({ results, consoleErrors }, null, 2),
    );
    return failed.length;
  } finally {
    try {
      cdp?.ws.close();
    } catch {
      /* ignore */
    }
    edge.kill();
  }
}

main()
  .then((n) => process.exit(n === 0 ? 0 : 1))
  .catch((err) => {
    say(`探针自身出错：${err && err.stack ? err.stack : err}`);
    process.exit(2);
  });

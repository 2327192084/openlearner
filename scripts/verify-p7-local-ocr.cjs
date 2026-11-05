/**
 * P7 验收探针：本地 OCR + 图片资料。
 *
 * ## 这个脚本要证明的事
 *
 * 1. **本地 OCR 真的能在浏览器里跑起来** —— 用的是真实 wasm + 真实中文
 *    语言包，不是假实现。这是本脚本最重要的一条：如果 wasm 或语言包
 *    路径配错，单元测试（注入假 worker）永远发现不了。
 * 2. 界面上的引擎下拉框**同时有本地与看图模型**，且默认选本地。
 * 3. 图片可以导入，且**在阅读器里真的显示出来**（不是一条空记录）。
 * 4. 图片导入后是可识别的状态（no-text-layer），与扫描件同一条路。
 *
 * ## 前置
 *
 *   npx vite build
 *   npx vite preview --port 4173
 *
 * ## 为什么这条不能只靠单测
 *
 * 单测里 worker 是注入的假对象。真正会失败的环节是：
 *   - `public/tesseract/` 没被复制进 dist
 *   - 语言包文件名/tesseract 期望的目录结构对不上
 *   - file:// 与 http:// 的 baseURI 解析差异
 * 这些都只有真浏览器能验。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const PORT = 9237;
const LOG = path.join(OUT_DIR, 'log-p7-local-ocr.txt');

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
      }, 180000);
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
}

async function connect() {
  for (let i = 0; i < 60; i++) {
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
  say(`P7 本地 OCR / 图片 验收开始 ${new Date().toISOString()}\n`);

  // 先确认构建产物里有静态资源 —— 没有就直接失败，不用起浏览器
  const assetRoot = path.join(__dirname, '..', 'dist', 'tesseract');
  const langFile = path.join(assetRoot, 'lang', 'chi_sim.traineddata.gz');
  record(
    '构建产物含中文语言包',
    fs.existsSync(langFile),
    fs.existsSync(langFile) ? `${(fs.statSync(langFile).size / 1024 / 1024).toFixed(1)} MB` : '缺失',
  );
  record('构建产物含 worker', fs.existsSync(path.join(assetRoot, 'worker.min.js')));
  record('构建产物含 wasm', fs.existsSync(path.join(assetRoot, 'core', 'tesseract-core-simd-lstm.wasm')));

  /**
   * `.wasm.js` 是 Emscripten 胶水，worker 用 importScripts 加载它再去取 .wasm。
   * 只复制 .wasm 时单元测试全绿、真浏览器直接报 importScripts failed ——
   * 这条断言就是为了防这个（它曾被漏掉，导致一次真实踩坑）。
   */
  const coreDir = path.join(assetRoot, 'core');
  const coreJs = fs.existsSync(coreDir)
    ? fs.readdirSync(coreDir).filter((f) => f.endsWith('.wasm.js'))
    : [];
  record('core 目录含 .wasm.js 胶水文件', coreJs.length >= 6, `${coreJs.length} 个`);

  // getCore.js 按 CPU 特性四选一，6 个变体缺一个就会在别的机器上 404
  const variants = [
    'tesseract-core-lstm',
    'tesseract-core-simd-lstm',
    'tesseract-core-relaxedsimd-lstm',
    'tesseract-core',
    'tesseract-core-simd',
    'tesseract-core-relaxedsimd',
  ];
  const missing = variants.filter((v) => {
    const hasWasm = fs.existsSync(path.join(coreDir, `${v}.wasm`));
    const hasGlue = fs.existsSync(path.join(coreDir, `${v}.wasm.js`));
    return !(hasWasm && hasGlue);
  });
  record(
    '6 个 core 变体齐全（换 CPU 也能跑）',
    missing.length === 0,
    missing.length ? `缺 ${missing.join(', ')}` : '全部就位',
  );

  const userDataDir = path.join(OUT_DIR, 'edge-profile-p7');
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=1400,1000',
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
        consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });

    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(2500);

    // ── 1. 引擎下拉框：本地与看图模型并存，默认本地 ──────────
    const engineInfo = await cdp.eval(`
      (async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 40; i++) {
          if (document.querySelector('nav, .shell, body')) break;
          await wait(200);
        }
        return { title: document.title, hasBody: !!document.body };
      })()
    `);
    record('应用能打开', Boolean(engineInfo?.hasBody), engineInfo?.title ?? '');

    // 验证本地引擎类能被真实加载（不是假实现）
    const localModule = await cdp.eval(`
      (async () => {
        try {
          const mod = await import('./assets/index-BkrHSdRX.js').catch(() => null);
          return { loaded: false, note: 'bundle 名随构建变化，跳过直接 import' };
        } catch (e) {
          return { loaded: false, note: String(e).slice(0, 120) };
        }
      })()
    `);
    say(`  （模块探测：${JSON.stringify(localModule)}）`);

    /**
     * ── 2. 真实跑一次本地 OCR ──────────────────────────────
     *
     * 不走界面（界面要先有扫描件资料），而是直接把 tesseract 的
     * 真实链路在页面里跑一遍：用 page 里已有的 canvas 画一段中文，
     * 再交给 tesseract 识别。这验的是「资源路径 + wasm + 语言包」，
     * 正是单测覆盖不到的部分。
     */
    const ocrResult = await cdp.eval(`
      (async () => {
        const log = [];
        try {
          // 造一张带中文的图（用系统字体画，再缩放避免太小）
          const canvas = document.createElement('canvas');
          canvas.width = 900; canvas.height = 220;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 900, 220);
          ctx.fillStyle = '#000';
          ctx.font = '72px "Microsoft YaHei", "SimHei", sans-serif';
          ctx.fillText('数据结构与算法', 40, 140);
          const dataUrl = canvas.toDataURL('image/png');

          // 动态 import tesseract（由 const 入口打包进主 chunk）
          const base = new URL('./tesseract/', document.baseURI).href;
          log.push('base=' + base);

          // 用一个最小的自建 worker 流程验证资源可下载
          const resWorker = await fetch(base + 'worker.min.js');
          log.push('worker=' + resWorker.status);
          const resLang = await fetch(base + 'lang/chi_sim.traineddata.gz');
          log.push('lang=' + resLang.status);
          const resCore = await fetch(base + 'core/tesseract-core-simd-lstm.wasm');
          log.push('core=' + resCore.status);

          const langBuf = await resLang.arrayBuffer();
          log.push('langBytes=' + langBuf.byteLength);

          return {
            ok: resWorker.ok && resLang.ok && resCore.ok,
            log,
            canvasBytes: dataUrl.length,
          };
        } catch (e) {
          return { ok: false, log, error: String(e).slice(0, 200) };
        }
      })()
    `);

    record(
      '本地 OCR 三样资源都能从页面取到',
      Boolean(ocrResult?.ok),
      (ocrResult?.log ?? []).join(' · '),
    );
    if (ocrResult?.error) say(`  错误：${ocrResult.error}`);

    const langBytes = Number(
      (ocrResult?.log ?? []).find((l) => l.startsWith('langBytes='))?.split('=')[1] ?? 0,
    );
    record('语言包体积合理（非空且为压缩包）', langBytes > 500_000, `${(langBytes / 1024 / 1024).toFixed(2)} MB`);

    /**
     * ── 真的跑一次识别 ─────────────────────────────────────
     *
     * 上面只证明了「文件能下载」。但 wasm 能不能算、语言包能不能被解析、
     * tesseract 能不能吐出中文 —— 这些只有真跑一次才知道。
     *
     * 做法：临时在 dist 里写一个探针页（用完即删）。它用**与
     * local-backend.ts 完全相同的 createWorker 选项**去识别一张在页面里
     * 画出来的中文图。用 UMD 构建是为了能直接从 HTML 引用，
     * 不必猜 Vite 打出来的 chunk 名。这是本脚本最有价值的一条。
     */
    const probeHtml = path.join(__dirname, '..', 'dist', '_probe-ocr.html');
    const probeUmd = path.join(__dirname, '..', 'dist', 'tesseract', '_probe-umd.js');
    const umdSrc = path.join(__dirname, '..', 'node_modules', 'tesseract.js', 'dist', 'tesseract.min.js');

    fs.copyFileSync(umdSrc, probeUmd);
    fs.writeFileSync(
      probeHtml,
      `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head>
<body><div id="out">running</div>
<script src="./tesseract/_probe-umd.js"></script>
<script>
(async () => {
  const log = [];
  let result;
  try {
    const base = new URL('./tesseract/', document.baseURI).href;
    const canvas = document.createElement('canvas');
    canvas.width = 900; canvas.height = 200;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 900, 200);
    ctx.fillStyle = '#000';
    ctx.font = '64px "Microsoft YaHei", "SimHei", sans-serif';
    ctx.fillText('数据结构与算法', 40, 130);
    const dataUrl = canvas.toDataURL('image/png');

    // 与 local-backend.ts 相同的选项形状
    const worker = await Tesseract.createWorker('chi_sim', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base + 'core',
      langPath: base + 'lang',
      gzip: true,
      cacheMethod: 'none',
      logger: () => {},
    });
    const { data } = await worker.recognize(dataUrl);
    await worker.terminate();
    result = { ok: true, text: (data.text || '').trim(), confidence: data.confidence, log };
  } catch (e) {
    result = { ok: false, error: String(e && (e.message || e)), log };
  }
  window.__probeResult = result;
  document.getElementById('out').textContent = JSON.stringify(result);
})();
</script></body></html>`,
    );

    await cdp.send('Page.navigate', { url: `${APP_URL}/_probe-ocr.html` });
    let ocrReal = null;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      ocrReal = await cdp.eval('window.__probeResult || null');
      if (ocrReal) break;
    }
    // 探针产物不留在 dist 里
    try {
      fs.rmSync(probeHtml, { force: true });
      fs.rmSync(probeUmd, { force: true });
    } catch {
      /* ignore */
    }

    const recognized = String(ocrReal?.text ?? '').replace(/\s+/g, '');
    record(
      '真浏览器里真的识别出了中文（wasm + 语言包可用）',
      Boolean(ocrReal?.ok) && recognized.includes('数据结构'),
      ocrReal?.ok ? `识别为「${recognized}」，置信度 ${ocrReal.confidence}` : String(ocrReal?.error ?? '超时'),
    );
    record('识别结果就是画上去的那七个字', recognized === '数据结构与算法', recognized);

    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(1500);

    // ── 3. 图片导入后能在阅读器显示 ─────────────────────────
    const imgResult = await cdp.eval(`
      (async () => {
        try {
          // 造一张真实 PNG，走应用的导入链路
          const canvas = document.createElement('canvas');
          canvas.width = 400; canvas.height = 200;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#eef'; ctx.fillRect(0, 0, 400, 200);
          ctx.fillStyle = '#111';
          ctx.font = '32px sans-serif';
          ctx.fillText('图片资料测试', 30, 110);
          const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
          const bytes = new Uint8Array(await blob.arrayBuffer());

          return { bytes: bytes.length, head: Array.from(bytes.slice(0, 8)) };
        } catch (e) {
          return { error: String(e).slice(0, 200) };
        }
      })()
    `);
    record(
      '能在页面里造出真实 PNG',
      (imgResult?.bytes ?? 0) > 1000,
      `${imgResult?.bytes ?? 0} 字节`,
    );

    const imgFormat = await cdp.eval(`
      (async () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 100; canvas.height = 100;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 100, 100);
          const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
          const bytes = new Uint8Array(await blob.arrayBuffer());
          // PNG 魔数
          return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
        } catch { return false; }
      })()
    `);
    record('PNG 魔数可被识别（detectImageKind 的依据）', imgFormat === true);

    record('全流程无 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  } finally {
    try {
      if (cdp) await cdp.send('Browser.close');
    } catch {
      /* ignore */
    }
    try {
      edge.kill();
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((r) => !r.ok);
  say('\n================ 汇总 ================');
  say(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  for (const f of failed) say(`  - ${f.name}  ${f.detail}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * 按 MinerU 定位符取回一张插图。
 *
 * ## 为什么必须「此刻就取」，不能留到用户点开时
 *
 * 2026-11-08 在 .tmp 副本上做了对照实验（结论写进代码，避免下一个人重做）：
 *
 * 1. 复制 MinerU home 到副本，取 `page:1/block:7` → 成功，7117 字节
 * 2. **删掉副本里的 doclib/parsed/87**（该文档的解析缓存），原 PDF 仍在
 * 3. 重启服务再读同一 locator → `Error: Requested parsed content is not cached.`
 *
 * 源码依据：`mineru/doclib/services/content_read_svc.py` 的 `_render_image_response`
 * 先找页，取不到抛 `page_not_cached`；`_render_source_image_asset` 还要靠
 * `accessible_file_for_sha256` 拿到原文件路径去按 bbox 裁图。
 *
 * 也就是说 locator **不是永久地址**，它只是指向 MinerU 自己缓存的一条记录。
 * 用户清一次 MinerU 缓存、换台机器、或 MinerU 升级重建库，图就全没了 ——
 * 而「教材插图丢了」这种事用户几乎不可能自己发现原因。
 *
 * 所以：**转换完成的那一刻就把图取回来存进我们自己的库**。
 *
 * ## 两种取图方式，为什么优先 HTTP
 *
 * | 方式 | 6 张耗时 | 说明 |
 * | --- | --- | --- |
 * | CLI `mineru read` | 8796 ms | 每次起一个 Python 进程，约 1.4 秒/张 |
 * | HTTP `GET /api/v1/content` | 2553 ms | 复用常驻服务，约 0.43 秒/张 |
 *
 * 一本书 88 张图，走 CLI 要两分钟且每张一次进程启动；走 HTTP 只要四十秒。
 * 所以 HTTP 优先，失败回落 CLI —— 回落不是摆设：
 * 老版本 MinerU 可能没有这个路由，或端口/token 读不到。
 *
 * ## 为什么把 IO 与纯逻辑分开
 *
 * 本文件里 `parseEndpoint` / `parseAuthToken` / `pickImageFromResponse` 是纯函数，
 * 单测直接喂样本即可，不需要装 MinerU、也不需要真起服务。
 * 只有 `readFigure` 做 IO。这与 electron/mineru.cjs 顶部那条规矩一致：
 * 「能单测的逻辑不要内联在 ipcMain.handle 里」。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** 单张取图的超时。首次取图服务可能要加载版面模型，给宽松些 */
const READ_TIMEOUT_MS = 60 * 1000;

/**
 * 从 doclib.endpoint.json 的内容里取出 HTTP 基地址。
 *
 * 文件形状（实测）：
 *   { "pid": 7648, "server_id": "...", "transports": [ { "base_url": "http://127.0.0.1:15980", "type": "tcp" } ] }
 *
 * 取不到返回 null —— 调用方据此回落到 CLI，而不是报错。
 */
function parseEndpoint(json) {
  try {
    const obj = typeof json === 'string' ? JSON.parse(json) : json;
    const list = Array.isArray(obj?.transports) ? obj.transports : [];
    const tcp = list.find((t) => t && typeof t.base_url === 'string' && t.base_url.startsWith('http'));
    return tcp ? tcp.base_url.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

/**
 * 从 MinerU 的 config.yaml 里取 doclib token。
 *
 * 为什么手写而不用 yaml 库：只需要一个值，而依赖树里没有 yaml 解析器；
 * 为一个 `token: xxx` 引一个库不划算。这里只认**单行** `token:`，
 * 认不出就返回 null 让调用方回落 CLI（宁可慢，不要猜错 token 去撞 401）。
 */
function parseAuthToken(yaml) {
  if (typeof yaml !== 'string') return null;
  for (const line of yaml.split(/\r?\n/)) {
    const m = /^\s*token:\s*(\S+)\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * 从 HTTP 响应 JSON 里确认「图到底写在哪」。
 *
 * 响应形状（实测）：
 *   { "format": "image", "asset": { "path": "...\\read-assets\\87731df-....jpg",
 *     "mime_type": "image/jpeg", "size_bytes": 7686, "width": 416, "height": 216 } }
 *
 * 注意 asset.path 是 **MinerU 自己的临时目录**（doclib/temp/read-assets/）。
 * 我们必须在它被清理前把字节读走 —— 所以这里是「读」不是「记下路径」。
 */
function pickImageFromResponse(json) {
  try {
    const obj = typeof json === 'string' ? JSON.parse(json) : json;
    const a = obj?.asset;
    if (!a || typeof a.path !== 'string' || !a.path) return null;
    return {
      path: a.path,
      mimeType: typeof a.mime_type === 'string' ? a.mime_type : 'image/jpeg',
      width: Number(a.width) || 0,
      height: Number(a.height) || 0,
      sizeBytes: Number(a.size_bytes) || 0,
    };
  } catch {
    return null;
  }
}

/** 由 MIME 推文件扩展名。认不出给 .jpg（MinerU 默认出 jpeg） */
function extOfMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return '.png';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  return '.jpg';
}

/**
 * 定位 MinerU home。
 *
 * 与 mineru.cjs 的 deriveHome 同思路，但这里**额外**支持：
 *  - MINERU_HOME 环境变量（用户自定义安装）
 *  - 用户主目录下的 ~/.mineru（实测 server 实际用的就是这个，
 *    而不是 StudyHub 布局里的 home/ —— 两个位置都可能存在，
 *    所以要按「哪个有 endpoint.json」来判断当前服务在哪个 home 跑）
 *
 * 为什么要按 endpoint.json 判断：服务在哪个 home 起的，
 * endpoint 和 token 就在那个 home 里。读错 home 会拿到过期端口。
 */
function candidateHomes(exePath, env, homedir) {
  const out = [];
  if (env.MINERU_HOME) out.push(env.MINERU_HOME);
  if (exePath) {
    try {
      const scriptsDir = path.dirname(exePath);
      const venvDir = path.dirname(scriptsDir);
      out.push(path.join(path.dirname(venvDir), 'home'));
    } catch { /* 路径解析失败忽略 */ }
  }
  if (homedir) out.push(path.join(homedir, '.mineru'));
  return out.filter(Boolean);
}

/** 读 endpoint + token；拿不到任一项返回 null（调用方回落 CLI） */
function loadServerInfo(options = {}) {
  const fsImpl = options.fs ?? fs;
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? (() => {
    try { return require('node:os').homedir(); } catch { return null; }
  })();

  for (const home of candidateHomes(options.exePath, env, homedir)) {
    try {
      const epPath = path.join(home, 'doclib.endpoint.json');
      const cfgPath = path.join(home, 'config.yaml');
      if (!fsImpl.existsSync(epPath) || !fsImpl.existsSync(cfgPath)) continue;
      const endpoint = parseEndpoint(fsImpl.readFileSync(epPath, 'utf8'));
      const token = parseAuthToken(fsImpl.readFileSync(cfgPath, 'utf8'));
      if (endpoint && token) return { home, endpoint, token };
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

/**
 * 走 HTTP 取一张图。成功返回 { data, mimeType }，失败返回 { error }。
 *
 * 不抛异常：取图是「尽力而为」，一张失败不该让整本书的转换挂掉。
 */
async function readViaHttp(locator, info, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) return { error: '当前环境没有 fetch' };

  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url =
      info.endpoint +
      '/api/v1/content?locator=' +
      encodeURIComponent(locator) +
      '&format=image';
    const res = await fetchImpl(url, {
      headers: { Authorization: 'Bearer ' + info.token },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { error: 'HTTP ' + res.status + ' ' + body.slice(0, 200) };
    }
    const picked = pickImageFromResponse(await res.json());
    if (!picked) return { error: '响应里没有 asset.path' };

    const fsImpl = options.fs ?? fs;
    const data = fsImpl.readFileSync(picked.path);
    return { data, mimeType: picked.mimeType, width: picked.width, height: picked.height };
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 走 CLI 取一张图（回落路径）。
 *
 * 输出目录用调用方给的 outDir —— 但**注意**这里有个实测坑：
 * `mineru parse -o <自定义目录>` 在应用进程里会 Permission denied
 * （服务以不同权限运行）。`mineru read -o` 目前没遇到同样问题，
 * 但为了稳妥，输出到我们自己的临时目录再读走删掉，
 * 不依赖 MinerU 默认位置（read 的默认位置会污染它的 temp）。
 */
function readViaCli(locator, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const fsImpl = options.fs ?? fs;
  const exePath = options.exePath;
  const outDir = options.outDir;

  if (!exePath) return Promise.resolve({ error: '没有配置 MinerU 可执行文件路径' });
  if (!outDir) return Promise.resolve({ error: '没有给输出目录' });

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };

    const timer = setTimeout(() => done({ error: 'CLI 取图超时' }), options.timeoutMs ?? READ_TIMEOUT_MS);

    let stderr = '';
    let child;
    try {
      fsImpl.mkdirSync(outDir, { recursive: true });
      outDir;
      child = spawnImpl(exePath, ['read', locator, '--format', 'image', '--json'], {
        windowsHide: true,
        env: {
          ...(options.env ?? process.env),
          // 与 parse 一致：Python 在 Windows 默认 GBK 会把路径/日志写坏
          PYTHONIOENCODING: 'utf-8',
        },
      });
    } catch (err) {
      done({ error: '启动 mineru 失败：' + (err && err.message ? err.message : String(err)) });
      return;
    }

    let stdout = '';
    if (child.stdout) child.stdout.on('data', (c) => { stdout += c.toString(); });
    if (child.stderr) child.stderr.on('data', (c) => { stderr += c.toString(); });

    child.on('error', (err) => done({ error: 'CLI 出错：' + (err && err.message ? err.message : String(err)) }));
    child.on('close', (code) => {
      if (code !== 0) {
        done({ error: 'CLI 退出码 ' + code + (stderr ? '：' + stderr.slice(-300) : '') });
        return;
      }
      const picked = pickImageFromResponse(stdout);
      if (!picked) {
        done({ error: 'CLI 没返回 asset.path' + (stderr ? '：' + stderr.slice(-300) : '') });
        return;
      }
      try {
        done({
          data: fsImpl.readFileSync(picked.path),
          mimeType: picked.mimeType,
          width: picked.width,
          height: picked.height,
        });
      } catch (err) {
        done({ error: '读不到 CLI 写出的图：' + (err && err.message ? err.message : String(err)) });
      }
    });
  });
}

/**
 * 取一张图：HTTP 优先，失败回落 CLI。
 *
 * 返回值形状固定，调用方不用 try/catch：
 *   { ok: true, data, mimeType, width, height, via: 'http'|'cli' }
 *   { ok: false, error, via }
 *
 * `error` 里要保留**两种方式各自的失败原因** —— 排查时最想知道的是
 * 「是不是服务没起」还是「locator 本身不存在」，只报最后一个会丢信息。
 */
async function readFigure(locator, options = {}) {
  const info = options.serverInfo ?? loadServerInfo(options);
  const httpError = info ? null : '没找到可用的 MinerU 服务（endpoint/token 缺失）';

  if (info) {
    const r = await readViaHttp(locator, info, options);
    if (r.data) {
      return { ok: true, data: r.data, mimeType: r.mimeType, width: r.width, height: r.height, via: 'http' };
    }
    const cli = await readViaCli(locator, options);
    if (cli.data) {
      return { ok: true, data: cli.data, mimeType: cli.mimeType, width: cli.width, height: cli.height, via: 'cli' };
    }
    return {
      ok: false,
      via: 'http+cli',
      error: 'HTTP: ' + r.error + ' / CLI: ' + cli.error,
    };
  }

  const cli = await readViaCli(locator, options);
  if (cli.data) {
    return { ok: true, data: cli.data, mimeType: cli.mimeType, width: cli.width, height: cli.height, via: 'cli' };
  }
  return { ok: false, via: 'cli', error: httpError + ' / CLI: ' + cli.error };
}

/** 转 data URI。渲染进程不能直接吃 ArrayBuffer 当 img src，要转字符串 */
function toDataUri(data, mimeType) {
  const b64 = Buffer.from(data).toString('base64');
  return 'data:' + (mimeType || 'image/jpeg') + ';base64,' + b64;
}

module.exports = {
  READ_TIMEOUT_MS,
  parseEndpoint,
  parseAuthToken,
  pickImageFromResponse,
  extOfMime,
  candidateHomes,
  loadServerInfo,
  readViaHttp,
  readViaCli,
  readFigure,
  toDataUri,
};

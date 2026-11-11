/**
 * MinerU 一键安装引擎（2026-11-11 晚）。
 *
 * ## 为什么要有这个文件
 *
 * 原来的做法是「给用户一段 pip 命令，让他自己装」。问题是：
 * 普通用户没有 Python、不懂配环境、不知道什么叫 venv。
 * 用户原话：「要是用户不知道怎么安装python，不懂配置环境怎么办」。
 *
 * ## 为什么不需要用户装 Python
 *
 * 不是我们发明的方案 —— 是本机已有的那个 MinerU 就是这么装的：
 *
 *   E:\StudyHub\MinerU\python\cpython-3.12.15-windows-x86_64-none  ← 独立 Python
 *   E:\StudyHub\MinerU\tools\uv.exe                                 ← 独立 uv
 *   E:\StudyHub\MinerU\venv\pyvenv.cfg → include-system-site-packages = false
 *
 * 那个独立 Python 是 astral-sh/python-build-standalone 的产物
 * （https://github.com/astral-sh/python-build-standalone ，uv 官方用它管 Python）。
 * 而 uv 自己会下 Python：实测 `uv python list` 输出里带 `<download available>`。
 *
 * 所以流程是：下一个 uv.exe → 让它下 Python → 建 venv → 装包 → 下模型。
 * **全程不碰系统 Python、不写注册表、不要管理员权限。**
 *
 * ## 为什么必须支持「选目录」，且只能选一次
 *
 * 用户要求：「安装模型时能让用户先选择空间充足的磁盘安装」。
 *
 * 但 venv 建好之后**不能搬迁**：`pyvenv.cfg` 的 home 与 Scripts 下的
 * exe 启动器都写死了绝对路径（实测 mineru-kit.exe 里能 grep 到
 * `E:\StudyHub\MinerU\venv\Scripts\python.exe`）。
 * 所以「选一次」不是偷懒 —— 装完再换目录等于重装。
 *
 * ## 为什么这个文件可以独立跑
 *
 * 交接文档记过：本会话的 Electron 子进程对 AppData 写入有 EPERM，
 * 而普通 node 进程正常。若把安装逻辑只写在 Electron 里，
 * 就会出现「按钮点了没反应」且无法在本会话验证。
 * 所以核心逻辑放在这个纯 node 模块，既能被主进程 require，
 * 也能用 `node scripts/install-mineru.cjs` 单独跑（见同目录的入口脚本）。
 *
 * ## 体积预期（实测，不是估的）
 *
 *   venv 包      588 MB
 *   模型        2002 MB
 *   Python        62 MB
 *   uv + tools    39 MB
 *   ────────────────
 *   合计        2.7 GB
 *
 * 其中模型那 2GB 省不掉 —— 那是解析能力的本体。
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** uv 在 Windows 的下载地址（官方 GitHub Release，固定版本号避免漂移） */
const UV_VERSION = '0.13.1';
const UV_URL =
  `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`;

/**
 * uv 的备用来源：PyPI 上的官方 wheel（**国内镜像可直连**）。
 *
 * ## 为什么需要备用
 *
 * 实测：从 github.com 下那个 15MB 的 zip，会在 6.8MB 处卡住不动，
 * 既不超时也不报错；换成 Clash 代理反而 SSL 握手失败。
 * 而同样这台机器从阿里云 PyPI 镜像下 uv 的 wheel，
 * 21MB 十几秒就下完。
 *
 * uv 官方把完整二进制也发到了 PyPI（`uv` 这个包），
 * wheel 里 `uv-<ver>.data/scripts/uv.exe` 就是我们要的 exe。
 * 所以这里把 PyPI 镜像排第一，GitHub 退到最后 —— 对国内用户更靠谱。
 *
 * 来源：https://pypi.org/project/uv/ （wheel 内含 data/scripts/uv.exe）
 */
const UV_WHEEL_URLS = [
  'https://mirrors.aliyun.com/pypi/simple/uv/',
  'https://pypi.tuna.tsinghua.edu.cn/simple/uv/',
  'https://pypi.org/simple/uv/',
];

/**
 * python-build-standalone 的国内镜像（**镜像根，不带日期**）。
 *
 * ## 为什么必须换源
 *
 * uv 默认从 releases.astral.sh 拉 Python，实测国内只有 22 KB/s
 * （21MB 要下十几分钟，还可能超时中断）。
 * 试过 ghfast.top：连接失败。试过 gh-proxy.com：2.5 KB/s，更慢。
 *
 * ## 为什么镜像地址不能带日期
 *
 * 这个坑我踩了一次：一开始把 `--mirror` 指到
 * `.../python-build-standalone/20260623`，结果 uv 自己在后面又拼了
 * 一层版本日期，变成 `20260623/20261013/cpython-...tar.gz` → 404。
 *
 * uv 拼的完整结构是：
 *   <mirror>/<发布日>/cpython-<ver>+<发布日>-x86_64-pc-windows-msvc-...
 *
 * 所以必须给**根**：
 *   https://mirror.nju.edu.cn/github-release/astral-sh/python-build-standalone
 * 实测这样 7.12 秒装完（21MB），而官方源要十几分钟。
 */
const PBS_MIRROR_ROOT =
  'https://mirror.nju.edu.cn/github-release/astral-sh/python-build-standalone';

/**
 * 下载时的「无进展超时」（毫秒）。
 *
 * ## 为什么必须有
 *
 * 实测踩到的真问题：下载到 6.8MB 后连接不动了，
 * 而 `reader.read()` 既不返回也不抛错 —— 整个安装卡在那里，
 * 用户看到的是「进度条停在 6.8MB」，永远不动。
 *
 * 只看总耗时不行（2GB 模型正常就要几十分钟），
 * 所以判断标准是「**多久没有收到任何新字节**」。
 */
const STALL_TIMEOUT_MS = 45_000;

/**
 * 国内 PyPI 镜像。
 *
 * 为什么内置而不是让用户填：安装失败的绝大多数原因是 PyPI 慢/断，
 * 不是包本身有问题。给默认值，让「一键」真的是一键。
 */
const PYPI_MIRRORS = [
  'https://mirrors.aliyun.com/pypi/simple',
  'https://pypi.tuna.tsinghua.edu.cn/simple',
  'https://pypi.org/simple',
];

/** 模型源：ModelScope 在国内明显比 HuggingFace 稳（本机 config.yaml 用的就是它） */
const MODEL_SOURCE = 'modelscope';

/**
 * 装之前至少要留这么多空间。
 *
 * 实测总量 2.7GB。留 300MB 余量 → 3GB。
 * 为什么要留余量：uv 下载时用临时文件、pip 解压 wheel 也要空间，
 * 卡着 2.7GB 正好会在最后一步「磁盘已满」。
 */
const REQUIRED_FREE_BYTES = 3 * 1024 * 1024 * 1024;

/** 目录布局：全部落在用户选的 root 下，不散落各盘 */
function layout(root) {
  return {
    root,
    uvExe: path.join(root, 'tools', 'uv.exe'),
    toolsDir: path.join(root, 'tools'),
    pythonDir: path.join(root, 'python'),
    venvDir: path.join(root, 'venv'),
    homeDir: path.join(root, 'home'),
    modelsDir: path.join(root, 'home', 'models'),
    configFile: path.join(root, 'home', 'config.yaml'),
    /*
     * uv 的缓存目录也放在 root 下（2026-11-11 晚）。
     *
     * ## 为什么必须显式指定
     *
     * uv 默认把缓存写到 `%LOCALAPPDATA%\uv\cache`。
     * 实测在受限环境里这一步会失败：
     *   error: Could not acquire lock
     *   cause: failed to open file `...\AppData\Local\uv\cache\.lock`:
     *          拒绝访问。 (os error 5)
     *
     * 而且就算不失败，把几百 MB 的 wheel 缓存留在 C 盘也违背了
     * 「装到我选的那个盘」这个承诺。所以缓存跟安装目录走。
     */
    cacheDir: path.join(root, 'cache'),
    /*
     * ModelScope 的缓存目录（2026-11-11 晚）。
     *
     * ## 为什么必须显式指定
     *
     * ModelScope 默认把模型拉到 `%USERPROFILE%\.cache\modelscope`。
     * 实测在这一步整批失败：
     *   [WinError 5] 拒绝访问。:
     *   'C:\Users\ASUS\.cache\modelscope\.lock\file_xxx.lock'
     *
     * 而且从设计上讲，把 2GB 模型放在 C 盘用户目录，
     * 也违背了「装到我选的那个盘」这个承诺。
     *
     * 注意 MinerU 自己的 `model.base_dir`（config.yaml）决定**最终**模型位置，
     * 但下载过程中的临时缓存与 .lock 仍然听 MODELSCOPE_CACHE 的。
     * 两个都要设，才能既落到对的盘、又不碰 C 盘的锁文件。
     */
    modelscopeCache: path.join(root, 'cache', 'modelscope'),
    /* venv 里最终产物 */
    mineruExe: path.join(root, 'venv', 'Scripts', 'mineru.exe'),
    mineruKitExe: path.join(root, 'venv', 'Scripts', 'mineru-kit.exe'),
  };
}

/**
 * 跑 uv 时统一要带的环境变量。
 *
 * 两件事都别省：
 *  1. UV_CACHE_DIR —— 否则往 C 盘的 AppData 写，受限环境直接 EPERM
 *  2. UV_PYTHON_INSTALL_DIR —— 让 Python 落到用户选的盘，不落到 %APPDATA%\uv
 */
function uvEnv(L) {
  return {
    UV_CACHE_DIR: L.cacheDir,
    UV_PYTHON_INSTALL_DIR: L.pythonDir,
    /* 不让 uv 去改系统 Python 或用户级配置 */
    UV_PYTHON_PREFERENCE: 'only-managed',
  };
}

/* ========================================================================== */
/* 磁盘空间                                                                    */
/* ========================================================================== */

/**
 * 列出所有本地固定磁盘及其剩余空间。
 *
 * 用 `fs.statfsSync`（Node 18+）—— 不需要额外依赖，也不需要管理员权限。
 * 实测这台机器：E: 剩 98.2 GB，C: 剩 31.4 GB。
 *
 * ⚠️ 只列「盘符根」不递归：列子目录的剩余空间对用户没意义（同一个盘）。
 */
function listDrives(options = {}) {
  const statfs =
    options.statfsSync ??
    ((p) => {
      try {
        return fs.statfsSync(p);
      } catch {
        return null;
      }
    });

  const out = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    const root = `${letter}:\\`;
    let st = null;
    try {
      st = statfs(root);
    } catch {
      st = null;
    }
    if (!st) continue;
    const free = Number(st.bavail) * Number(st.bsize);
    const total = Number(st.blocks) * Number(st.bsize);
    if (!Number.isFinite(free) || total <= 0) continue;
    out.push({
      root,
      letter,
      freeBytes: free,
      totalBytes: total,
      /* 够不够装：界面据此置灰，用户不用自己算 */
      enough: free >= REQUIRED_FREE_BYTES,
    });
  }
  return out;
}

/** 某个具体目录所在盘的剩余空间（用于「已选目录是否还够」的复查） */
function freeBytesAt(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    /* 目录还不存在：往上找到一个存在的祖先再问 */
    let p = dir;
    for (let i = 0; i < 12; i++) {
      p = path.dirname(p);
      if (!p || p === path.dirname(p)) break;
      try {
        if (!fs.existsSync(p)) continue;
        const st = fs.statfsSync(p);
        return Number(st.bavail) * Number(st.bsize);
      } catch {
        continue;
      }
    }
    return null;
  }
}

/* ========================================================================== */
/* 运行外部命令                                                                */
/* ========================================================================== */

/**
 * 跑一个命令并逐行回调输出。
 *
 * 为什么不 `execSync`：下载模型要几十分钟，同步调用会把主进程卡死，
 * 界面完全无响应。必须有实时输出才能显示进度。
 *
 * @returns {Promise<{code:number, out:string}>} 不抛异常 —— 调用方据 code 判定
 */
function run(exe, args, options = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...(options.env ?? {}) };
    let child;
    try {
      child = spawn(exe, args, { env, windowsHide: true, cwd: options.cwd });
    } catch (e) {
      resolve({ code: -1, out: `启动失败: ${e.message}` });
      return;
    }

    let buf = '';
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      buf += text;
      /* 按行切开回调，最后一行可能不完整，留在 buf 里等下一块 */
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i] !== '') options.onLine?.(lines[i]);
      }
      options.onChunk?.(text);
      /* 防止超长输出撑爆内存：只留最后 200KB 供报错时截取 */
      if (buf.length > 200_000) buf = buf.slice(-200_000);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('error', (e) => resolve({ code: -1, out: `启动失败: ${e.message}` }));
    child.on('close', (code) => resolve({ code: code ?? -1, out: buf }));

    options.onSpawn?.(child);
  });
}

/* ========================================================================== */
/* 下载                                                                        */
/* ========================================================================== */

/**
 * 下载一个 URL 到文件，支持断点续传与进度回调。
 *
 * ## 为什么必须支持续传
 *
 * 模型 2GB。国内网络下断一次就前功尽弃，用户会崩溃。
 * 用 HTTP Range 请求接上已有部分（服务器不支持 Range 时退回整下）。
 *
 * @returns {Promise<{ok:boolean, bytes:number, error?:string}>}
 */
async function download(url, dest, options = {}) {
  const onProgress = options.onProgress;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  /*
   * 无进展超时（实测必须要，见 STALL_TIMEOUT_MS 的注释）。
   * 测试里可以传小值，生产默认 45 秒。
   */
  const stallMs = options.stallTimeoutMs ?? STALL_TIMEOUT_MS;

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let startAt = 0;
  try {
    startAt = fs.statSync(dest).size;
  } catch {
    startAt = 0;
  }

  const headers = {};
  if (startAt > 0) headers.Range = `bytes=${startAt}-`;

  /* 用 AbortController 兜住「连接建不起来」的情况 */
  const ctrl = new AbortController();
  let stallTimer = null;
  const bumpStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ctrl.abort(), stallMs);
  };

  let res;
  try {
    bumpStall();
    res = await fetchImpl(url, { headers, redirect: 'follow', signal: ctrl.signal });
  } catch (e) {
    if (stallTimer) clearTimeout(stallTimer);
    return { ok: false, bytes: startAt, error: `网络请求失败: ${e.message}` };
  }

  if (res.status === 416) {
    if (stallTimer) clearTimeout(stallTimer);
    /* 已下完（服务器认为我们的起点等于文件大小） */
    return { ok: true, bytes: startAt };
  }
  if (res.status >= 300) {
    if (stallTimer) clearTimeout(stallTimer);
    return { ok: false, bytes: startAt, error: `HTTP ${res.status}` };
  }

  /* 服务器不支持 Range 时它会返回 200 和完整body —— 那就从头写 */
  const appending = startAt > 0 && res.status === 206;
  if (!appending) startAt = 0;

  const totalHeader = res.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) + startAt : null;

  const fd = fs.openSync(dest, appending ? 'a' : 'w');
  let written = startAt;
  try {
    const reader = res.body.getReader();
    for (;;) {
      bumpStall();
      const { done, value } = await reader.read();
      if (done) break;
      fs.writeSync(fd, Buffer.from(value));
      written += value.length;
      onProgress?.({ downloaded: written, total });
    }
  } catch (e) {
    /*
     * 区分「网断了」与「卡住不动」——
     * 后者是 AbortError，用户需要知道是超时而不是网络错误。
     */
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
    return {
      ok: false,
      bytes: written,
      error: aborted
        ? `下载卡住了（${Math.round(stallMs / 1000)} 秒没有新数据）`
        : `下载中断: ${e.message}`,
      stalled: aborted,
    };
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    fs.closeSync(fd);
  }

  return { ok: true, bytes: written };
}

/* ========================================================================== */
/* 获取 uv.exe                                                                 */
/* ========================================================================== */

/**
 * 从 PyPI 镜像取 uv（首选路径）。
 *
 * ## 为什么不直接下 GitHub 的 zip
 *
 * 实测：github.com 那个 15MB zip 下到 6.8MB 就卡死；
 * 而阿里云 PyPI 镜像下 uv 的 wheel（21MB）十几秒完成。
 * uv 官方把完整二进制发到了 PyPI，wheel 内
 * `uv-<ver>.data/scripts/uv.exe` 就是需要的 exe。
 *
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function fetchUvFromPyPI(L, options = {}) {
  const { onLine, onProgress, fetchImpl } = options;

  /* 1. 从镜像的 simple 索引里找 win_amd64 的 wheel 链接 */
  let wheelUrl = null;
  for (const base of UV_WHEEL_URLS) {
    let html = null;
    try {
      const r = await (fetchImpl ?? globalThis.fetch)(base, {
        signal: AbortSignal.timeout(20_000),
      });
      if (r.status < 300) html = await r.text();
    } catch {
      html = null;
    }
    if (!html) {
      onLine?.(`索引不可达：${base}`);
      continue;
    }
    /* 取最新的 win_amd64 wheel（版本号最大的那个） */
    const re = /href="([^"]*uv-(\d+\.\d+\.\d+)-py3-none-win_amd64\.whl[^"]*)"/g;
    const found = [];
    for (const m of html.matchAll(re)) {
      found.push({ href: m[1], ver: m[2] });
    }
    if (found.length === 0) continue;
    found.sort((a, b) => {
      const pa = a.ver.split('.').map(Number);
      const pb = b.ver.split('.').map(Number);
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
      return 0;
    });
    const pick = found[0];
    /* href 可能是相对路径（../..//packages/...） */
    wheelUrl = new URL(pick.href.split('#')[0], base).toString();
    onLine?.(`从 ${new URL(base).host} 取 uv ${pick.ver}`);
    break;
  }

  if (!wheelUrl) return { ok: false, error: '三个 PyPI 镜像都没有找到 uv 的 wheel' };

  /* 2. 下载 wheel */
  const wheelPath = path.join(L.toolsDir, 'uv.whl');
  const dl = await download(wheelUrl, wheelPath, { onProgress, fetchImpl });
  if (!dl.ok) return { ok: false, error: dl.error };

  /* 3. 从 wheel 里抽出 uv.exe（wheel 本质就是 zip） */
  /*
   * ⚠️ 必须先把 .whl 复制成 .zip 再解压。
   *
   * 实测踩到的：PowerShell 的 Expand-Archive 会按扩展名白名单判定，
   * 对 .whl 直接报 `NotSupportedArchiveFileExtension`。
   * 换成 .zip 扩展名它才认。
   */
  const wheelZip = path.join(L.toolsDir, 'uv-wheel.zip');
  try {
    fs.copyFileSync(wheelPath, wheelZip);
  } catch (e) {
    return { ok: false, error: `复制 wheel 失败：${e.message}` };
  }

  const tmp = path.join(L.toolsDir, '_whl');
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
  } catch { /* 已存在就算了 */ }

  const un = await run(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${wheelZip.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`],
    { onLine },
  );
  try { fs.unlinkSync(wheelZip); } catch { /* ignore */ }
  try { fs.unlinkSync(wheelPath); } catch { /* ignore */ }

  if (un.code !== 0) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, error: `解压 wheel 失败：${un.out.slice(-300)}` };
  }

  /* 找 uv.exe：在 <name>.data/scripts/uv.exe */
  let src = null;
  try {
    for (const dir of fs.readdirSync(tmp)) {
      const cand = path.join(tmp, dir, 'scripts', 'uv.exe');
      if (fs.existsSync(cand)) { src = cand; break; }
    }
  } catch { /* ignore */ }

  if (!src) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, error: 'wheel 里没找到 uv.exe' };
  }

  try {
    fs.copyFileSync(src, L.uvExe);
  } catch (e) {
    return { ok: false, error: `复制 uv.exe 失败：${e.message}` };
  }

  /* 清理中间产物 */
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.unlinkSync(wheelPath); } catch { /* ignore */ }

  return { ok: true };
}

/** 从 GitHub 官方 Release 取 uv（备用路径，zip 形式） */
async function fetchUvFromGitHub(L, options = {}) {
  const { onLine, onProgress, fetchImpl } = options;
  const zip = path.join(L.toolsDir, 'uv.zip');
  const dl = await download(UV_URL, zip, { onProgress, fetchImpl });
  if (!dl.ok) return { ok: false, error: dl.error };

  const un = await run(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${L.toolsDir.replace(/'/g, "''")}' -Force`],
    { onLine },
  );
  if (un.code !== 0) return { ok: false, error: `解压 uv 失败：${un.out.slice(-300)}` };
  try { fs.unlinkSync(zip); } catch { /* ignore */ }
  return { ok: true };
}

/**
 * 取 uv.exe：先 PyPI 镜像（国内稳），失败再退 GitHub 官方。
 *
 * 两个来源都试过才报失败 —— 并且把两条路径各自的错因都带上，
 * 用户才知道是网络问题还是别的。
 */
async function ensureUv(L, options = {}) {
  if (fs.existsSync(L.uvExe)) return { ok: true, source: 'cached' };

  const errs = [];

  options.onLine?.('尝试从 PyPI 镜像获取 uv（国内通常更快）…');
  const a = await fetchUvFromPyPI(L, options);
  if (a.ok && fs.existsSync(L.uvExe)) return { ok: true, source: 'pypi' };
  errs.push(`PyPI 镜像：${a.error}`);

  options.onLine?.('PyPI 镜像没成功，改试 GitHub 官方…');
  const b = await fetchUvFromGitHub(L, options);
  if (b.ok && fs.existsSync(L.uvExe)) return { ok: true, source: 'github' };
  errs.push(`GitHub：${b.error}`);

  return { ok: false, error: errs.join('；') };
}

/* ========================================================================== */
/* 已有 MinerU 的检测（A 方案）                                                 */
/* ========================================================================== */

/**
 * 探测本机是否**已经有一份可用的 MinerU**（2026-11-11 晚，用户选 A 方案）。
 *
 * ## 为什么必须先探测
 *
 * MinerU 的 server 是**全局单例**：它按 `%USERPROFILE%\.mineru` 判断
 * 「有没有服务在跑」，不看 MINERU_HOME。实测后果：
 *
 *   机器上已有一个 v4.1.7 服务（属于别的安装）
 *   → 新装的这份 parse 时连上那个旧服务
 *   → 两份的 doclib.auth.token 不同 → invalid_doclib_token
 *
 * 这不是能靠代码绕开的 bug，是 MinerU 自身的设计：
 * **一台机器同时只能有一个 MinerU 服务实例。**
 *
 * 所以正确的做法不是「再装一份并抢服务」，而是：
 * 发现已有可用的就直接用，不要装第二份。
 *
 * ## 探测顺序与主程序保持一致
 *
 * 与 `electron/mineru.cjs` 的 `detectMineru()` 同源，避免出现
 * 「设置页说没有、解析时说有」这种自相矛盾。
 *
 * @returns {{found:boolean, exePath?:string, home?:string, source?:string}}
 */
function detectExisting(options = {}) {
  const env = options.env ?? process.env;
  const exists =
    options.exists ??
    ((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });

  const candidates = [];

  /* 1. 用户在设置里手工指定过 */
  if (typeof options.customExe === 'string' && options.customExe.trim()) {
    candidates.push({ p: options.customExe.trim(), why: '设置里手工指定' });
  }

  /* 2. 环境变量 */
  if (typeof env.MINERU_EXE === 'string' && env.MINERU_EXE.trim()) {
    candidates.push({ p: env.MINERU_EXE.trim(), why: '环境变量 MINERU_EXE' });
  }

  /* 3. 我们自己的安装位置（若之前装过） */
  if (options.userDataDir) {
    candidates.push({
      p: path.join(options.userDataDir, 'mineru', 'venv', 'Scripts', 'mineru.exe'),
      why: '应用数据目录',
    });
  }

  /* 4. 常见的手工部署位置（本机实测有 E:\StudyHub\MinerU） */
  candidates.push({
    p: 'E:\\StudyHub\\MinerU\\venv\\Scripts\\mineru.exe',
    why: 'StudyHub 部署',
  });
  candidates.push({
    p: path.join(
      require('node:os').homedir(),
      'MinerU', 'venv', 'Scripts', 'mineru.exe',
    ),
    why: '用户目录下的 MinerU',
  });

  for (const c of candidates) {
    if (exists(c.p)) {
      return {
        found: true,
        exePath: c.p,
        home: deriveHome(c.p, exists),
        source: c.why,
      };
    }
  }
  return { found: false };
}

/**
 * 从 exe 路径推 MinerU 的 home（含 config.yaml 才算）。
 *
 * 与 electron/mineru.cjs 的 deriveHome 同一套规则：
 * `.../venv/Scripts/mineru.exe` → 上两级 + home。只有真存在 config.yaml 才返回。
 */
function deriveHome(exePath, exists) {
  try {
    const scriptsDir = path.dirname(exePath);
    const venvDir = path.dirname(scriptsDir);
    const rootDir = path.dirname(venvDir);
    const homeDir = path.join(rootDir, 'home');
    if (exists(path.join(homeDir, 'config.yaml'))) return homeDir;
  } catch {
    /* 解析失败当作没有 */
  }
  return null;
}

/* ========================================================================== */
/* 安装步骤                                                                    */
/* ========================================================================== */

/**
 * 规划安装：把「要做什么」列出来，供界面显示步骤条与断点续。
 *
 * 每个 step 的 `done()` 判断是否已完成 —— 已完成的步骤跳过，
 * 这就是断点续的原理（删掉一半的 venv 会被识别为未完成并重做）。
 */
function planSteps(root) {
  const L = layout(root);
  return [
    {
      id: 'uv',
      title: '下载 uv 工具',
      detail: '约 32 MB',
      done: () => fs.existsSync(L.uvExe),
    },
    {
      id: 'python',
      title: '准备独立 Python',
      detail: '约 62 MB，不碰系统 Python',
      done: () => {
        try {
          return fs.readdirSync(L.pythonDir).length > 0;
        } catch {
          return false;
        }
      },
    },
    {
      id: 'venv',
      title: '创建运行环境',
      detail: '在所选磁盘上建 venv',
      done: () => fs.existsSync(L.venvDir) && fs.existsSync(path.join(L.venvDir, 'pyvenv.cfg')),
    },
    {
      id: 'packages',
      title: '安装 MinerU 程序',
      detail: '约 588 MB，用国内镜像',
      done: () => fs.existsSync(L.mineruExe),
    },
    {
      id: 'models',
      title: '下载识别模型',
      detail: '约 2 GB，最慢的一步',
      done: () => {
        try {
          return fs.readdirSync(L.modelsDir).some((n) => !n.startsWith('.'));
        } catch {
          return false;
        }
      },
    },
  ];
}

/**
 * 执行安装。
 *
 * 不抛异常：把失败包成 { ok:false, failedStep, error, hint }，
 * 界面据此显示「哪一步失败 + 怎么办」—— 硬约束：失败必须说清下一步。
 */
async function install(options) {
  const {
    root,
    onStep,
    onLine,
    onProgress,
    fetchImpl,
    /*
     * 跳过模型下载（2026-11-11）。
     *
     * 用途有两个：一是让用户先能跑起来（basic 档也能用），
     * 二是让「装到程序能跑」这一步可以在几分钟内验证完，
     * 而不是每次都要等 2GB 下完才能知道链路通不通。
     *
     * 跳过时会如实告诉调用方模型还没下 —— 不假装装完了。
     */
    skipModels = false,
  } = options;

  if (!root || typeof root !== 'string') {
    return { ok: false, failedStep: 'init', error: '没有指定安装目录', hint: '先选一个磁盘' };
  }

  /*
   * ---- A 方案：先看机器上是不是已经有一份能用的 ----
   *
   * 用户选了 A：「检测到已有服务就提示『已有 MinerU，直接用那个』」。
   *
   * 为什么这是正确做法而不是图省事：MinerU 的 server 是全局单例，
   * 再装一份只会和已有那份抢服务、token 打架（实测 invalid_doclib_token）。
   * 与其装一个用不了的第二份，不如直接复用。
   *
   * `force` 可以跳过这个检查（给「我就是要重装」的高级场景用）。
   */
  if (!options.force) {
    const existing = detectExisting({
      customExe: options.customExe,
      env: options.env,
      userDataDir: options.userDataDir,
    });
    if (existing.found) {
      onLine?.(`检测到已有 MinerU：${existing.exePath}`);
      return {
        ok: true,
        reused: true,
        root: existing.home ? path.dirname(path.dirname(existing.home)) : null,
        exePath: existing.exePath,
        home: existing.home,
        message:
          `这台机器上已经装好 MinerU 了（${existing.source}），直接用它就行，` +
          '不需要再装一份 —— 同一个 MinerU 服务不能被两个安装同时使用。',
      };
    }
  }

  /* 空间检查：不够就不开始，而不是装到一半失败 */
  const free = freeBytesAt(path.dirname(root));
  if (free !== null && free < REQUIRED_FREE_BYTES) {
    const gb = (free / 1024 / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      failedStep: 'check-space',
      error: `这个磁盘只剩 ${gb} GB，装不下`,
      hint: 'MinerU 需要约 3 GB（模型占 2 GB）。换一个空间更大的磁盘。',
    };
  }

  const L = layout(root);
  fs.mkdirSync(L.root, { recursive: true });
  fs.mkdirSync(L.toolsDir, { recursive: true });
  fs.mkdirSync(L.homeDir, { recursive: true });

  const steps = planSteps(root);
  const emit = (id, state, extra) => onStep?.({ id, state, ...extra });

  /* ---- 1. uv ---- */
  if (!steps[0].done()) {
    emit('uv', 'running');
    const got = await ensureUv(L, { onLine, onProgress, fetchImpl });
    if (!got.ok) {
      emit('uv', 'failed', { error: got.error });
      return {
        ok: false,
        failedStep: 'uv',
        error: `取不到 uv 工具`,
        hint: `${got.error}。已下载的部分会保留，重试时接着下。`,
      };
    }
    emit('uv', 'done', { source: got.source });
  } else {
    emit('uv', 'done');
  }

  if (!fs.existsSync(L.uvExe)) {
    return {
      ok: false,
      failedStep: 'uv',
      error: '解压后没找到 uv.exe',
      hint: `预期位置：${L.uvExe}`,
    };
  }

  /* ---- 2. Python（uv 自己下，我们只指个目录）---- */
  if (!steps[1].done()) {
    emit('python', 'running');

    /*
     * 先走南大镜像（实测 7 秒），失败再让 uv 用官方源。
     * 镜像地址必须是「根」，不能带日期 —— 详见 PBS_MIRROR_ROOT 的注释。
     */
    const mirrors = [
      process.env.UV_PYTHON_INSTALL_MIRROR || PBS_MIRROR_ROOT,
      null, // null = 不指定，让 uv 用默认（releases.astral.sh）
    ];

    let lastErr = '';
    let ok = false;
    for (const mirror of mirrors) {
      const env = { ...uvEnv(L) };
      if (mirror) env.UV_PYTHON_INSTALL_MIRROR = mirror;
      onLine?.(mirror ? `从镜像取 Python：${new URL(mirror).host}` : '改试 GitHub 官方源…');

      const r = await run(
        L.uvExe,
        ['python', 'install', '3.12', '--install-dir', L.pythonDir],
        { onLine, env },
      );
      if (r.code === 0) { ok = true; break; }
      lastErr = r.out.slice(-500);
    }

    if (!ok) {
      emit('python', 'failed', { error: lastErr });
      return {
        ok: false,
        failedStep: 'python',
        error: '准备 Python 失败（镜像与官方源都试过）',
        hint:
          `${lastErr}\n\n` +
          '这一步只需下载一次（约 21MB）。装好的部分会保留，重试不会重做前面的步骤。',
      };
    }
    emit('python', 'done');
  } else {
    emit('python', 'done');
  }

  /* ---- 3. venv ---- */
  if (!steps[2].done()) {
    emit('venv', 'running');
    const r = await run(
      L.uvExe,
      ['venv', '--python', '3.12', '--python-preference', 'only-managed', L.venvDir],
      { onLine, env: uvEnv(L) },
    );
    if (r.code !== 0) {
      emit('venv', 'failed', { error: r.out.slice(-500) });
      return { ok: false, failedStep: 'venv', error: '创建运行环境失败', hint: r.out.slice(-400) };
    }
    emit('venv', 'done');
  } else {
    emit('venv', 'done');
  }

  /* ---- 4. 装包 ---- */
  if (!steps[3].done()) {
    emit('packages', 'running');
    const py = path.join(L.venvDir, 'Scripts', 'python.exe');

    /*
     * 用 [core] 而不是 [all]：实测 [all] 会多装 gradio（72.6MB）
     * 与一堆我们界面用不到的 Web UI 依赖。
     */
    let installed = false;
    let lastErr = '';
    for (const mirror of PYPI_MIRRORS) {
      const r = await run(
        L.uvExe,
        ['pip', 'install', '--python', py, '-U', 'mineru[core]', '-i', mirror],
        { onLine, env: uvEnv(L) },
      );
      if (r.code === 0) { installed = true; break; }
      lastErr = r.out.slice(-600);
      onLine?.(`镜像 ${mirror} 失败，换下一个…`);
    }
    if (!installed) {
      emit('packages', 'failed', { error: lastErr });
      return {
        ok: false,
        failedStep: 'packages',
        error: '安装 MinerU 程序失败（三个镜像都试过）',
        hint: lastErr.slice(-400) || '检查网络；已下载的 wheel 有缓存，重试会快一些。',
      };
    }
    emit('packages', 'done');
  } else {
    emit('packages', 'done');
  }

  /* ---- 5. 模型 ---- */
  if (skipModels && !steps[4].done()) {
    /* 如实标注「跳过」，不标成完成 */
    emit('models', 'skipped');
    onLine?.('已跳过模型下载（可以稍后在设置里单独下）');
  } else if (!steps[4].done()) {
    emit('models', 'running');
    /* 先写 config.yaml，让模型落到我们选的盘（默认会落到用户目录） */
    try {
      fs.mkdirSync(L.modelsDir, { recursive: true });
      const yaml =
        'model:\n' +
        `  base_dir: ${L.modelsDir.replace(/\\/g, '/')}\n` +
        `  source: ${MODEL_SOURCE}\n`;
      fs.writeFileSync(L.configFile, yaml, 'utf8');
    } catch (e) {
      return {
        ok: false,
        failedStep: 'models',
        error: '写配置失败',
        hint: String(e && e.message),
      };
    }

    const dlExe = path.join(L.venvDir, 'Scripts', 'mineru-models-download.exe');
    const r = await run(
      fs.existsSync(dlExe) ? dlExe : path.join(L.venvDir, 'Scripts', 'mineru.exe'),
      [
        '--tier', 'standard',
        '--source', MODEL_SOURCE,
      ],
      {
        onLine,
        env: {
          MINERU_HOME: L.homeDir,
          MINERU_MODEL_SOURCE: MODEL_SOURCE,
          /*
           * 关键（2026-11-11 晚）：必须把 ModelScope 缓存也指到所选磁盘。
           * 不设就会去写 `%USERPROFILE%\.cache\modelscope\.lock`，
           * 实测在那里 [WinError 5] 拒绝访问，整批模型全失败。
           */
          MODELSCOPE_CACHE: L.modelscopeCache,
          /* HF 兜底时同理，别往 C 盘写 */
          HF_HOME: path.join(L.cacheDir, 'huggingface'),
        },
      },
    );
    if (r.code !== 0) {
      emit('models', 'failed', { error: r.out.slice(-600) });
      return {
        ok: false,
        failedStep: 'models',
        error: '下载模型失败',
        hint: r.out.slice(-500) || '模型已下载的部分会保留，重试可从断点继续。',
      };
    }
    emit('models', 'done');
  } else {
    emit('models', 'done');
  }

  /* ---- 6. 验收：真的解析一个 PDF，并检查产物内容 ---- */
  /*
   * ## 为什么不能用 `mineru --version` 当验收
   *
   * 我第一版就是那样：`--version` 返回 0 就报「安装完成」。
   * 但那只证明程序能启动，证明不了模型下全了、onnxruntime 能加载、
   * 真能吐出文字。实测在模型只有空壳子时它也「通过」—— 假验收。
   *
   * ## 这个验收做什么
   *
   *  1. 手写一个一页的 PDF（内容是 `HELLO MINERU TEST 12345`，
   *     见 mineru-verify-pdf.cjs）
   *  2. 真跑一次 `mineru parse`
   *  3. **检查产物里有没有那个词** —— 只看退出码不够
   *
   * 这是「验产物，不采信自我报告」那条规则的落实。
   */
  emit('verify', 'running');

  let verified = false;
  let verifyDetail = '';
  const demoPdf = path.join(L.root, '_verify.pdf');
  /* ⚠️ `-o` 在 MinerU 4.x 里是**输出文件**，不是目录（实测踩过） */
  const demoOut = path.join(L.root, '_verify.md');

  /*
   * ## ⚠️ 这里有个坑，必须绕开（2026-11-11 实测）
   *
   * `mineru server` 是**全局单例**：它按 `%USERPROFILE%\.mineru` 判断
   * 「有没有服务在跑」，**不看 MINERU_HOME**。
   *
   * 实测后果：本机已有一个 MinerU 服务在跑（属于别的安装），
   * 我们新装的这份去 `server status` 会连上那个旧服务，
   * 因为 token 不同而报：
   *   authentication_error / invalid_doclib_token
   * 于是「服务没起来」的误判 —— 其实我们的安装是好的。
   *
   * 所以验收**不依赖全局服务**：
   * 直接确认可执行文件能跑（--version），再做一次真实解析。
   * 解析本身若需要服务，失败信息会如实带出来，不会被误报成「安装坏了」。
   */
  const serveEnv = { MINERU_HOME: L.homeDir, ...uvEnv(L) };

  try {
    /* 1. 先确认这份安装自己能启动（不碰全局服务状态） */
    const ver = await run(L.mineruExe, ['--version'], { onLine, env: serveEnv });
    if (ver.code !== 0) {
      verifyDetail = `mineru 无法启动（返回 ${ver.code}）`;
    }

    /* 2. 造一个真 PDF */
    require('./mineru-verify-pdf.cjs').writeVerifyPdf(demoPdf);

    /*
     * 3. 真解析一次。
     *
     * 用 --no-server 之类的开关不存在，所以直接跑；若服务不可用，
     * 退出码非 0，我们会把 stderr 原文带出去（不猜原因）。
     */
    const vr = await run(
      L.mineruExe,
      ['parse', demoPdf, '-o', demoOut, '-p', '1'],
      { onLine, env: serveEnv },
    );

    if (vr.code !== 0) {
      const raw = (vr.out || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' / ');
      verifyDetail =
        (verifyDetail ? `${verifyDetail}；` : '') +
        `解析命令返回 ${vr.code}${raw ? `（${raw.slice(0, 200)}）` : ''}`;
    } else {
      /* 4. 查产物内容 —— 这一步才是验收 */
      let text = '';
      try {
        text = fs.readFileSync(demoOut, 'utf8');
      } catch {
        try {
          const alt = fs.readdirSync(L.root).find((n) => n.endsWith('.md'));
          if (alt) text = fs.readFileSync(path.join(L.root, alt), 'utf8');
        } catch { /* 还是没有 */ }
      }
      const want = require('./mineru-verify-pdf.cjs').VERIFY_KEYWORD;
      const ok2 = text.toUpperCase().includes(want);
      if (ok2) {
        verified = true;
        verifyDetail = '';
      } else {
        verifyDetail = text
          ? `产物里没找到关键词「${want}」，实际内容：${text.slice(0, 120)}`
          : '没有产出解析结果';
      }
    }
  } catch (e) {
    verifyDetail = e && e.message ? e.message : '验收过程出错';
  } finally {
    try { fs.unlinkSync(demoPdf); } catch { /* ignore */ }
    try { fs.unlinkSync(demoOut); } catch { /* ignore */ }
  }

  if (!verified) {
    emit('verify', 'failed', { error: verifyDetail });
    return {
      ok: false,
      failedStep: 'verify',
      error: '装完了但解析不了（模型或依赖没就绪）',
      hint:
        `${verifyDetail}\n\n` +
        `试着手动跑一次：\n${L.mineruExe} parse <任意PDF> -o out.md -p 1\n\n` +
        '已下载的模型和依赖都在，重试不会重做这些步骤。',
    };
  }
  emit('verify', 'done');

  return {
    ok: true,
    root,
    exePath: L.mineruExe,
    home: L.homeDir,
  };
}

/* ========================================================================== */
/* 卸载                                                                        */
/* ========================================================================== */

/**
 * 卸载 MinerU：只删 MinerU 自己的目录，绝不碰用户学习库。
 *
 * ## 为什么必须与「OpenLeaner 卸载」分开
 *
 * 用户学习库在 `%APPDATA%\OpenLeaner`，MinerU 装在用户选的盘上。
 * 两者本来就不同目录。这里只删 MinerU 那个 root。
 * 但**仍然要二次确认** —— 删掉后要重下 2.7GB。
 *
 * @returns {Promise<{ok:boolean, removed:string[], error?:string}>}
 */
async function uninstall(options) {
  const { root } = options;
  if (!root || typeof root !== 'string') {
    return { ok: false, removed: [], error: '没有指定要卸载的目录' };
  }

  /*
   * 安全检查：只允许删「看着像我们装的」目录。
   *
   * 为什么要有这一步：如果配置里的路径被改坏了（比如指向 C:\），
   * 盲目递归删除会造成灾难。判断标准是目录里必须有我们创建的标记。
   */
  const L = layout(root);
  const markers = ['tools', 'venv', 'home', 'python'];
  const hits = markers.filter((m) => fs.existsSync(path.join(root, m)));
  if (hits.length === 0) {
    return {
      ok: false,
      removed: [],
      error: '这个目录不像 MinerU 安装位置，为安全起见没有删除',
    };
  }

  /* 先停掉可能还在跑的服务，否则文件被占用删不掉 */
  try {
    await run('taskkill', ['/F', '/IM', 'mineru.exe'], {});
    await run('taskkill', ['/F', '/IM', 'mineru-api.exe'], {});
  } catch {
    /* 没在跑就无所谓 */
  }

  const removed = [];
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    removed.push(root);
    return { ok: true, removed };
  } catch (e) {
    return {
      ok: false,
      removed,
      error: `删除失败：${e.message}`,
      hint: '可能有进程还在用这些文件。关掉软件后重试，或手动删除该目录。',
    };
  }
}

module.exports = {
  UV_VERSION,
  UV_URL,
  PYPI_MIRRORS,
  MODEL_SOURCE,
  REQUIRED_FREE_BYTES,
  layout,
  listDrives,
  freeBytesAt,
  detectExisting,
  planSteps,
  install,
  uninstall,
  download,
  run,
};

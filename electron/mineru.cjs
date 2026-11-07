/**
 * 本机 MinerU 转换（主进程侧）。
 *
 * ## 这个文件为什么单独存在
 *
 * 交接文档里有一条硬规矩：**能单测的逻辑不要内联在 ipcMain.handle 里**，
 * 否则验它就得启动整个 Electron，等于验不了。
 *
 * 所以这里只放纯逻辑 + 一个可注入的 spawn，主进程那边只做 IPC 接线。
 * `scripts/verify-mineru-spawn.cjs` 可以直接 require 这个文件跑真实子进程，
 * 不需要开窗口。
 *
 * ## 安全边界
 *
 * 渲染进程传来的路径不可信。这里做三件事：
 *  1. 只允许执行**可执行文件本身**，参数由我们拼，不接受用户传 argv；
 *  2. 输出目录必须在应用自己的临时目录下，不接受任意路径；
 *  3. 超时与页数上限都要有 —— 一本 628 页的书在 CPU 上要几小时，
 *     没有上限会让用户以为程序死了。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** 单次转换的最长等待。628 页在 standard tier 上约 20–40 分钟，留足余量 */
const CONVERT_TIMEOUT_MS = 3 * 60 * 60 * 1000;

/**
 * 探测本机 MinerU 是否可用。
 *
 * 返回 { available, exePath, reason }。
 * 探测顺序：
 *  1. 环境变量 MINERU_EXE（给高级用户与测试用）
 *  2. 应用数据目录下 mineru/venv/Scripts/mineru-kit.exe（我们自己的安装位置）
 *  3. 两个常见的手工安装位置
 *
 * **不扫全盘** —— 那会在启动时卡住几秒，用户会以为程序坏了。
 */
/**
 * 从 mineru-kit.exe 的路径推出 MinerU 的 home 目录。
 *
 * 典型部署形状（本机实测）：
 *   E:\StudyHub\MinerU\venv\Scripts\mineru.exe
 *   E:\StudyHub\MinerU\home\config.yaml      ← 这才是 home
 *
 * 只有真的存在 config.yaml 才返回它；否则返回 null 让调用方别传
 * MINERU_HOME —— 传一个不存在的目录会让 MinerU 自己去建，反而更乱。
 */
function deriveHome(exePath, isFile) {
  try {
    const scriptsDir = path.dirname(exePath); // .../Scripts
    const venvDir = path.dirname(scriptsDir); // .../venv
    const rootDir = path.dirname(venvDir); // <root>
    const homeDir = path.join(rootDir, 'home');
    if (isFile(path.join(homeDir, 'config.yaml'))) return homeDir;
  } catch {
    /* 路径解析失败就当作没有 home */
  }
  return null;
}

function detectMineru(options = {}) {
  const env = options.env ?? process.env;
  const exists = options.exists ?? ((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  const candidates = [];

  const fromEnv = env.MINERU_EXE;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    candidates.push({ p: fromEnv.trim(), why: '环境变量 MINERU_EXE' });
  }

  // 应用数据目录（我们将来自己装的位置）
  if (options.userDataDir) {
    candidates.push({
      p: path.join(options.userDataDir, 'mineru', 'venv', 'Scripts', 'mineru.exe'),
      why: '应用数据目录',
    });
  }

  // 用户已经手工部署好的位置（本机实测：E:\StudyHub\MinerU）
  candidates.push({ p: 'E:\\StudyHub\\MinerU\\venv\\Scripts\\mineru.exe', why: 'StudyHub 部署' });

  for (const c of candidates) {
    if (exists(c.p)) {
      return {
        available: true,
        exePath: c.p,
        /*
         * 一并给出 home 目录。
         *
         * 为什么必须现算：mineru-kit 装在某目录下的 venv 里，而它的
         * 「家」（config.yaml + models/）通常在同级的 home/ 下。
         * 不显式传 MINERU_HOME 时它会退回 ~/.mineru，那里往往是空的
         * 或不可写 —— 实测会卡在 `[WinError 5] 拒绝访问` 的模型锁上，
         * 表现成「转换失败、像是 PDF 坏了」，其实只是找错了模型目录。
         *
         * 推导规则：<root>/venv/Scripts/mineru-kit.exe → <root>/home
         * 该目录里有 config.yaml 才算数（否则不猜）。
         */
        mineruHome: deriveHome(c.p, exists),
        reason: null,
      };
    }
  }

  return {
    available: false,
    exePath: null,
    reason:
      '没找到本机的 MinerU。装好之后把 mineru.exe 的路径填到设置里，' +
      '或者设环境变量 MINERU_EXE 指向 mineru.exe。' +
      '（扫描件识别要用它把图片里的字转成正文。）',
  };
}

/**
 * 校验并整理一次转换请求。
 *
 * 返回 { ok:true, value } 或 { ok:false, trouble, message }。
 */
function validateRequest(raw, options = {}) {
  const body = raw && typeof raw === 'object' ? raw : {};

  const filePath = typeof body.filePath === 'string' ? body.filePath.trim() : '';
  if (!filePath) {
    return { ok: false, trouble: 'invalid-request', message: '没有给出要转换的文件路径。' };
  }
  if (!path.isAbsolute(filePath)) {
    return { ok: false, trouble: 'invalid-request', message: '文件路径必须是绝对路径。' };
  }

  // 只接受这几类文件：MinerU 能处理的 PDF 与常见图片
  const ext = path.extname(filePath).toLowerCase();
  const ALLOWED = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff']);
  if (!ALLOWED.has(ext)) {
    return {
      ok: false,
      trouble: 'invalid-request',
      message: `MinerU 不支持转换「${ext || '无扩展名'}」这类文件。`,
    };
  }

  const exists = options.exists ?? ((p) => fs.existsSync(p));
  if (!exists(filePath)) {
    return {
      ok: false,
      trouble: 'missing-file',
      message: `要转换的文件不存在：${filePath}`,
    };
  }

  const outDir = typeof body.outDir === 'string' ? body.outDir.trim() : '';
  /*
   * outDir 可以由页面给，也可以留空由主进程生成。
   *
   * 留空更好：页面不该知道（也不该决定）临时目录长什么样。
   * 给了就必须在 allowedRoots 下，见下面的检查。
   */
  if (outDir && !path.isAbsolute(outDir)) {
    return { ok: false, trouble: 'invalid-request', message: '输出目录必须是绝对路径。' };
  }

  /*
   * 输出目录必须在允许的根下。
   *
   * 为什么限制：这个接口能创建文件，不限制等于给渲染进程一个
   * 「往任意位置写文件」的能力。allowedRoots 由主进程传入
   * （应用自己的 temp 目录）。
   */
  const roots = Array.isArray(options.allowedRoots) ? options.allowedRoots : [];
  // 没给 outDir 就由我们在根下生成一个唯一目录（页面不该决定临时目录形状）
  let finalOut = outDir
    ? outDir
    : path.join(roots[0] ?? '', `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  if (roots.length > 0) {
    const normalizedOut = path.resolve(finalOut);
    const inside = roots.some((root) => {
      const r = path.resolve(root);
      return normalizedOut === r || normalizedOut.startsWith(r + path.sep);
    });
    if (!inside) {
      return {
        ok: false,
        trouble: 'invalid-request',
        message: '输出目录不在允许的范围内。',
      };
    }
  } else if (!outDir) {
    // 既没给根也没给目录：无处可写
    return {
      ok: false,
      trouble: 'invalid-request',
      message: '没有指定输出目录。',
    };
  }

  const tier = typeof body.tier === 'string' ? body.tier : 'standard';
  const TIERS = new Set(['flash', 'basic', 'standard', 'advanced']);
  if (!TIERS.has(tier)) {
    return { ok: false, trouble: 'invalid-request', message: `不认识的解析档位：${tier}` };
  }

  return { ok: true, value: { filePath, outDir: finalOut, tier } };
}

/**
 * 从 MinerU 的日志行里抽出进度。
 *
 * MinerU 用 tqdm 往 stderr 写 `VLM Predict:  25%|██▌ | 3/12 [00:12<00:27]`。
 * 我们只取「阶段名」和「x/y」，绝不编造百分比 —— 解析不出就是 null。
 */
function parseProgressLine(line) {
  const text = typeof line === 'string' ? line : '';

  // VLM Predict: 25%|...| 3/12 [...]
  const vlm = text.match(/VLM Predict:\s*(\d+)%\|[^|]*\|\s*(\d+)\/(\d+)/);
  if (vlm) {
    const done = Number(vlm[2]);
    const total = Number(vlm[3]);
    return {
      phase: '视觉模型识别',
      ratio: total > 0 ? done / total : null,
      detail: `${done}/${total} 页`,
    };
  }

  // 模型下载：xxx.gguf: 79%|...| 418M/531M [...]
  // ⚠️ 两个实测细节：
  //   1. tqdm 的单位是 `M` 不是 `MB`（418M），所以 B 必须是可选的；
  //   2. 进度条里含 █ 等块字符，用 [^|]* 跨过，不要试图匹配它们。
  const dl = text.match(
    /([\w.\-]+\.(?:gguf|onnx|bin|safetensors)):\s*(\d+)%\|[^|]*\|\s*([\d.]+\s*[MGK]B?)\s*\/\s*([\d.]+\s*[MGK]B?)/,
  );
  if (dl) {
    return {
      phase: '下载模型（首次运行需要）',
      ratio: Number(dl[2]) / 100,
      detail: `${dl[3]}/${dl[4]}`,
    };
  }

  if (/model_list infer finished/i.test(text)) {
    return { phase: '版面分析完成', ratio: null, detail: null };
  }
  if (/Parse\s+worker|parse_worker/i.test(text)) {
    return { phase: '准备解析', ratio: null, detail: null };
  }

  return null;
}

/**
 * 跑一次 MinerU 转换。
 *
 * @param {object} req 已校验的请求 { filePath, outDir, tier }
 * @param {object} options { exePath, spawnImpl, onProgress, signal, timeoutMs }
 * @returns {Promise<{ok:true, result:object} | {ok:false, trouble:string, message:string}>}
 */
async function runMineru(req, options = {}) {
  const exePath = options.exePath;
  const spawnImpl = options.spawnImpl ?? spawn;

  if (!exePath) {
    return {
      ok: false,
      trouble: 'not-installed',
      message: '没有配置 MinerU 可执行文件路径。',
    };
  }

  try {
    fs.mkdirSync(req.outDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      trouble: 'run-failed',
      message: `建不出输出目录：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  /*
   * 用 `mineru parse`（不是 mineru-kit），参数照 StudyHub 4.4.3 实测形状：
   *   parse <file> --tier <tier> --pages <range> --wait <sec> --json -o <file.md> --force
   *
   * 为什么换掉原来的 `mineru-kit parse --format middle_json`（2026-11-07 实测）：
   *
   * 1. **`mineru-kit` 不认本地服务**，每次自己起一遍进程、自己找模型目录，
   *    于是不受 `parse_server.local.mode` 控制 —— 这正是我们卡在
   *    `[WinError 5] 模型锁` 上的根源。`mineru parse` 走常驻服务，
   *    模型只加载一次，连续转换快得多。
   * 2. **`mineru` 能自启服务**：服务没跑时它按配置拉起，失败会明确说
   *    "Local parse-server is disabled" —— 一句能直接指出怎么修的话。
   * 3. **输出是 Markdown，自带分页标记** `<!-- page N of M -->`，
   *    天然就是「按页写回」的依据；标题层级也在（`##`）。
   *    middle_json 虽然结构更全，但要多写一层解析，而我们需要的就是
   *    「每页一段纯文本」—— Markdown 直接够用。
   *
   * `--wait` 必不可少：不给它，命令会立刻返回「已提交」，
   * 我们去读输出文件时还是空的。
   */
  const outFile = path.join(req.outDir, 'converted.md');
  const waitSec = options.waitSec ?? 1800;
  const args = [
    'parse',
    req.filePath,
    '--tier',
    req.tier,
    '--pages',
    'all',
    '--wait',
    String(waitSec),
    '--json',
    '-o',
    outFile,
    '--force',
  ];

  return await new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(exePath, args, {
        windowsHide: true,
        cwd: path.dirname(exePath),
        /*
         * 环境变量这里有两个必须传的：
         *
         * 1. `MINERU_HOME` —— 指向**已经配好模型的那个家目录**。
         *    不能省。实测：不传时 mineru-kit 会去 `~/.mineru`，
         *    而那里可能是空壳或写不进去（应用沙箱对用户 home 的
         *    部分路径没有写权限），报 `[WinError 5] 拒绝访问` 卡在
         *    模型 .locks 上 —— 那个错误看起来像"文件坏了"，
         *    实际是模型目录用错了。传对之后直接用用户装好的 839MB 模型，
         *    也不必再下载。
         *
         * 2. `PYTHONIOENCODING=utf-8` —— MinerU 是 Python 程序，
         *    Windows 控制台默认 GBK 会把中文日志写坏，进度行就解析不出来。
         */
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          /*
           * 有意**不传** MINERU_HOME（2026-11-07 实测结论）。
           *
           * `mineru parse` 走本地常驻服务，服务自己知道用哪个 home。
           * 外部再塞一个 MINERU_HOME 会让 CLI 与服务用的 home 不一致，
           * 报 `invalid_doclib_token` —— 因为两个 home 里的 token 不同。
           * 只有退回 `mineru-kit` 那种一次性 CLI 时才需要显式指定。
           */
        },
      });
    } catch (err) {
      resolve({
        ok: false,
        trouble: 'broken',
        message: `启动 MinerU 失败：${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let stderrTail = '';
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      resolve(value);
    };

    /*
     * 进度：`mineru parse --wait` **在结束前什么都不打印**（StudyHub 文档
     * 原话：prints nothing until it ends）。所以不能靠读它的 stdout。
     *
     * 照 StudyHub 的做法：改为**只读地问服务**。
     *   mineru server status --json   → workers / parse_server 健康状态
     *
     * 为什么用只读命令：转换期间去改状态会干扰它。
     * 每 20 秒问一次，第一次 5 秒后问 —— 频率太低用户以为卡死，
     * 太高则频繁起 Python 进程（每次 2-5 秒）。
     *
     * 拿不到就报「进行中」，绝不编造百分比。
     */
    const poller = setInterval(() => {
      if (settled) return;
      options.onProgress?.({
        phase: 'MinerU 正在识别（这一步没有细粒度进度）',
        ratio: null,
        detail: null,
      });
    }, 20000);

    // 第一个提示立刻给，让界面马上有反应
    options.onProgress?.({
      phase: '已提交给 MinerU，正在解析',
      ratio: null,
      detail: null,
    });

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({
        ok: false,
        trouble: 'run-failed',
        message: `MinerU 转换超时（超过 ${Math.round(CONVERT_TIMEOUT_MS / 60000)} 分钟）。`,
      });
    }, options.timeoutMs ?? CONVERT_TIMEOUT_MS);

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish({ ok: false, trouble: 'aborted', message: '已取消转换。' });
      });
    }

    const onLine = (line) => {
      // 只留最后若干行用于报错，避免把整本日志堆在内存里
      stderrTail = (stderrTail + '\n' + line).slice(-4000);
      const p = parseProgressLine(line);
      if (p) options.onProgress?.({ ...p, line });
    };

    // MinerU 的进度写 stderr（tqdm），结果写文件
    const splitLines = (buf) => {
      const s = buf.toString('utf8');
      for (const line of s.split(/[\r\n]+/)) {
        if (line.trim()) onLine(line);
      }
    };
    child.stderr?.on('data', splitLines);
    child.stdout?.on('data', splitLines);

    child.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      // ENOENT = 文件不在，通常是没装好或路径写错了
      const trouble = /ENOENT/.test(msg) ? 'not-installed' : 'broken';
      finish({
        ok: false,
        trouble,
        message:
          trouble === 'not-installed'
            ? `找不到 MinerU 可执行文件：${exePath}`
            : `运行 MinerU 时出错：${msg}`,
      });
    });

    child.on('close', (code) => {
      if (settled) return;

      /*
       * 先看输出文件在不在 —— 即退出码非 0 也可能写出了内容。
       *
       * 实测（2026-11-07）：`mineru parse` 在服务被禁用时会**打印 JSON 错误
       * 但退出码仍是 0**，所以不能只看退出码；反过来，某些页失败时它
       * 也可能写出部分结果。以「文件里有没有正文」为准，比看退出码可靠。
       */
      let markdown = null;
      try {
        if (fs.existsSync(outFile)) {
          markdown = fs.readFileSync(outFile, 'utf8');
        }
      } catch {
        /* 读不出来当作没有 */
      }

      if (markdown && markdown.trim()) {
        finish({ ok: true, result: { markdown, outFile } });
        return;
      }

      if (code !== 0) {
        const said = stderrTail.trim();
        /*
         * 把三种最常见的失败翻译成用户能照着做的下一步。
         * 原来只会把原始日志拍给用户，他看不出该点哪里。
         */
        if (/Local parse-server is disabled|parse_server\.local\.mode/i.test(said)) {
          finish({
            ok: false,
            trouble: 'server-disabled',
            message:
              'MinerU 的本地解析服务没启用，所以它拒绝转换。' +
              '到 MinerU 的安装目录执行两条命令即可：\n' +
              '  mineru config set parse_server.local.mode managed\n' +
              '  mineru config set parse_server.local.managed_tier basic\n' +
              '然后重启应用。',
          });
          return;
        }
        if (/models download|not downloaded|模型/i.test(said)) {
          finish({
            ok: false,
            trouble: 'models-missing',
            message:
              'MinerU 的模型没下全，转换用不了。' +
              '到 MinerU 安装目录执行：mineru-kit models download --tier basic',
          });
          return;
        }
        if (/WinError 5|拒绝访问|PermissionError/i.test(said)) {
          finish({
            ok: false,
            trouble: 'locked',
            message:
              'MinerU 的模型文件被别的程序占着（常见于同时开着 StudyHub 的 MinerU）。' +
              '把那个程序关掉，或先停掉它的服务，再重试。',
          });
          return;
        }
        finish({
          ok: false,
          trouble: 'run-failed',
          message: `MinerU 退出码 ${code}。${said ? `最后的日志：${said.slice(-600)}` : ''}`,
        });
        return;
      }

      // 退出码 0 但没有产物
      finish({
        ok: false,
        trouble: 'bad-output',
        message:
          `MinerU 说成功了，但没有写出转换结果（期待文件：${outFile}）。` +
          '可能是这份文件它读不出内容，或转换被中途中断。',
      });
    });
  });
}

module.exports = {
  CONVERT_TIMEOUT_MS,
  detectMineru,
  validateRequest,
  parseProgressLine,
  runMineru,
};

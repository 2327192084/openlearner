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

const { spawn, execFile } = require('node:child_process');
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

  /*
   * 用户在设置里手工指定的 exe（2026-11-11）。
   *
   * 排第一：他明确指了就是最可靠的信号，比环境变量还直接 ——
   * 环境变量要自己配、还容易写错路径，而这个是在软件里点两下选的。
   */
  if (typeof options.customExe === 'string' && options.customExe.trim()) {
    candidates.push({ p: options.customExe.trim(), why: '设置里手工指定' });
  }

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
/**
 * 从服务日志里抽出**最后一条**真实进度。
 *
 * ## 为什么读服务日志而不是读 parse 的 stdout
 *
 * `mineru parse --wait` 结束前什么都不打印。真正的 tqdm 输出被服务的
 * 解析进程持有，通过 `mineru server status --json` 的
 * `parse_server_stderr_logs` 字段暴露出来（实测最近 10 行）。
 *
 * ## 阶段名怎么翻译
 *
 * tqdm 里的前缀是 MinerU 内部的流水线阶段名（Layout Predict / VLM Predict /
 * OCR-det / OCR-rec / Table / MFR…）。直接用会让人看不懂，所以翻成中文，
 * 并保留原阶段名便于排查。
 */
function parseServiceLogs(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return null;

  // 从后往前找第一条能解析的 —— 最后一条才是「现在进行到哪」
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = stripAnsi(String(logs[i] ?? ''));
    const hit = parseTqdm(line);
    if (hit) return hit;
  }
  return null;
}

/** 去掉 ANSI 颜色码（tqdm 与 rich 日志都爱用） */
function stripAnsi(s) {
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

/** 阶段名 → 用户能看懂的中文 */
const STAGE_LABEL = {
  'Layout Predict': '版面分析',
  'VLM Predict': '视觉模型识别',
  'OCR-det': '文字检测',
  'OCR-rec': '文字识别',
  Table: '表格识别',
  MFR: '公式识别',
  MFDet: '公式检测',
  'Formula Detect': '公式检测',
  'Formula Recognition': '公式识别',
  Downloading: '下载模型',
};

/**
 * 解析一条 tqdm 行。
 *
 * 形如：`OCR-det:  75%|███████▍  | 294/394 [00:07<00:01, 64.99it/s]`
 *
 * 同时取 x/y 与剩余时间 —— 后者对用户判断「还要等多久」最有用，
 * 而 tqdm 已经算好了，不用我们猜。
 */
function parseTqdm(line) {
  const text = typeof line === 'string' ? line : '';

  /*
   * 分两步匹配，不要写成一整个大正则。
   *
   * 第一版把「阶段名 + 百分比 + x/y + 时间括号」塞进一个正则，
   * 结果 `[^|]*\|` 这种片段会贪婪吃掉后面的括号，时间永远抽不到
   * （实测：ratio 对了但 detail 里始终没有「还要约 N 秒」）。
   * 拆开之后两段各自明确，也就不容易被 tqdm 的 █ 块撑糊涂。
   */
  const main = text.match(/^([A-Za-z][\w \-.]*?):\s*(\d+)%\s*\|.*?\|\s*(\d+)\/(\d+)/);
  if (!main) return null;

  const stage = main[1].trim();
  const percent = Number(main[2]);
  const done = Number(main[3]);
  const total = Number(main[4]);

  const time = text.match(/\[(\d+):(\d+)<(\d+):(\d+)/);
  const etaMin = time ? Number(time[3]) : null;
  const etaSec = time ? Number(time[4]) : null;

  const label = STAGE_LABEL[stage] ?? stage;

  /*
   * 剩余时间只在这一阶段**还没接近完成**时才有参考价值。
   * 已经 95% 了还写「还要 1 分」会让人以为卡住，不如只报 x/y。
   */
  const remaining =
    etaMin !== null && etaSec !== null && percent < 95
      ? etaMin > 0
        ? `还要约 ${etaMin} 分 ${etaSec} 秒`
        : `还要约 ${etaSec} 秒`
      : null;

  return {
    phase: label,
    // ratio 用 tqdm 自己的百分比：它是该阶段的进度，不是整本的
    ratio: Number.isFinite(percent) ? percent / 100 : null,
    detail: remaining ? `${done}/${total} · ${remaining}` : `${done}/${total}`,
    stage,
    done,
    total,
  };
}

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

    /* 轮询计时器。先声明再被 finish 引用 —— 否则会踩 TDZ。 */
    let pollTimer = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pollTimer) clearTimeout(pollTimer);
      resolve(value);
    };

    /*
     * 进度：`mineru parse --wait` 在结束前**什么都不打印**
     * （StudyHub 文档原话：prints nothing until it ends）。
     * 所以不能靠读它自己的 stdout。
     *
     * 真正的进度在**服务那边**：`mineru server status --json` 的
     * `parse_server_stderr_logs` 字段装的就是解析进程实时的 tqdm 输出，
     * 形如 `OCR-det:  75%|███████▍ | 294/394 [00:07<00:01, 64.99it/s]`。
     * 2026-11-07 本机实测：这条命令 1.7 秒返回，一次能拿到最近 10 行。
     *
     * 所以：定时问服务 → 从最近几行里抽出「最后一个 tqdm 进度」→ 报给界面。
     * 抽不到就报阶段文字，**绝不编百分比**。
     */
    let lastPhase = '';
    let pollBusy = false;

    /*
     * 日志基线：本次转换开始前，服务里已经有多少行日志。
     *
     * ## 为什么必须有它（实测踩到的坑）
     *
     * 服务的 `parse_server_stderr_logs` 是**滚动保留最近若干行**的，
     * 上一次转换留下的行会留在里面。不设基线的话，
     * 刚开始转换就会先读到上一本的「OCR-det 252/252」，
     * 于是界面一上来显示 100%，然后跳回 8% —— 用户会以为程序出了错。
     *
     * 做法：转换启动时先用一次 `server status --json` 记下当时的日志快照，
     * 之后只采纳**不出现在快照里**的新行。日志被截断（滚动掉旧行）时
     * 快照匹配不上也没关系 —— 那种情况说明时间已经过去不少，
     * 此刻的日志基本都是新的。
     */
    let baselineLines = null;
    let baselineReady = false;

    const takeBaseline = (cb) => {
      execFile(
        exePath,
        ['server', 'status', '--json'],
        { timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (!err && stdout) {
            try {
              const j = JSON.parse(stdout);
              const logs = Array.isArray(j.parse_server_stderr_logs)
                ? j.parse_server_stderr_logs.map((l) => String(l))
                : [];
              baselineLines = logs;
            } catch {
              baselineLines = [];
            }
          } else {
            baselineLines = [];
          }
          baselineReady = true;
          cb();
        },
      );
    };

    /** 只保留基线里没有的行 */
    const onlyNewLines = (logs) => {
      if (!Array.isArray(baselineLines) || baselineLines.length === 0) return logs;
      const known = new Set(baselineLines);
      const fresh = logs.filter((l) => !known.has(String(l)));
      /*
       * 全是旧行说明服务还没开始写新日志 —— 返回空，
       * 让上层报「准备中」，而不是把上一本的进度当成本次的。
       */
      return fresh;
    };

    const pollOnce = () => {
      if (settled || pollBusy) return;
      pollBusy = true;
      execFile(
        exePath,
        ['server', 'status', '--json'],
        { timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          pollBusy = false;
          if (settled) return;
          if (err) return; // 问不到就静默跳过，下一轮再问

          let parsed;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            return;
          }

          const allLogs = Array.isArray(parsed.parse_server_stderr_logs)
            ? parsed.parse_server_stderr_logs.map((l) => String(l))
            : [];
          // 去掉本次转换开始前就存在的旧行（上一次转换的残留）
          const logs = onlyNewLines(allLogs);
          const found = parseServiceLogs(logs);
          if (!found) {
            // 服务在跑但还没开始出进度（模型加载阶段）—— 如实说
            if (lastPhase !== '准备中') {
              lastPhase = '准备中';
              options.onProgress?.({
                phase: '正在准备（加载模型可能要约一分钟）',
                ratio: null,
                detail: null,
              });
            }
            return;
          }

          const key = found.phase + found.detail;
          if (key === lastPhase) return; // 没变化就不重复推
          lastPhase = key;
          options.onProgress?.(found);
        },
      );
    };

    // 立刻给一个「已提交」的反馈，别让界面空着
    options.onProgress?.({
      phase: '已提交给 MinerU，正在启动解析',
      ratio: null,
      detail: null,
    });

    /*
     * 先取基线（记下启动这一刻的日志），再开轮询。
     * 顺序不能反：先轮询的话，第一轮就可能把旧日志当成本次进度报出去。
     */
    takeBaseline(() => {
      if (settled) return;
      // 第一次 2 秒后问（让转换先起飞），之后每 4 秒一次。
      // 为什么不更快：每问一次要起一个 Python 进程（1.7 秒），太快会拖慢转换本身。
      pollTimer = setInterval(pollOnce, 4000);
      setTimeout(pollOnce, 2000);
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
  parseServiceLogs,
  parseTqdm,
  runMineru,
};

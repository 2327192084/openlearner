/**
 * MinerU 健康检查（2026-11-12）。
 *
 * ## 为什么需要这个
 *
 * A 方案（已有 MinerU 就不装第二份）当初把「已装好」与「安装入口」
 * 设计成互斥 —— 理由成立（MinerU 的 server 是全局单例，装第二份会抢服务）。
 *
 * 但它有个盲区：**已装 ≠ 能用**。
 * 用户实际遇到的是「装好了，但模型不全」，面板只说「已装好，直接用就行」，
 * 他没有任何补救途径 —— 于是又来问「一键安装按钮做了吗」。
 *
 * 所以现在补一层：**已装时也做体检**。
 * 不完整就明确说缺什么、并给可照做的修复命令。
 *
 * ## 数据从哪来
 *
 * `mineru-kit models show` 会逐项输出 `<repo>: ready | missing`，
 * 这是官方口径，比我们自己扫文件目录可靠（目录结构会变，
 * 而且 `.mineru_complete` 这类标记只有它认得）。
 *
 * ⚠️ 必须传 `MINERU_HOME`：不传时它会去读 `~/.mineru`，
 * 那是另一个目录（实测两者内容不同），结论会错。
 *
 * ## 只读保证
 *
 * 体检只跑 `models show`（纯查询）与 `config get`，不写任何东西。
 * 修复命令只是**文本**，由用户自己决定要不要执行。
 */

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

/**
 * 跑一个命令并收集输出（不抛异常）。
 *
 * @returns {Promise<{code:number, out:string}>}
 */
function runCapture(exe, args, env, spawnImpl) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(exe, args, {
        windowsHide: true,
        cwd: path.dirname(exe),
        env: { ...process.env, ...env },
      });
    } catch (e) {
      resolve({ code: -1, out: `启动失败: ${e && e.message}` });
      return;
    }
    let out = '';
    const onData = (c) => {
      out += c.toString('utf8');
      if (out.length > 60000) out = out.slice(-60000);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch { /* ignore */ }
      resolve({ code: -2, out: '超时' });
    }, 20000);
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out: `启动失败: ${e && e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, out });
    });
  });
}

/**
 * 解析 `models show` 的输出。
 *
 * 实测格式（缩进两个空格）：
 * ```
 * Repos:
 *   MinerU-4_models_onnx: ready
 * (C:\Users\...\models\MinerU-4_models_onnx)
 *   MinerU2.5-Pro-2605-1.2B-GGUF: missing
 * (…)
 * Model tiers:
 *   basic: MinerU-4_models_onnx
 *   standard: MinerU-4_models_onnx, MinerU2.5-Pro-2605-1.2B-GGUF
 * ```
 *
 * 注意「ready / missing」后面可能带空格，路径另起一行 ——
 * 所以用「名字: 状态」抓，不要假设同一行还有别的。
 *
 * @returns {{repos: Array<{name:string, ready:boolean}>, tiers: Record<string,string[]>}}
 */
function parseModelsShow(text) {
  const repos = [];
  const tiers = {};
  let section = '';

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (/^Repos:\s*$/.test(line.trim())) {
      section = 'repos';
      continue;
    }
    if (/^Model tiers:\s*$/.test(line.trim())) {
      section = 'tiers';
      continue;
    }
    if (/^[A-Za-z].*:\s*$/.test(line.trim()) && !/^\s/.test(line)) {
      /* 别的顶层小节（Config / MINERU_* 等）—— 退出当前段 */
      section = '';
      continue;
    }

    if (section === 'repos') {
      const m = /^\s+(\S+):\s*(ready|missing)\s*$/i.exec(line);
      if (m) repos.push({ name: m[1], ready: m[2].toLowerCase() === 'ready' });
      continue;
    }
    if (section === 'tiers') {
      const m = /^\s+(\S+):\s*(.+)$/.exec(line);
      if (m) {
        tiers[m[1]] = m[2].split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
  }

  return { repos, tiers };
}

/**
 * 检查一份 MinerU 安装是否健康。
 *
 * @param {object} opts
 * @param {string} opts.exePath  mineru.exe
 * @param {string|null} opts.home  MINERU_HOME（有就用它，没有就让 MinerU 用默认）
 * @param {(exe:string,args:string[],env:object,spawnImpl:Function)=>Promise} [opts.spawnImpl] 测试注入
 * @returns {Promise<{
 *   ok: boolean,
 *   error?: string,
 *   mode?: string,
 *   tier?: string,
 *   repos?: Array<{name:string,ready:boolean}>,
 *   missingRepos?: string[],
 *   missingForTier?: string[]  （当前 tier 缺哪些 repo）,
 *   fixCommands?: string[]  （可照做的修复命令，带绝对路径）,
 *   summary: string,
 * }>}
 */
async function checkMineruHealth(opts) {
  const { exePath, home } = opts;
  const spawnImpl = opts.spawnImpl ?? spawn;

  if (!exePath) {
    return { ok: false, summary: '没有配置 MinerU 路径', error: 'no-exe' };
  }

  const env = home ? { MINERU_HOME: home } : {};

  /*
   * 用同目录的 mineru-kit 查模型 —— models 子命令不在 mineru.exe 上
   * （实测 `mineru models download` → No such command 'models'）。
   */
  const kitExe = exePath.replace(/mineru\.exe$/i, 'mineru-kit.exe');

  /*
   * ⚠️ 这里有个坑（2026-11-12 实测）：
   *
   * `config get` **不能**带 MINERU_HOME。带了之后它会去找那个 home 下的
   * doclib 配置，缺少 `doclib.auth.token` 时直接失败：
   *   Error: A valid Doclib Bearer token is required.
   * 于是 mode/tier 读出来是 `?`，健康检查误判成「状态未知」。
   *
   * 而 `models show` 恰恰相反：**必须**带 MINERU_HOME，
   * 否则它去查 `~/.mineru`（那是另一个目录），结论会错。
   *
   * 两者要求不同，所以分别传环境变量。
   */
  const [showRes, modeRes, tierRes] = await Promise.all([
    runCapture(kitExe, ['models', 'show'], env, spawnImpl),
    runCapture(exePath, ['config', 'get', 'parse_server.local.mode'], {}, spawnImpl),
    runCapture(exePath, ['config', 'get', 'parse_server.local.managed_tier'], {}, spawnImpl),
  ]);

  if (showRes.code !== 0 && !/Repos:/i.test(showRes.out)) {
    return {
      ok: false,
      summary: '读不到模型状态',
      error: (showRes.out || '').trim().slice(-200) || `退出码 ${showRes.code}`,
    };
  }

  const { repos, tiers } = parseModelsShow(showRes.out);
  const mode = /=\s*(\S+)/.exec(modeRes.out)?.[1] ?? '?';
  const tier = /=\s*(\S+)/.exec(tierRes.out)?.[1] ?? '?';

  const missingRepos = repos.filter((r) => !r.ready).map((r) => r.name);

  /* 当前 tier 需要的 repo 里，哪些是缺的 */
  const needForTier = tiers[tier] ?? [];
  const readySet = new Set(repos.filter((r) => r.ready).map((r) => r.name));
  const missingForTier = needForTier.filter((n) => !readySet.has(n));

  const quoted = `"${exePath}"`;
  const quotedKit = `"${kitExe}"`;

  const fixCommands = [];
  if (missingForTier.length > 0) {
    /*
     * 先补模型再设配置 —— 顺序不能反。
     * 实测：模型不齐时 `config set ... mode managed` 会直接失败，
     * 报「... missing: ... Run: mineru-kit models download」。
     */
    fixCommands.push(`${quotedKit} models download --tier ${tier}`);
    fixCommands.push(`${quoted} config set parse_server.local.mode managed`);
  } else if (mode === 'disabled') {
    fixCommands.push(`${quoted} config set parse_server.local.mode managed`);
  }

  const ok = missingForTier.length === 0 && mode === 'managed';

  let summary;
  if (ok) {
    summary = `可用（${tier} 档，服务已启用）`;
  } else if (missingForTier.length > 0) {
    summary = `${tier} 档缺 ${missingForTier.length} 个模型，需要先补模型`;
  } else if (mode === 'disabled') {
    summary = '模型齐全，但本地解析服务是关闭的';
  } else {
    summary = `状态未知（mode=${mode}, tier=${tier}）`;
  }

  return {
    ok,
    mode,
    tier,
    repos,
    missingRepos,
    missingForTier,
    fixCommands,
    summary,
  };
}

module.exports = {
  checkMineruHealth,
  parseModelsShow,
  runCapture,
};

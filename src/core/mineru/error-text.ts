/**
 * MinerU 错误信息的可读化（2026-11-11）。
 *
 * ## 为什么需要
 *
 * 实测用户看到的失败提示是一整段原始 JSON：
 *
 *   MinerU 退出码 1。最后的日志：{"error":{"type":"api_error",
 *   "code":"server_not_running","message":"本地 mineru 服务未运行。
 *   请先运行 'mineru server start'。","param":null}}
 *
 * 信息其实都在，但整段 JSON 塞在一个错误提示里，用户得自己从引号和
 * 花括号里把它挑出来。这里把常见形状剥成一句话。
 *
 * ## 为什么放在 src/core 而不是 electron/
 *
 * 它是**纯函数**，不碰 fs / 进程。放在 core 里：
 *  - 能直接被 vitest 单测（electron/ 下的 CJS 进不了 vite 的模块图）
 *  - 主进程可以 `require` 同一个实现，不必复制一份
 *
 * ## 边界
 *
 * 只做「去掉噪音」，**不改写含义**。剥不出就原样给最后一行，
 * 绝不编一个听起来合理的原因 —— 那会让人照错误的提示去修。
 */

/** 超过这个长度的非 JSON 文本会被截断（界面上不该糊一屏） */
const MAX_LEN = 160;

/**
 * 把 MinerU 的原始错误输出压成一句人话。
 *
 * 支持的形状：
 *  - `{"error":{"message":…}}`  → 取 message
 *  - `{"error":{"code":…}}`     → 没有 message 时退回 code
 *  - `{"message":…}`            → 取 message
 *  - 其他                        → 取最后一行非空文本
 */
export function summarizeMineruError(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (!text) return '没有更多信息';

  const start = text.indexOf('{');
  if (start >= 0) {
    /* 从 start 开始做括号配对，取第一个完整对象（后面可能还有日志） */
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end > start) {
      try {
        const obj = JSON.parse(text.slice(start, end)) as {
          error?: { message?: unknown; code?: unknown };
          message?: unknown;
        };
        const candidate = obj?.error?.message ?? obj?.message ?? obj?.error?.code ?? null;
        if (typeof candidate === 'string' && candidate.trim()) {
          return candidate.trim().slice(0, 240);
        }
      } catch {
        /* 不是合法 JSON（或被截断），落到下面按行取 */
      }
    }
  }

  /* 兜底：最后一行非空 */
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? text;
  return last.length > MAX_LEN ? `${last.slice(0, MAX_LEN)}…` : last;
}

/**
 * 这条日志是否表示「MinerU 本地服务没在跑」。
 *
 * 单独抽出来是因为它是最常见的一类，且**有明确的解法**
 * （`mineru server start`），值得给一条专门的提示。
 */
export function isServerNotRunning(raw: unknown): boolean {
  const text = String(raw ?? '');
  return /server_not_running|本地 mineru 服务未运行|service.*not.*running/i.test(text);
}

/**
 * 把 AI 调用抛出的错误说成人话（2026-11-19）。
 *
 * ## 为什么需要这一层
 *
 * `ApiError` 有 `code` + `message` + `hint` 三个字段：
 *  - `message` 是给排查用的（`网络请求失败：连不上该地址（fetch failed） (network)`）
 *  - `hint` 才是给用户看的
 *
 * 但界面普遍只读了 `error.message`，于是用户看到的是 `(fetch failed) (network)`
 * 这种字样 —— 用户截图里正是这个。多花一层的价值：用户知道下一步该干什么。
 *
 * ## 为什么单独成文件
 *
 * 三个面板（答错讲解、提示阶梯、提问复习）都要报错，各写一份必然漂移。
 * 这里是纯函数，可单测。
 */

/** 可能从各层抛上来的错误形状（只取需要的字段） */
export interface ExplainableError {
  message?: string;
  /** ApiError 带的技术分类 */
  code?: string;
  /** ApiError 带的「下一步建议」 */
  hint?: string;
}

/** code → 一句人话（不含服务商名，那由 hint 补） */
const PLAIN: Record<string, string> = {
  network: '连不上 AI 服务',
  'invalid-key': 'API Key 不对',
  forbidden: '这把 Key 没有权限，或账号欠费',
  'rate-limited': '请求太频繁，被限流了',
  'insufficient-balance': '账号余额不足',
  'server-error': '服务商那边出错了',
  'bad-request': '请求被服务端拒绝了',
  aborted: '已取消',
  unknown: '出了点问题',
};

/**
 * 归一成「一句人话 + 可选的一步建议」。
 *
 * @param err 捕获到的任意错误
 * @param fallback 完全认不出时用的兜底文案（各调用点自己写，例如「讲解生成失败」）
 */
export function explainError(
  err: unknown,
  fallback: string,
): { title: string; hint: string | null } {
  const e = (err ?? {}) as ExplainableError;

  /* ApiError：有 code 就用白话标题，hint 原样带上（它本来就是人话） */
  if (typeof e.code === 'string' && PLAIN[e.code]) {
    return {
      title: PLAIN[e.code] as string,
      hint: typeof e.hint === 'string' && e.hint.trim() ? e.hint.trim() : null,
    };
  }

  /*
   * 没有 code 的普通 Error：message 可能是人话（我们自己 throw 的那些，
   * 例如「这道题已经不在了」），也可能是浏览器原始的 fetch 失败。
   *
   * 判断依据：原始技术串里几乎一定带括号或英文错误码
   * （`(fetch failed)`、`TypeError: Failed to fetch`、`timeout`）。
   * 那类统一换成「连不上 AI 服务」—— 用户看得懂的是这一句。
   */
  const msg = typeof e.message === 'string' ? e.message.trim() : '';
  if (!msg) return { title: fallback, hint: null };

  /*
   * 同时匹配半角与全角括号 —— 我们自己拼的那句用的是全角（「（fetch failed）」），
   * 而浏览器原始串是半角。只写一种会漏（实测漏了 6 个样本里的 1 个）。
   */
  const looksTechnical = /[（(]?fetch failed[）)]?|Failed to fetch|TypeError|[（(]?network[）)]?|timeout|ETIMEDOUT|ECONNREFUSED|SSL/i.test(msg);
  if (looksTechnical) {
    return {
      title: '连不上 AI 服务',
      hint:
        '检查三件事：① 网络是否正常；② 设置里的接口地址是否填对（到 /v1 为止，'
        + '不要带 /chat/completions）；③ 该服务是否允许直连。',
    };
  }

  /* 其余当作人话直接用（我们自己 throw 的那些都是给人看的） */
  return { title: msg, hint: null };
}
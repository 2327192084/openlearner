/**
 * 资料页共用的小类型与工具。
 *
 * 异步状态用**联合类型**而不是 `{loading, error, data}` 三件套：
 * 后者允许出现 `loading=true 且 data 有值` 这种自相矛盾的状态，
 * 界面就会显示「加载中」却已经有内容。联合类型让非法组合无法表达。
 */

export type Load<T> =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; hint: string }
  | { kind: 'ready'; data: T };

/** 页内提示条，与设置页同形，直接喂给 Notice */
export type Flash = { tone: 'info' | 'warning' | 'danger'; text: string } | null;

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 从异常里取「下一步」。
 *
 * core 的 `ImportError` / `LibraryError` 都带 `hint`；
 * 其他异常没有，就用调用方给的兜底文案 ——
 * 全项目不允许出现只说「操作失败」的提示（P0 起就是硬要求）。
 */
export function hintFrom(err: unknown, fallback: string): string {
  if (err && typeof err === 'object') {
    const hint = (err as { hint?: unknown }).hint;
    if (typeof hint === 'string' && hint.trim()) return hint;
  }
  return fallback;
}

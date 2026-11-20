/**
 * 搜索历史（2026-11-21）。
 *
 * ## 用户要求
 *
 * 参考图（浏览器搜索历史那种）：搜索框底下一行「搜索历史」+ 右侧「清空」，
 * 下面是几个胶囊标签（「高数」「英语」）。
 *
 * ## 存哪里：localStorage，不进 IndexedDB
 *
 * 与 `MapPage` 的折叠状态同一条理由（那里注释写过）：
 * 搜索历史**不是学习数据**，它只影响界面便利性。
 * 进备份没有意义（换机器后旧搜索词也没用），也不该占 IndexedDB 一张表 +
 * 迁移三件套（storage/types 四处 + DB_VERSION + migrations）。
 *
 * ## 为什么不存到「上一次搜索」这一个字段
 *
 * 用户要的是「历史」，不是「上次」。浏览器那种一排胶囊的价值在于
 * **反复搜同一批词**（他举的例子是「高数」「英语」这种课程名）——
 * 存一个字段做不到。
 *
 * ## 去重与顺序
 *
 * - 同一个词再搜一次 → 提到最前，不产生第二条
 *   （否则连点五次「高数」会把整排占满，看着像坏了）
 * - 大小写/首尾空白归一后比较：搜「高数」和「高数 」算同一个
 * - 上限 10 条：一排胶囊再多就换行成两排，视觉上不「一排历史」了
 *
 * ## 本模块是纯函数
 *
 * 读写 localStorage 的壳（`loadHistory` / `saveHistory`）在这里，
 * 但**去重、排序、裁剪是纯函数**（`pushHistory`），便于单测。
 */

const STORAGE_KEY = 'openleaner.search.history';

/** 最多记几条。10 条在 860px 宽度下正好排成一行多一点，不至于占掉半屏 */
export const HISTORY_LIMIT = 10;

/** 单条长度上限：过长的搜索词当标签显示会撑破一行 */
const MAX_TERM_LEN = 40;

/**
 * 归一化一个搜索词（用于去重比较）。
 *
 * 只做「首尾空白 + 大小写」，**不做全角半角转换**：
 * 用户搜「Ａ」（全角）与「A」可能是两个意图，归一掉反而会让
 * 他明明搜了新词却看到旧的那条被提到前面。
 */
function normalize(term: string): string {
  return term.trim().toLowerCase();
}

/**
 * 往历史里加一条（纯函数，不碰存储）。
 *
 * 规则：
 * 1. 空词 / 纯空白 → 原样返回（不记录没意义的东西）
 * 2. 已存在（归一后相同）→ 提到最前，保留**新输入的原样写法**
 *    （用户这次搜「高数 」带空格，显示他这次打的样子）
 * 3. 不存在 → 加到最前
 * 4. 超过上限 → 砍掉最老的
 *
 * @param history 现有历史（最新的在前）
 * @param term 这次搜的词
 */
export function pushHistory(history: readonly string[], term: string): string[] {
  const shown = term.trim();
  if (shown.length === 0) return [...history];
  /* 标签显示用截断版本，但比较用完整词的归一结果 */
  const label = shown.length > MAX_TERM_LEN ? shown.slice(0, MAX_TERM_LEN) : shown;
  const key = normalize(shown);

  const rest = history.filter((h) => normalize(h) !== key);
  return [label, ...rest].slice(0, HISTORY_LIMIT);
}

/** 从历史里删掉一条（用户可能想单独去掉某条） */
export function removeHistory(history: readonly string[], term: string): string[] {
  const key = normalize(term);
  return history.filter((h) => normalize(h) !== key);
}

/** 读历史；读不到/坏数据都返回空数组（不影响搜索本身能用） */
export function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, HISTORY_LIMIT);
  } catch {
    /* 隐私模式、坏 JSON、配额满 —— 都不该让搜索页打不开 */
    return [];
  }
}

/** 写历史；写不进去就算了（只是下次不记得） */
export function saveHistory(history: readonly string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, HISTORY_LIMIT)));
  } catch {
    /* 忽略：历史是便利功能，写不进去不影响搜索 */
  }
}

/** 清空（用户点「清空」时用） */
export function clearHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}
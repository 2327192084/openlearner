import type { AnchorStatus, KnowledgePoint, Source } from '@/core/model.ts';
import type { KnowledgeBackendSummary } from '@/core/knowledge/service.ts';
import { MANUAL_BACKEND_ID } from '@/core/knowledge/service.ts';
import { MockBackend } from '@/core/knowledge/mock-backend.ts';

/**
 * 知识点页（P2）共用的小类型与展示映射。
 *
 * `Load` / `Flash` / `describeError` / `hintFrom` 与资料页同形，但**刻意各有一份**：
 * 两个页面分属不同阶段、不同文件域，共用一个模块会让改一边直接影响另一边。
 * 形状保持一致即可，不需要在代码上耦合。
 *
 * 异步状态用联合类型而不是 `{loading, error, data}` 三件套：
 * 后者允许「加载中且已有数据」这种自相矛盾的状态出现在界面上。
 */
export type Load<T> =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; hint: string }
  | { kind: 'ready'; data: T };

/** 页内提示条，与设置页/资料页同形，直接喂给 Notice */
export type Flash = { tone: 'info' | 'warning' | 'danger'; text: string } | null;

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 从异常里取「下一步」。
 *
 * core 的错误对象带 `hint` 时优先用它；没有就用调用方给的兜底文案。
 * 全项目不允许出现只说「操作失败」的提示。
 */
export function hintFrom(err: unknown, fallback: string): string {
  if (err && typeof err === 'object') {
    const hint = (err as { hint?: unknown }).hint;
    if (typeof hint === 'string' && hint.trim()) return hint;
  }
  return fallback;
}

/** 数字加千分位，用于 token 用量与字数，避免一串数字看不出量级 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '未知';
  return Math.round(n).toLocaleString('zh-CN');
}

export const COGNITIVE_LEVELS: ReadonlyArray<{
  value: KnowledgePoint['cognitiveLevel'];
  label: string;
  hint: string;
}> = [
  { value: 'remember', label: '识记', hint: '记住定义、名称、结论' },
  { value: 'understand', label: '理解', hint: '说清原理、因果关系' },
  { value: 'apply', label: '应用', hint: '能套用到具体问题或步骤' },
  { value: 'analyze', label: '分析', hint: '比较、辨析、判断适用条件' },
];

export function cognitiveLabel(level: KnowledgePoint['cognitiveLevel']): string {
  return COGNITIVE_LEVELS.find((x) => x.value === level)?.label ?? level;
}

/**
 * 定位状态到界面文案的映射。
 *
 * `unlocated` 刻意用 `planned`（橙色）而不是中性色：
 * 它必须看起来「还没处理完」，绝不能和成功定位的条目长得一样。
 * 这是 P2 验收原话「指认不到原文位置的条目单独标出来，等人处理」。
 */
export const ANCHOR_STATUS_LABEL: Record<
  AnchorStatus,
  { text: string; tone: 'ready' | 'planned' | 'neutral'; hint: string }
> = {
  located: {
    text: '已定位',
    tone: 'ready',
    hint: '位置来自在真实正文里的实测命中，可以直接点回原文。',
  },
  unlocated: {
    text: '待处理',
    tone: 'planned',
    hint: '模型给的引用在原文里找不到。位置留空，等人工指认或标记为无出处。',
  },
  waived: {
    text: '无出处',
    tone: 'neutral',
    hint: '人工确认这条没有原文出处（例如总结性表述），不再提示。',
  },
};

/** 「第 N 页 · 章节」的写法；没有位置时**明确说没有**，不给一个看起来像位置的值 */
export function locationLabel(point: KnowledgePoint): string {
  const anchor = point.anchors[0];
  if (!anchor || anchor.page === undefined) return '无位置';
  return anchor.chapter ? `${anchor.chapter} · 第 ${anchor.page} 页` : `第 ${anchor.page} 页`;
}

/** 页数未知的资料（粘贴文本等）显示段数，不显示 0 页——0 页看起来像文件坏了 */
export function pageCountLabel(source: Source): string {
  if (source.pageCount === null) return `${source.segmentCount} 段`;
  return `${source.pageCount} 页 · ${source.segmentCount} 段`;
}

/* ==========================================================================
   按后端分组（P5 第 4 条：不同后端结果并存对比）
   ========================================================================== */

/** 多组统计的合计。用于「全部」chip 与资料卡片上的总数 */
export interface BackendTotals {
  count: number;
  located: number;
  unlocated: number;
  waived: number;
}

/**
 * 把各后端的分组合计起来。
 *
 * 为什么不直接数 points.length：列表是**筛选后**的，筛到某一组时
 * 用它当总数会让「这份资料有多少条」随 chip 变化，看起来像数据在丢。
 * 合计与各分组同源，两处数字永远一致。
 */
export function sumBackends(summaries: KnowledgeBackendSummary[]): BackendTotals {
  return summaries.reduce<BackendTotals>(
    (acc, s) => {
      acc.count += s.count;
      acc.located += s.located;
      acc.unlocated += s.unlocated;
      acc.waived += s.waived;
      return acc;
    },
    { count: 0, located: 0, unlocated: 0, waived: 0 },
  );
}

/**
 * backendId → 可读名字。
 *
 * 四种情况必须分开处理，缺一个 chip 就会显示成空白或一串 id：
 *   - 手工录入：core 用 MANUAL_BACKEND_ID 归组，它不对应任何后端配置
 *   - 示例后端：id 是 `'mock'`，但它**不是**一条 BackendConfig，
 *     不在 BackendService.list() 里 —— 早先这里漏了它，
 *     结果用得最多的示例后端显示成「未知后端（mock）」，看着像配置坏了
 *   - 配置还在：用设置页里那份 label
 *   - **配置已删**：明确说「未知后端（id）」。后端删了但它产出的知识点
 *     还在库里，这是正常状态，不是错误 —— 留空才会让人以为界面坏了
 */
export function backendLabel(backendId: string, labels: Record<string, string>): string {
  if (backendId === MANUAL_BACKEND_ID) return '手工录入';

  // 示例后端优先于映射表：它永远不在映射表里，先查表会一路掉到最后那个分支
  const mock = new MockBackend();
  if (backendId === mock.id) return mock.label;

  const known = labels[backendId];
  if (known && known.trim()) return known;
  return `未知后端（${backendId}）`;
}

/**
 * 进入一份资料时该默认选哪一组。
 *
 * 只有一个后端时不筛 —— 一个选项的筛选器只是噪音，占掉一整行却永远只有一个状态。
 * 有多个时选**条数最多**的那组：多数情况下用户想先看产得最全的那一份。
 * （core 的 listBackends 已按条数降序排，这里不重复排序，只做取值决策。）
 */
export function defaultBackendFilter(
  summaries: KnowledgeBackendSummary[],
): string | null {
  if (summaries.length < 2) return null;
  return summaries[0]?.backendId ?? null;
}

/**
 * 「可点回原文」的比例。
 *
 * 分母用 count 而不是 located+unlocated：`waived` 是人工确认过
 * 「这条本来没有出处」，把它算进「点不回去」会让认真校对过的后端
 * 看起来比没校对过的还差 —— 那正好鼓励了错误的行为。
 */
export function locatedRatio(summary: KnowledgeBackendSummary): string {
  if (summary.count === 0) return '—';
  return `${Math.round((summary.located / summary.count) * 100)}%`;
}

export interface ParsedPageRange {
  /** null = 整份资料 */
  range: { from: number; to: number } | null;
  error: string | null;
}

/**
 * 解析页码范围输入。
 *
 * 规则刻意严格：要么两头都留空（整份），要么两头都填正整数。
 * 只填一头时不做「起始页=1」这类猜测 —— 猜错范围会白跑一次整理（还花钱），
 * 而说清「两头都填或都留空」只需要一句话。
 */
export function parsePageRange(fromDraft: string, toDraft: string): ParsedPageRange {
  const from = fromDraft.trim();
  const to = toDraft.trim();

  if (from === '' && to === '') return { range: null, error: null };
  if (from === '' || to === '') {
    return { range: null, error: '页码范围要么两头都填，要么都留空（整份资料）。' };
  }

  const f = Number(from);
  const t = Number(to);
  if (!Number.isInteger(f) || !Number.isInteger(t) || f < 1 || t < 1) {
    return { range: null, error: '页码范围要填大于 0 的整数页码。' };
  }

  return { range: { from: Math.min(f, t), to: Math.max(f, t) }, error: null };
}

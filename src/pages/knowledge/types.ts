import type { AnchorStatus, KnowledgePoint, Source } from '@/core/model.ts';

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

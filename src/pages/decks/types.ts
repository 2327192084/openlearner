import type {
  KnowledgePoint,
  Question,
  QuestionIssue,
  QuestionKind,
  Source,
  SourceLocation,
} from '@/core/model.ts';

/**
 * 习题集页（P3）共用的小类型与展示映射。
 *
 * 与资料页（P1）、知识点页（P2）的 `types.ts` 同形但**各有一份**：
 * 三个页面分属不同阶段，共用一个模块会让改一边直接影响另一边。
 * 形状保持一致即可，不需要在代码上耦合。
 *
 * 异步状态用联合类型而不是 `{loading, error, data}` 三件套：
 * 后者允许「加载中且已有数据」这种自相矛盾的状态出现在界面上。
 */
export type Load<T> =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; hint: string }
  | { kind: 'ready'; data: T };

/** 页内提示条，直接喂给 Notice */
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

/** 数字加千分位，用于 token 用量，避免一串数字看不出量级 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '未知';
  return Math.round(n).toLocaleString('zh-CN');
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
}

/** 日期只到天，用于列表里的「创建于」 */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('zh-CN');
}

export const QUESTION_KINDS: ReadonlyArray<{
  value: QuestionKind;
  label: string;
  hint: string;
}> = [
  { value: 'single', label: '单选', hint: '4 个选项，1 个正确答案' },
  { value: 'multiple', label: '多选', hint: '2 个及以上正确答案，选对全部才算对' },
  { value: 'blank', label: '填空', hint: '答案是原文里的术语或短语' },
  { value: 'essay', label: '问答', hint: '答案是一段话，作答后由你自己判断对错' },
];

const KIND_LABEL: Record<QuestionKind, string> = {
  single: '单选',
  multiple: '多选',
  blank: '填空',
  essay: '问答',
};

export function kindLabel(kind: QuestionKind): string {
  return KIND_LABEL[kind] ?? kind;
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

export function levelLabel(level: Question['cognitiveLevel']): string {
  return COGNITIVE_LEVELS.find((x) => x.value === level)?.label ?? level;
}

/**
 * 出处的写法。
 *
 * DOCX / Markdown 是按章节切分的，`page` 是**章节序号**而不是真实页码
 * （Word 没有固定分页，这一点交接文档第 9 节写明了）。
 * 所以拿到资料类型时按「节」写，拿不到时按「页」写 —— 这与知识点页保持一致。
 */
export function locationText(anchor: SourceLocation | undefined, kind?: Source['kind']): string {
  if (!anchor) return '无出处';
  const unit = kind === 'docx' || kind === 'markdown' ? '节' : '页';
  if (anchor.page === undefined) {
    return anchor.chapter ? anchor.chapter : '无出处';
  }
  return anchor.chapter
    ? `${anchor.chapter} · 第 ${anchor.page} ${unit}`
    : `第 ${anchor.page} ${unit}`;
}

/**
 * 校验问题的短标签。
 *
 * core 的 message 已经是一句可读的话，这里只给徽标用的四字摘要，
 * 便于一眼扫出「这题是哪一类毛病」。
 */
export const ISSUE_CODE_LABEL: Record<QuestionIssue['code'], string> = {
  // 「题干为空」与「缺答案」是两种不同的毛病，早先共用一个 code，
  // 统计时混在一起看不出到底是哪类问题多。现在分开。
  'missing-prompt': '缺题干',
  'missing-answer': '缺答案',
  'missing-explanation': '缺解析',
  'missing-anchors': '缺出处',
  'missing-options': '选项不足',
  'invalid-answer-key': '答案键无效',
  'duplicate-prompt': '题干重复',
};

/** 正确率的写法。没作答过时说「还没练过」，不显示 0% —— 0% 看起来像全错 */
export function accuracyText(accuracy: number | null): string {
  if (accuracy === null) return '还没练过';
  return `${Math.round(accuracy * 100)}%`;
}

/** core `DeckService.getStats()` 的返回形状 */
export interface DeckStats {
  total: number;
  answered: number;
  correct: number;
  accuracy: number | null;
}

/**
 * 题型注册表：一个题型有哪些行为，全部集中在这里。
 *
 * ## 为什么要有这张表（而不是到处 if-else）
 *
 * 做「出题支持多种题型」时，最容易出事的方式是：出题页加一个选项、
 * 判分处加一个分支、渲染处再加一个分支 —— 三处各写一遍，
 * 漏掉一处的表现是「能出这种题，但做的时候没有输入框」。
 *
 * 这个项目已经因为「题型强转」踩过：`cards-loader.ts` 里
 * `q.kind as CardKind` 让 essay 题渲染出**没有输入框的提交按钮**。
 *
 * 所以学 StudyHub 的 `lib/card-kinds.js`：每种题型一个条目，
 * 说明它「能不能出题、能不能判分、有没有选项、几个选项、答题耗时」。
 * 界面、后端、判分只读这张表，加新题型只改一处。
 *
 * 参考：<https://github.com/EricWang1358/dsh-web-studyhub/blob/main/lib/card-kinds.js>
 */

import type { QuestionKind } from '../model.ts';

/** 一个题型的完整描述 */
export interface KindSpec {
  id: QuestionKind;
  /** 列表里的名字 */
  label: string;
  /** 徽标里的短名 */
  short: string;
  /**
   * 选项数量约束；null 表示这种题型没有选项。
   *
   * 判断题固定 2 个（对/错），单选 3–6 个（4 个最佳，少于 3 个太容易蒙），
   * 多选 3–6 个。
   */
  options: { min: number; max: number } | null;
  /**
   * 选项是否固定（判断题永远是对/错，且顺序不变、不洗牌）。
   *
   * 为什么判断题不洗牌：洗牌后「对」可能排在「错」后面，
   * 而用户已经习惯第一个是对 —— 换位置只会增加误点的机会。
   */
  fixedOptions: { key: string; text: string }[] | null;
  /**
   * 谁能判分。
   *  - `auto`：程序能判（选项比对 / 宽松文本匹配）
   *  - `self`：需要人自评（问答类没有唯一正确表述）
   */
  graded: 'auto' | 'self';
  /** 能不能让 AI 出这种题 */
  generate: boolean;
  /** 答题的相对耗时权重（用于估时与出题配额） */
  cost: number;
  /** 一句话说明（界面上给用户看） */
  hint: string;
}

/**
 * 所有题型。
 *
 * 顺序即界面上的展示顺序 —— 从「最容易蒙对」到「最检验真实掌握」：
 *   single → multiple → truefalse → blank → essay
 *
 * 这个顺序有依据：Anki 社区的共识是「选择题适合筛查、不适合记忆」，
 * 因为 4 个选项有 25% 的蒙对概率，而蒙对会让调度器误以为掌握了。
 * 把需要主动回忆的题型（填空/问答）排在后面，是为了让用户在
 * 习惯了这个功能之后自然往更有效的形式上走。
 *
 * 参考：<https://blog.csdn.net/weixin_34378767/article/details/91827371>
 */
const SPECS: KindSpec[] = [
  {
    id: 'single',
    label: '单选题',
    short: '单选',
    options: { min: 3, max: 6 },
    fixedOptions: null,
    graded: 'auto',
    generate: true,
    cost: 3,
    hint: '给 4 个选项选一个。最省时间，但蒙对概率 25%',
  },
  {
    id: 'multiple',
    label: '多选题',
    short: '多选',
    options: { min: 3, max: 6 },
    fixedOptions: null,
    graded: 'auto',
    generate: true,
    cost: 4,
    hint: '给 4–5 个选项，选出全部正确的。比单选难蒙',
  },
  {
    id: 'truefalse',
    label: '判断题',
    short: '判断',
    options: { min: 2, max: 2 },
    fixedOptions: [
      { key: 'T', text: '对' },
      { key: 'F', text: '错' },
    ],
    graded: 'auto',
    generate: true,
    cost: 2,
    hint: '判断一句话对不对。适合快速过一遍概念',
  },
  {
    id: 'blank',
    label: '填空题',
    short: '填空',
    options: null,
    fixedOptions: null,
    graded: 'auto',
    generate: true,
    cost: 3,
    hint: '自己写出答案。比选择题更能检验是否真记住',
  },
  {
    id: 'essay',
    label: '问答题',
    short: '问答',
    options: null,
    fixedOptions: null,
    graded: 'self',
    generate: true,
    cost: 6,
    hint: '用一段话回答，自己对照参考答案评分。最能检验理解',
  },
];

const BY_ID = new Map(SPECS.map((s) => [s.id, s]));

/** 全部题型，按展示顺序 */
export const KIND_SPECS = SPECS;

/** 能出题的题型 id（界面上可选的那些） */
export const GENERATE_KINDS: QuestionKind[] = SPECS.filter((s) => s.generate).map((s) => s.id);

/** 取一个题型的描述；未知题型返回 null（不猜） */
export function kindSpec(id: string): KindSpec | null {
  return BY_ID.get(id as QuestionKind) ?? null;
}

/** 这个题型有没有选项 */
export function hasOptions(id: string): boolean {
  return Boolean(kindSpec(id)?.options);
}

/** 这个题型的固定选项；没有则 null */
export function fixedOptionsOf(id: string): { key: string; text: string }[] | null {
  return kindSpec(id)?.fixedOptions ?? null;
}

/** 这个题型能不能由程序判分 */
export function isAutoGraded(id: string): boolean {
  return kindSpec(id)?.graded === 'auto';
}

/** 题型的显示名（未知题型退回原字符串，不崩） */
export function kindLabel(id: string): string {
  return kindSpec(id)?.label ?? id;
}

/** 题型的短名 */
export function kindShort(id: string): string {
  return kindSpec(id)?.short ?? id;
}

/** 题型的答题耗时权重（未知按最低算） */
export function kindCost(id: string): number {
  return kindSpec(id)?.cost ?? 2;
}

/**
 * 校验一批「要出哪些题型」的勾选。
 *
 * 返回规整后的数组：去掉重复、去掉不支持出题的、保持注册表顺序。
 * 空数组表示「没选」—— 调用方要点名这是错误，而不是静默退回单选，
 * 因为「我选了问答，系统却给我出单选」比报错更让人困惑。
 */
export function normalizeKindSelection(ids: readonly string[]): QuestionKind[] {
  const picked = new Set(ids);
  return GENERATE_KINDS.filter((k) => picked.has(k));
}

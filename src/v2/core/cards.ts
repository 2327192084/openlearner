import type { SourceLocation } from '@/core/model.ts';

/**
 * v2 的卡片模型。
 *
 * ## 为什么叫「卡片」不叫「题目」
 *
 * StudyHub 的组织方式是「卡片 → 复习」。一张卡片可以是：
 *  - 选择题（四选一/多选）
 *  - 填空
 *  - 简答
 *  - 纯知识点（不做题，只看）
 *
 * 统一成「卡片」后，间隔复习引擎只要能拿到 cardId 就能工作，
 * 不用为每种题型各写一套排程逻辑 —— 那是 v1 的问题之一：
 * 知识点和题目各有一套进度，复习时不知道该按哪个来。
 */

/** 卡片形态 */
export type CardKind =
  /** 单选题 */
  | 'single'
  /** 多选题 */
  | 'multiple'
  /** 填空题 */
  | 'blank'
  /** 简答题（自评） */
  | 'short'
  /** 纯知识点（只阅读，不需要作答，但仍按间隔复习推送） */
  | 'point';

/** 一个选项 */
export interface CardOption {
  key: string;
  text: string;
}

/** 一张卡片 */
export interface Card {
  id: string;
  /** 归属资料 */
  sourceId: string;
  kind: CardKind;
  /** 题干 / 知识点标题 */
  prompt: string;
  /** 选项。single/multiple 必有，其余为空数组 */
  options: CardOption[];
  /**
   * 正确答案。
   * - single：一个 key
   * - multiple：多个 key 用逗号分隔
   * - blank / short / point：参考答案文本
   */
  answer: string;
  /** 解析 / 补充说明 */
  explanation: string;
  /**
   * 出处。**继承自生成它的知识点**，不让模型重新给。
   *
   * 为什么：模型对同一段话两次引用可能不一致，会出现
   * 「知识点说第 3 页、题目说第 5 页」的矛盾，学生不知道该信哪个。
   */
  anchors: SourceLocation[];
  /** 归属题组（一次生成的卡片归一组，便于整体删除/重做） */
  deckId: string;
  createdAt: string;
}

/** 一次出题任务 */
export interface Deck {
  id: string;
  sourceId: string;
  title: string;
  /** 出题时用的资料页码范围，null 表示整份 */
  pageRange: { from: number; to: number } | null;
  cardCount: number;
  createdAt: string;
}

/**
 * 判断作答是否正确。
 *
 * @param card 卡片
 * @param given 用户给的答案
 *   - single: 选项 key
 *   - multiple: 逗号分隔的 key（顺序无关）
 *   - blank/short: 文本（宽松匹配）
 */
export function isCorrect(card: Card, given: string): boolean {
  const a = card.answer.trim();
  const g = given.trim();

  if (card.kind === 'point') return true; // 知识点没有对错

  if (card.kind === 'single') {
    return a === g;
  }

  if (card.kind === 'multiple') {
    const norm = (s: string) =>
      s
        .split(/[,，\s]+/)
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean)
        .sort()
        .join(',');
    return norm(a) === norm(g);
  }

  // 填空 / 简答：宽松匹配
  return looseMatch(a, g);
}

/**
 * 文本答案的宽松匹配。
 *
 * ## 为什么要宽松
 *
 * 填空和简答的答案，用户不可能逐字一致：
 *  - 「顺序存储」vs「顺序结构」 vs「顺序存储结构」
 *  - 多一个「的」、少一个标点
 *  - 全角半角
 *
 * 严格比对会让用户明明答对了却判错，那比不判还糟。
 * 但也不能太松 —— 给关键词命中设一个下限。
 */
export function looseMatch(expected: string, given: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      // 全角转半角（常见的中文输入法问题）
      .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      // 去掉所有空白与常见标点
      .replace(/[\s,，。、;；:：!！?？"'"'()（）\[\]【】]/g, '');

  const e = norm(expected);
  const g = norm(given);

  if (e.length === 0) return g.length === 0;
  if (e === g) return true;

  /**
   * 覆盖度阈值 0.6 而不是 0.7。
   *
   * 实测：「顺序存储结构」（6 字）包含了标准答案「顺序存储」（4 字），
   * 4/6 = 0.67 —— 按 0.7 会判错，但这是明显的正确答案，
   * 用户会觉得软件在挑刺。
   *
   * 0.6 的可容忍范围：
   *   4/6 = 0.67 ✓（少一个字）
   *   4/5 = 0.80 ✓
   *   2/4 = 0.50 ✗（只答对一半，不能算）
   * 既能接受轻微的表述差异，又不至于让「蒙对一半」通过。
   */
  const THRESHOLD = 0.6;

  // 用户答的是标准答案的一部分（且够长）
  if (g.length > 0 && e.includes(g) && g.length / e.length >= THRESHOLD) return true;

  // 反过来：用户答得比标准答案更详细，或两者互为子串
  if (e.includes(g) || g.includes(e)) {
    const shorter = Math.min(e.length, g.length);
    const longer = Math.max(e.length, g.length);
    if (longer > 0 && shorter / longer >= THRESHOLD) return true;
  }

  return false;
}

/** 卡片是否可作答（知识点不需要作答） */
export function isAnswerable(card: Card): boolean {
  return card.kind !== 'point';
}

/** 卡片类型的显示名 */
export const CARD_KIND_LABEL: Record<CardKind, string> = {
  single: '单选',
  multiple: '多选',
  blank: '填空',
  short: '简答',
  point: '知识点',
};

/**
 * 从一次作答推断复习评分。
 *
 * ## 为什么用「作答结果 + 耗时」推断，而不是让用户自己选
 *
 * StudyHub 的复习是「做题 → 系统判断熟不熟」，
 * 而不是「读完卡片 → 用户自评again/good/easy」。
 * 后者的问题：用户会对自己太宽容，导致间隔虚长、考试时才发现不会。
 *
 * 用客观指标推断更可靠：
 *  - 答错 → again
 *  - 答对但超过 20 秒 → hard（想了很久）
 *  - 答对且很快（<8 秒）→ easy
 *  - 其余 → good
 *
 * 纯知识点卡片没有「对错」，只能按停留时间推断。
 */
export function inferGrade(
  card: Card,
  correct: boolean | null,
  elapsedMs: number,
): 'again' | 'hard' | 'good' | 'easy' {
  // 知识点：只看停留时间
  if (card.kind === 'point' || correct === null) {
    if (elapsedMs < 4000) return 'easy';
    if (elapsedMs < 15000) return 'good';
    return 'hard';
  }

  if (!correct) return 'again';
  if (elapsedMs < 8000) return 'easy';
  if (elapsedMs < 20000) return 'good';
  return 'hard';
}

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
  /**
   * 判断题。
   *
   * 选项固定是对/错（key 为 T/F），所以渲染与判分可以复用选择题的逻辑，
   * 但必须作为独立类型存在 —— 否则「判断题」会被当成
   * 「只有两个选项的单选题」，导出和统计都分不清。
   */
  | 'truefalse'
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
  /**
   * 这个选项为什么对 / 为什么错（2026-11-08，可选）。
   *
   * 与 QuestionOption.why 同一含义。老题库没有这个字段，
   * 解析区就退回只显示整题 explanation —— 不编造。
   */
  why?: string;
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

  /*
   * 判断题：答案是 T / F。
   *
   * 宽容一点，接受中文「对/错」与 true/false —— 导入的题组
   * 或旧数据可能用别的写法。归一后比对，避免「答案写着 对、
   * 用户点了 T 却被判错」这种明显不对的事。
   */
  if (card.kind === 'truefalse') {
    const norm = (s: string): string => {
      const v = s.trim().toUpperCase();
      if (v === 'T' || v === 'TRUE' || v === '对' || v === '正确') return 'T';
      if (v === 'F' || v === 'FALSE' || v === '错' || v === '错误') return 'F';
      return v;
    };
    return norm(a) === norm(g);
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
  truefalse: '判断',
  blank: '填空',
  short: '简答',
  point: '知识点',
};

/**
 * 从一次作答推断复习评分 —— **已废弃，逻辑搬到 `grading.ts`**。
 *
 * 原来这里按写死的秒数判档（8 秒以内 easy、20 秒以内 good）。
 * 三个问题导致必须换掉：
 *  1. 阈值写死，用户改不了；
 *  2. 只按题型分两类、不看题目长短 —— 5 个字的填空和 200 字的简答
 *     共用一套秒数，短题永远「很熟」，长题永远「想久了」；
 *  3. 和「用户自定义宽容度」这件事没法共存。
 *
 * 新实现见 `src/v2/core/grading.ts` 的 `judgeByTiming()`：
 * 先按题型与题干长度算出这道题**基准耗时**，再用
 * `实际耗时 / 基准耗时` 的倍率判档，宽容度可自定义（含按题型单独设）。
 *
 * 这个函数在换实现后已经**没有任何调用方**，按项目一贯的做法
 * （「死代码 381 行」那次清理）直接删除，不保留一个写着旧阈值的副本 ——
 * 留着它，后来的人很可能顺着 import 找到它并用上。
 */

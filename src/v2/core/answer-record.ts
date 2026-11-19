/**
 * 「答疑记录」的统一数据层（2026-11-19）。
 *
 * ## 为什么要把两个功能整合
 *
 * 现在有两处记录，对用户来说其实是同一件事：
 *
 * | 功能 | 触发时机 | 存哪 | 记录页 |
 * |---|---|---|---|
 * | 提问式复习 | 我主动挑一段材料提问 | `oralReviews` | 提问复习记录 |
 * | 答错补充讲解 | 做错一题，问「我为什么错」 | `questions.explainNotes` | 没有 |
 *
 * 两者的本质相同：**我不懂 → 问 → 得到解释**。
 * 分开两处，用户想「我之前问过什么」要翻两个地方，而且讲解那份根本没有入口。
 *
 * ## 为什么只在展示层合并，不合并数据结构
 *
 * 两类记录的形状差别很大：
 *  - 提问记录绑「资料某段 / 知识点」，有判定类别（记错/理解偏）、引文、纠正
 *  - 讲解绑「某道题 + 某次错误作答」，有讲法（直接讲/讲故事）、错在哪、下一步
 *
 * 强行塞进一张表要么丢字段，要么要迁移用户已有的 40+ 条真实记录。
 * 这一层只做**读取 + 归一**，两份数据保持原样 —— 加一个入口，不动存储。
 *
 * ## 本模块是纯函数
 *
 * 入参就是两个数组，出参是统一行。不碰 I/O，便于单测。
 */

import type { ExplainNote, Question } from '@/core/model.ts';

/** 「答疑」的来源 */
export type AnswerSource = 'oral' | 'wrong-explain';

/** 一条统一的答疑记录 */
export interface AnswerRecordRow {
  /** 稳定 key（带来源前缀，两种记录的 id 空间可能重合） */
  key: string;
  source: AnswerSource;
  /** 时间（排序用） */
  at: string;
  /**
   * 标题：这道疑问是关于什么的。
   *  - oral：「提问范围」+ 问题
   *  - wrong-explain：题干（截断）
   */
  title: string;
  /** 副标题：用户的回答 / 他选了什么 */
  asked: string | null;
  /** 得到的内容：判定说明 / 讲解正文 */
  answered: string;
  /** 补充：下一步 / 纠正 */
  extra: string | null;
  /**
   * 跳回去看的地方。
   *  - oral：资料 + 页码
   *  - wrong-explain：题目 id（去做题页回看那道题）
   */
  sourceId: string | null;
  page: number | null;
  questionId: string | null;
  /** 来源标签，用于筛选与徽标 */
  badge: string;
}

/** 提问式复习的可归一形状（只取需要的字段，便于测试构造） */
export interface OralLike {
  id: string;
  createdAt: string;
  scopeLabel: string;
  question: string;
  answer: string;
  verdict: 'correct' | 'memory' | 'understanding';
  explanation: string;
  correction: string;
  sourceId: string | null;
  page: number | null;
}

const VERDICT_BADGE: Record<OralLike['verdict'], string> = {
  correct: '答对',
  memory: '记错了',
  understanding: '理解偏了',
};

/** 题干第一行，截断（讲解记录没有单独标题，用它当标题） */
function firstLine(s: string, max = 48): string {
  const line = (s ?? '').split('\n')[0]?.trim() ?? '';
  return line.length > max ? line.slice(0, max) + '…' : line;
}

/** 提问式复习 → 统一行 */
export function oralToRows(records: readonly OralLike[]): AnswerRecordRow[] {
  return records.map((r) => ({
    key: 'oral-' + r.id,
    source: 'oral' as const,
    at: r.createdAt,
    title: `${r.scopeLabel} · ${firstLine(r.question, 40)}`,
    asked: r.answer || null,
    answered: r.explanation,
    extra: r.correction || null,
    sourceId: r.sourceId,
    page: r.page,
    questionId: null,
    badge: VERDICT_BADGE[r.verdict],
  }));
}

/** 一道题的讲解记录（可能有多条，按讲法/时间各异） */
export interface QuestionWithNotes {
  question: Pick<Question, 'id' | 'prompt'>;
  notes: readonly ExplainNote[];
}

/** 答错补充讲解 → 统一行 */
export function explainToRows(items: readonly QuestionWithNotes[]): AnswerRecordRow[] {
  const out: AnswerRecordRow[] = [];
  for (const it of items) {
    for (const n of it.notes) {
      out.push({
        key: 'explain-' + n.id,
        source: 'wrong-explain' as const,
        at: n.createdAt,
        /* 标题用题干：用户回忆「我当时问的是哪道题」比「哪种讲法」更有用 */
        title: firstLine(it.question.prompt),
        /* 「我问了什么」= 我当时答错了什么 */
        asked: n.given ? `我答的是「${n.given}」` : null,
        answered: [n.crux, n.body].filter(Boolean).join('\n\n'),
        extra: n.nextStep,
        sourceId: null,
        page: null,
        questionId: it.question.id,
        badge: '讲解',
      });
    }
  }
  return out;
}

/**
 * 合并 + 排序。
 *
 * 排序用时间倒序（最近的在前）—— 用户打开这一页通常想找「我刚才问的那个」。
 * 同一毫秒时按 key 兜底，保证顺序稳定（这个项目踩过「时间戳相同导致顺序抖」）。
 */
export function mergeAnswerRows(
  oral: readonly AnswerRecordRow[],
  explain: readonly AnswerRecordRow[],
): AnswerRecordRow[] {
  return [...oral, ...explain].sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** 来源筛选（'all' = 不筛） */
export type AnswerFilter = 'all' | AnswerSource;

/** 按来源筛选 */
export function filterAnswerRows(
  rows: readonly AnswerRecordRow[],
  filter: AnswerFilter,
): AnswerRecordRow[] {
  if (filter === 'all') return [...rows];
  return rows.filter((r) => r.source === filter);
}

/** 各来源的条数（给筛选按钮显示） */
export function countBySource(rows: readonly AnswerRecordRow[]): Record<AnswerFilter, number> {
  const out: Record<AnswerFilter, number> = { all: rows.length, oral: 0, 'wrong-explain': 0 };
  for (const r of rows) out[r.source] += 1;
  return out;
}
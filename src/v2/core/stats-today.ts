/**
 * 统计页「今天」那一栏的明细数据。
 *
 * ## 为什么单独抽一个模块
 *
 * 用户原话（2026-11-13）：「统计栏这块的今日总结做成按钮，点击能看到
 * 具体题目，这样比其他单一栏目看的更直观。」
 *
 * 「已复习 5 张」「待复习 6 张」这两个数字原来只是数字 —— 想知道是哪
 * 五张，用户得自己去「复习记录」里翻，或者干脆凭印象猜。点开就能看到
 * 题干，才谈得上「直观」。
 *
 * 聚合逻辑（过滤哪些日志、按什么排序、题目被删了怎么办）全在这里，
 * 不进界面文件 —— 界面只负责画。这样这段规则能被单测钉住，
 * 也避免 StatsPage 里再长出一堆 useMemo。
 *
 * ## 两条硬规则
 *
 * 1. **行数必须等于数字**。用户看到「已复习 5 张」，点开却只有 3 行，
 *    第一反应是统计坏了。所以题目已被删除的行也要保留，标注出来，
 *    而不是悄悄过滤掉（项目里「同一屏的数字必须来自同一个池子」
 *    那条教训的同一类问题）。
 * 2. **排序跟数字的来源保持一致**。待复习沿用 `buildTodayQueue`
 *    的口径：逾期越久越靠前。已复习按发生时刻倒序，最近做的在最上面。
 */

import type { Card, CardKind } from './cards.ts';
import type { ReviewLog, ReviewRecord } from './review-service.ts';
import { daysOverdue, type ReviewGrade } from './srs.ts';

/** 明细里的一行 */
export interface TodayRow {
  cardId: string;
  /** 题型；题目已被删除时为 'short' 之外的占位 */
  kind: CardKind | null;
  /** 题干预览（已折叠空白、超长截断） */
  prompt: string;
  /** 已复习列表：本次评级；待复习列表：null */
  grade: ReviewGrade | null;
  /** 已复习列表：发生时刻 HH:mm；待复习列表：null */
  time: string | null;
  /** 待复习列表：逾期几天（未到期为 0）；已复习列表：0 */
  overdueDays: number;
  /** 题目已不在题库里（题被删了，日志还在） */
  missing: boolean;
}

/**
 * 题干预览长度上限。
 *
 * 72 是量出来的：明细行一行大约能放 40 个汉字，两行多一点。
 * 再长就把「已复习 / 待复习」这两种列表挤成需要滚动的长条，
 * 而这里只是让人**认出是哪道题**，不是重读一遍题干。
 */
const MAX_PROMPT = 72;

/** 折叠空白 + 截断。题目缺失时给一句明确的说明，不留空行。 */
export function promptPreview(card: Card | undefined): string {
  if (!card) return '（这道题已不在题库里）';
  const text = (card.prompt ?? '').replace(/\s+/g, ' ').trim();
  if (text.length === 0) return '（这道题没有题干）';
  return text.length > MAX_PROMPT ? `${text.slice(0, MAX_PROMPT)}…` : text;
}

/** ISO 时间串 → HH:mm（本地时区）。解析不出来就留空，不显示 NaN。 */
export function clockOf(at: string): string {
  const t = new Date(at);
  if (Number.isNaN(t.getTime())) return '';
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 今天已复习的明细。
 *
 * 不过滤卡池 —— 与 `todayOverview` 里 `doneToday` 的口径保持一致
 * （那里也是数当天全部日志）。两边口径不一致，就会出现
 * 「数字说 5、列表说 4」。
 */
export function reviewedRows(
  logs: readonly ReviewLog[],
  day: string,
  cards: ReadonlyMap<string, Card>,
): TodayRow[] {
  const rows: TodayRow[] = [];
  for (const log of logs) {
    if (log.day !== day) continue;
    const card = cards.get(log.cardId);
    rows.push({
      cardId: log.cardId,
      kind: card?.kind ?? null,
      prompt: promptPreview(card),
      grade: log.grade,
      time: clockOf(log.at),
      overdueDays: 0,
      missing: !card,
    });
  }
  // 最近的排前面。at 是 ISO 8601（同格式可直接比字符串），
  // 但同一毫秒内可能有多条 —— 用 id 兜底保证顺序稳定，免得每次
  // 打开面板顺序都在跳。
  rows.sort((a, b) => {
    const cmp = (b.time ?? '').localeCompare(a.time ?? '');
    if (cmp !== 0) return cmp;
    return a.cardId.localeCompare(b.cardId);
  });
  return rows;
}

/**
 * 今天待复习的明细。
 *
 * @param ids 来自 `service.dueCards(cardPool)` —— 已经按逾期优先排过一次，
 *   这里再按逾期天数重排只是为了让「逾期最久的在最上面」在明细里也看得见
 *   （用户会拿这个顺序去决定先补哪几张）。
 * @param records 卡片进度；缺失的卡按逾期 0 天算（理论上不会发生，
 *   因为 dueCards 就是从 records 里筛出来的）。
 */
export function dueRows(
  ids: readonly string[],
  records: ReadonlyMap<string, ReviewRecord>,
  cards: ReadonlyMap<string, Card>,
  day: string,
): TodayRow[] {
  const rows: TodayRow[] = [];
  for (const cardId of ids) {
    const card = cards.get(cardId);
    const record = records.get(cardId);
    rows.push({
      cardId,
      kind: card?.kind ?? null,
      prompt: promptPreview(card),
      grade: null,
      time: null,
      overdueDays: record ? daysOverdue(record.state, day) : 0,
      missing: !card,
    });
  }
  rows.sort((a, b) => b.overdueDays - a.overdueDays);
  return rows;
}

/**
 * 评级的中文短名。
 *
 * ⚠️ 这是第三份同类实现（`interval-reason.ts` 的 GRADE_LABEL、
 * `ReviewPage.tsx` 的 GRADE_TO_LABEL）。没有合并是因为前两份各自
 * 服务于不同句式（「你选的是「简单（一眼就会）」」vs 徽章上的「一眼就会」），
 * 强行统一会让其中一处的文案变别扭。这里的取舍是**字面短**：
 * 明细行一行里要塞题干、时间、评级三个东西，长句子会把题干挤没。
 */
const GRADE_LABEL: Record<ReviewGrade, string> = {
  again: '需要重来',
  hard: '想了一会儿',
  good: '正常速度',
  easy: '一眼就会',
};

export function gradeLabel(grade: ReviewGrade): string {
  return GRADE_LABEL[grade];
}

/**
 * 明细标题里的「这些是哪几张」一句话。
 *
 * 空列表要明说「没有」，不能让面板只剩一个空框 ——
 * 用户分不清「今天真的没做」和「面板没加载出来」。
 */
export function todayDetailEmpty(kind: 'done' | 'due'): string {
  return kind === 'done'
    ? '今天还没复习。做完几张，这里会列出是哪几张。'
    : '今天没有到期的卡。想练可以点「开始做题」自由练习。';
}

/**
 * 待办服务。
 *
 * ## 为什么排序规则要小心
 *
 * 待办列表的默认顺序直接决定「我打开时先看到什么」。
 * 这里定的是：**先看不限期的（按手动顺序），再看有截止日的（按日期近的在前），
 * 已完成的沉底**。
 *
 * 为什么不是「截止日最近的在前、无期限的最后」：
 * 大多数学习任务其实没有硬截止日，如果无期限的永远排最后，
 * 用户会看不到自己写的绝大部分待办 —— 那这个功能就等于没做。
 *
 * ## 逾期单独标出来，而不是靠排序
 *
 * 「逾期」应该是一个**视觉状态**（赭黄标记），不是排序位置。
 * 靠排序表达逾期的话，用户会以为靠前的就是更重要的，而实际上
 * 一条逾期两周的任务和一条明天到期的任务，重要性因人而异。
 */

import type { Todo } from '@/core/model.ts';
import type { StorageAdapter } from '@/core/storage/types.ts';
import { newId, nowIso } from '@/core/id.ts';

export interface TodoInput {
  title: string;
  note?: string;
  dueAt?: string | null;
  priority?: Todo['priority'];
  tags?: string[];
}

export class TodoService {
  constructor(private readonly storage: StorageAdapter) {}

  /**
   * 全部待办，按展示顺序排好。
   *
   * 顺序：未完成 → 已完成；未完成里 无期限 → 有期限（日期近的在前）；
   * 同组内按 order（手动顺序）。
   */
  async list(): Promise<Todo[]> {
    const all = await this.storage.getAll('todos');
    return all.sort(compareTodos);
  }

  /** 未完成的条数（侧栏徽标用） */
  async pendingCount(): Promise<number> {
    const all = await this.storage.getAll('todos');
    return all.filter((t) => !t.done).length;
  }

  /** 已经逾期的条数 */
  async overdueCount(today: string): Promise<number> {
    const all = await this.storage.getAll('todos');
    return all.filter((t) => !t.done && t.dueAt !== null && t.dueAt < today).length;
  }

  async create(input: TodoInput): Promise<Todo> {
    const title = input.title.trim();
    if (title.length === 0) {
      throw new Error('待办内容是空的，没有保存');
    }

    const ts = nowIso();
    const all = await this.storage.getAll('todos');
    /* 新条目排在最前（order 最小）—— 刚加的通常最想先看到 */
    const minOrder = all.reduce((m, t) => Math.min(m, t.order ?? 0), 0);

    const todo: Todo = {
      id: newId('todo'),
      title,
      note: (input.note ?? '').trim(),
      dueAt: normalizeDue(input.dueAt),
      done: false,
      doneAt: null,
      createdAt: ts,
      updatedAt: ts,
      order: minOrder - 1,
      priority: normalizePriority(input.priority),
      tags: normalizeTags(input.tags),
    };
    await this.storage.put('todos', todo);
    return todo;
  }

  /** 改标题 / 备注 / 截止日 / 优先级 / 标签 */
  async update(
    id: string,
    patch: Partial<Pick<Todo, 'title' | 'note' | 'dueAt' | 'priority' | 'tags'>>,
  ): Promise<Todo> {
    const existing = await this.storage.get('todos', id);
    if (!existing) throw new Error('这条待办已经不存在了');

    const next: Todo = { ...existing, updatedAt: nowIso() };

    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (t.length === 0) throw new Error('待办内容是空的。要删掉它请用删除。');
      next.title = t;
    }
    if (patch.note !== undefined) next.note = patch.note.trim();
    if (patch.dueAt !== undefined) next.dueAt = normalizeDue(patch.dueAt);
    if (patch.priority !== undefined) next.priority = normalizePriority(patch.priority);
    if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags);

    await this.storage.put('todos', next);
    return next;
  }

  /**
   * 勾选 / 取消勾选。
   *
   * 完成时记 doneAt，取消时清掉 —— 不留「曾经完成过」的痕迹，
   * 因为那会让「完成时间」这个字段含义变得可疑
   * （用户看到一条未完成却有 doneAt 的待办会困惑）。
   */
  async toggle(id: string, today: string): Promise<Todo> {
    const existing = await this.storage.get('todos', id);
    if (!existing) throw new Error('这条待办已经不存在了');

    const done = !existing.done;
    const next: Todo = {
      ...existing,
      done,
      doneAt: done ? today : null,
      updatedAt: nowIso(),
    };
    await this.storage.put('todos', next);
    return next;
  }

  async remove(id: string): Promise<void> {
    await this.storage.remove('todos', id);
  }

  /** 清掉全部已完成的（一次收拾干净） */
  async clearDone(): Promise<number> {
    const all = await this.storage.getAll('todos');
    const done = all.filter((t) => t.done);
    for (const t of done) await this.storage.remove('todos', t.id);
    return done.length;
  }
}

/** 截止日规整：空串 / undefined / 非法值都当「不限期」 */
function normalizeDue(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  /* 只接受 YYYY-MM-DD —— 其它格式（含带时间的 ISO）会让字符串比较失效 */
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

/** 展示顺序（见文件头说明） */
function compareTodos(a: Todo, b: Todo): number {
  /* 已完成的沉底 */
  if (a.done !== b.done) return a.done ? 1 : -1;

  /*
   * 未完成里：优先级高的在前。
   *
   * 为什么优先级要排在截止日**前面**：
   * 用户标「高」就是明确要求「让我先看到它」。
   * 如果截止日更近的永远压在上面，那优先级就白标了 ——
   * 一条「明天到期但低优先级」会盖住「高优先级但无期限」，
   * 而后者恰恰是用户最想记住的那件事。
   *
   * 只在**同优先级内**才比较截止日，逻辑见下。
   */
  if (!a.done) {
    const ap = priorityRank(a);
    const bp = priorityRank(b);
    if (ap !== bp) return ap - bp;
  }

  /* 未完成里：无期限的在前 */
  if (!a.done) {
    const aHas = a.dueAt !== null;
    const bHas = b.dueAt !== null;
    if (aHas !== bHas) return aHas ? 1 : -1;
    /* 都有期限：日期近的在前 */
    if (aHas && bHas && a.dueAt !== b.dueAt) {
      return a.dueAt! < b.dueAt! ? -1 : 1;
    }
  } else {
    /* 已完成的按完成时间倒序：刚做完的在上面 */
    const ad = a.doneAt ?? '';
    const bd = b.doneAt ?? '';
    if (ad !== bd) return ad < bd ? 1 : -1;
  }

  /* 最后按手动顺序，同 order 时用 id 兜底保证稳定 */
  const ao = a.order ?? 0;
  const bo = b.order ?? 0;
  if (ao !== bo) return ao - bo;
  return a.id < b.id ? -1 : 1;
}

/**
 * 优先级规范化。
 *
 * 未知值一律当 `normal` —— 旧数据没有这个字段，手改备份也可能写错。
 * 不抛错：优先级只影响排序，不该因为一个坏值让整条待办存不进去。
 */
function normalizePriority(v: Todo['priority'] | undefined): Priority {
  return v === 'high' || v === 'low' ? v : 'normal';
}

type Priority = 'high' | 'normal' | 'low';

const PRIORITY_RANK: Record<Priority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

/**
 * 标签规范化：去空、去重、限长。
 *
 * 为什么要限数量：标签是用来**筛选**的，一个人不会按 30 个标签筛东西。
 * 超过 8 个时后面的丢掉 —— 与其存进去筛不出来，不如当时就不收。
 */
export function normalizeTags(tags: string[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = String(raw).trim();
    if (t.length === 0) continue;
    // 大小写不敏感去重（「数学」与「数学 」已由 trim 处理，英文避免 Math/math 重复）
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t.slice(0, 24));
    if (out.length >= 8) break;
  }
  return out;
}

/** 优先级排序权重（小的更靠前）。导出供界面排序用 */
export function priorityRank(t: Todo): number {
  return PRIORITY_RANK[normalizePriority(t.priority)];
}

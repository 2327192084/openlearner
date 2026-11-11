/**
 * 统一的笔记列表（2026-11-11 晚，按用户纠正重写）。
 *
 * ## 用户纠正了什么
 *
 * 第一版把它做成了第二个栏目「按资料看」页签，用户说：
 * 「那个『按资料分』不用单独做一个栏目，它就是全部笔记里的一个分类功能。
 *   不分类可以看到全部笔记混杂在一起，分类之后可以看到各资料对应的笔记。」
 *
 * 所以正确模型是**一个列表 + 一个分组开关**：
 *  - 不分组：所有笔记混在一起（按时间倒序，最近的在上面）
 *  - 按资料分组：同一份资料的笔记聚在它的标题下面
 *
 * ## 这个列表里有什么
 *
 * 四种来源，全部是「我在学习过程中记下的东西」：
 *  1. `written`  —— 在题目/知识点下写的自由笔记（`Note`）
 *  2. `mark`     —— 原文上的高亮 / 下划线 / 删除线（`TextMark`）
 *  3. `note`     —— 原文某一句上的备注（`TextMark` kind='note'）
 *  4. `favorite` —— 收藏的知识点（`KnowledgePoint.favorite`）
 *
 * 第一版只列了后三种，导致「全部笔记」是空的而「按资料看」有内容 ——
 * 用户报的「全部笔记没有笔记，而按资料看有」正是这个：真正的 `Note`
 * 记录在他库里是 0 条，而他理解的「笔记」包含标注和备注。
 * 现在四种统一列出，两种视图都完整。
 *
 * ## 为什么单独一个文件
 *
 * `NotesPage.tsx` 已近 500 行。硬约束 5：新增 UI 一律独立文件。
 */

import { useMemo } from 'react';
import type { TextMarkKind } from '@/core/model.ts';
import { MathText } from './MathText.tsx';

/** 列表里一条笔记的四种来源 */
export type RowCategory = 'written' | 'mark' | 'note' | 'favorite';

/** 统一后的一条笔记 */
export interface UnifiedRow {
  /** 稳定 key */
  key: string;
  category: RowCategory;
  /** 归属资料 id（可跳原文）；null 表示没有资料归属 */
  sourceId: string | null;
  /** 分组标题：资料标题，或「题目：xxx」这类归属描述 */
  groupTitle: string;
  /** 页码（收藏的知识点可能没有） */
  page: number | null;
  /** 主文字 */
  text: string;
  /** 被标注的原文引文（备注与标注有） */
  quote: string | null;
  charStart?: number;
  charEnd?: number;
  markKind?: TextMarkKind;
  /** 时间（用于不分组时排序） */
  at: string;
  /** 原始 Note id（仅 written 类，用于编辑/删除） */
  noteId?: string;
  /** 归属内容是否还在库里（written 类用） */
  alive?: boolean;
}

const CATEGORY_LABEL: Record<RowCategory, string> = {
  written: '笔记',
  mark: '标注',
  note: '备注',
  favorite: '收藏',
};

const MARK_KIND_LABEL: Record<string, string> = {
  highlight: '高亮',
  underline: '下划线',
  strikethrough: '删除线',
};

/** 「11-07 18:20」—— 列表里显示时间比显示完整 ISO 串好读 */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface NotesListProps {
  rows: readonly UnifiedRow[];
  /** 是否按资料分组 */
  grouped: boolean;
  /** 当前类型筛选（null = 全部） */
  category: RowCategory | null;
  onCategoryChange: (next: RowCategory | null) => void;
  /** 点一条：回原文 */
  onOpen: (row: UnifiedRow) => void;
  /**
   * 编辑中的手写笔记：id → 草稿正文（2026-11-11 晚）。
   *
   * 状态由宿主持有：保存要落库（`notes.update`），而数据服务在宿主里。
   * 列表只负责渲染 —— 这样「编辑」不会变成又一个假按钮。
   */
  editing?: Record<string, string>;
  onEditStart?: (noteId: string, body: string) => void;
  onEditChange?: (noteId: string, draft: string) => void;
  onEditSave?: (noteId: string) => void;
  onEditCancel?: (noteId: string) => void;
  /** 删除一条手写笔记 */
  onDelete?: (noteId: string) => void;
  /** 保存中：禁用保存按钮，避免连点写两次 */
  busy?: boolean;
  /** 搜索无结果时的提示词 */
  keyword: string;
}

export function NotesList({
  rows,
  grouped,
  category,
  onCategoryChange,
  onOpen,
  editing,
  onEditStart,
  onEditChange,
  onEditSave,
  onEditCancel,
  onDelete,
  busy,
  keyword,
}: NotesListProps) {
  /** 类型计数（按全部行算，不随筛选变 —— 否则数字会越筛越小） */
  const counts = useMemo(() => {
    const out: Record<RowCategory, number> = { written: 0, mark: 0, note: 0, favorite: 0 };
    for (const r of rows) out[r.category] += 1;
    return out;
  }, [rows]);

  /** 筛选后的行 */
  const filtered = useMemo(
    () => (category === null ? rows : rows.filter((r) => r.category === category)),
    [rows, category],
  );

  /** 分组视图：按 groupTitle 聚合，组内按时间倒序 */
  const groups = useMemo(() => {
    const map = new Map<string, UnifiedRow[]>();
    for (const r of filtered) {
      const arr = map.get(r.groupTitle);
      if (arr) arr.push(r);
      else map.set(r.groupTitle, [r]);
    }
    const out = [...map.entries()].map(([title, items]) => ({
      title,
      items: [...items].sort((a, b) => (a.at < b.at ? 1 : -1)),
    }));
    /* 条目多的资料排前面，空组自然不存在 */
    out.sort((a, b) => b.items.length - a.items.length);
    return out;
  }, [filtered]);

  /** 不分组视图：全部混在一起，按时间倒序 */
  const flat = useMemo(
    () => [...filtered].sort((a, b) => (a.at < b.at ? 1 : -1)),
    [filtered],
  );

  const renderRow = (r: UnifiedRow) => {
    const noteId = r.noteId;
    const isEditing = Boolean(noteId && editing && editing[noteId] !== undefined);

    /* 编辑态：整条换成文本框 + 保存/取消（2026-11-11 晚） */
    if (r.category === 'written' && noteId && isEditing && editing) {
      return (
        <li key={r.key} className={`nl-item nl-item--${r.category}`}>
          <div className="nl-edit">
            <textarea
              className="nl-edit__area"
              rows={Math.min(10, Math.max(3, editing[noteId]!.split('\n').length + 1))}
              value={editing[noteId]}
              onChange={(e) => onEditChange?.(noteId, e.target.value)}
            />
            <div className="nl-edit__acts">
              <button
                type="button"
                className="btn-fill btn-fill--sm"
                disabled={busy}
                onClick={() => onEditSave?.(noteId)}
              >
                {busy ? '保存中…' : '保存'}
              </button>
              <button type="button" className="btn-text" onClick={() => onEditCancel?.(noteId)}>
                取消
              </button>
            </div>
          </div>
        </li>
      );
    }

    return (
      <li key={r.key} className={`nl-item nl-item--${r.category}`}>
        <button
          type="button"
          className="nl-item__btn"
          onClick={() => onOpen(r)}
          title={r.sourceId ? '回到原文这一处' : '打不开原文'}
        >
          <span className="nl-item__top">
            <span className={`nl-tag nl-tag--${r.category}`}>
              {r.category === 'mark' && r.markKind
                ? (MARK_KIND_LABEL[r.markKind] ?? CATEGORY_LABEL.mark)
                : CATEGORY_LABEL[r.category]}
            </span>
            {/* 不分组时要把归属说出来，否则不知道这条属于哪份资料 */}
            {!grouped ? <span className="nl-item__belong">{r.groupTitle}</span> : null}
            {r.page !== null ? <span className="nl-item__page">第 {r.page} 页</span> : null}
            <span className="nl-item__time">{formatWhen(r.at)}</span>
          </span>
          <span className="nl-item__text">
            <MathText text={r.text} />
          </span>
          {r.quote && r.category === 'note' ? (
            <span className="nl-item__quote">
              「<MathText text={r.quote} />」
            </span>
          ) : null}
        </button>

        {/* 手写笔记可以编辑 / 删除；标注与备注在阅读器里管 */}
        {r.category === 'written' && noteId ? (
          <div className="nl-item__acts">
            {onEditStart ? (
              <button
                type="button"
                className="btn-text"
                onClick={() => onEditStart(noteId, r.text)}
              >
                编辑
              </button>
            ) : null}
            {onDelete ? (
              <button type="button" className="btn-text" onClick={() => onDelete(noteId)}>
                删除
              </button>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <div className="nl">
      {/*
        类型筛选（2026-11-11 晚）。
        用户原话：「按资料看单个资料里面也要进行分类，你虽然已经进行分类，
        但是按钮不能点击。」—— 原来是不可点的统计文字，现在是真按钮。
      */}
      <div className="nl-filters" role="group" aria-label="按类型筛选">
        <button
          type="button"
          className={`nl-filter${category === null ? ' nl-filter--on' : ''}`}
          aria-pressed={category === null}
          onClick={() => onCategoryChange(null)}
        >
          全部
          <span className="nl-filter__n">{rows.length}</span>
        </button>
        {(Object.keys(CATEGORY_LABEL) as RowCategory[]).map((cat) => {
          const n = counts[cat];
          if (n === 0) return null;
          const on = category === cat;
          return (
            <button
              key={cat}
              type="button"
              className={`nl-filter nl-filter--${cat}${on ? ' nl-filter--on' : ''}`}
              aria-pressed={on}
              onClick={() => onCategoryChange(on ? null : cat)}
            >
              {CATEGORY_LABEL[cat]}
              <span className="nl-filter__n">{n}</span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <p className="nl-nohit">
          {keyword
            ? `没有匹配「${keyword}」的内容。`
            : category
              ? `还没有${CATEGORY_LABEL[category]}。`
              : '没有可显示的内容。'}
        </p>
      ) : grouped ? (
        groups.map((g) => (
          <section key={g.title} className="nl-group">
            <header className="nl-group__head">
              <span className="nl-group__title">{g.title}</span>
              <span className="nl-group__n">{g.items.length}</span>
            </header>
            <ul className="nl-list">{g.items.map(renderRow)}</ul>
          </section>
        ))
      ) : (
        <ul className="nl-list nl-list--flat">{flat.map(renderRow)}</ul>
      )}
    </div>
  );
}

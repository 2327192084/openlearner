/**
 * 学习笔记 · 按资料分类（2026-11-11）。
 *
 * ## 用户需求
 *
 * 「学习笔记按资料分类，显示标注/备注/收藏的知识点，点击回原文。」
 *
 * 所以这一栏要汇总三种东西，全部按**资料**归组：
 *  1. **标注**（`TextMark` kind = highlight / underline / strikethrough）
 *  2. **备注**（`TextMark` kind = note，含整页备注）
 *  3. **收藏的知识点**（`KnowledgePoint.favorite === true`）
 *
 * 每一项都能点回原文 —— 这是用户提这条需求时的原话。
 *
 * ## 为什么和「全部笔记」并列而不是替换它
 *
 * 现有的「全部笔记」列的是 `Note`（挂在题目 / 知识点上的自由文字），
 * 那是另一种东西：它是**用户写的话**，而这里有**原文上的位置**。
 * 两者数据源、跳转方式都不同，合并会让两边都变糊。
 * 所以页签并列：`全部笔记 | 按资料看`。
 *
 * ## 为什么单独一个文件
 *
 * `NotesPage.tsx` 已 360 行，且这一块逻辑（读三类数据 + 按资料分组）
 * 与「全部笔记」完全不同。硬约束 5：新增 UI 一律独立文件。
 */

import { useMemo } from 'react';
import type { KnowledgePoint, Source, TextMark } from '@/core/model.ts';
import { MathText } from './MathText.tsx';

/** 一条可点击回原文的条目 */
export interface DocItem {
  /** 稳定 key */
  id: string;
  /** 标注 / 备注 / 收藏 */
  category: 'mark' | 'note' | 'favorite';
  /** 页码（收藏的知识点可能没有页码） */
  page: number | null;
  /** 主文字：备注内容 / 知识点表述 */
  text: string;
  /** 被标注的原文引文（备注与标注有，收藏没有） */
  quote: string | null;
  /** 字符偏移（回原文时定位用） */
  charStart?: number;
  charEnd?: number;
  /** 标记种类（决定图标与颜色） */
  markKind?: TextMark['kind'];
  createdAt: string;
}

/** 一份资料的汇总 */
export interface DocGroup {
  sourceId: string | null;
  title: string;
  items: DocItem[];
  counts: { mark: number; note: number; favorite: number };
}

const CATEGORY_LABEL: Record<DocItem['category'], string> = {
  mark: '标注',
  note: '备注',
  favorite: '收藏',
};

/** 标注的三种姿态，用文字说清是哪一种 */
const MARK_KIND_LABEL: Record<string, string> = {
  highlight: '高亮',
  underline: '下划线',
  strikethrough: '删除线',
};

export interface NotesBySourceProps {
  /** 全部注释记录（含 textMarks） */
  annotations: readonly { sourceId: string; page: number; textMarks?: TextMark[] }[];
  /** 收藏的知识点 */
  favorites: readonly KnowledgePoint[];
  /** 资料列表（取标题、判断是否还在库里） */
  sources: readonly Source[];
  /** 点一条：回原文那一处 */
  onOpen: (item: DocItem, sourceId: string | null) => void;
  /** 关键词过滤 */
  keyword: string;
}

export function NotesBySource({
  annotations,
  favorites,
  sources,
  onOpen,
  keyword,
}: NotesBySourceProps) {
  /** 把三类数据折进「资料 → 条目」的结构 */
  const groups = useMemo<DocGroup[]>(() => {
    const srcById = new Map(sources.map((s) => [s.id, s]));
    const bySource = new Map<string | null, DocItem[]>();

    const push = (sourceId: string | null, item: DocItem) => {
      const arr = bySource.get(sourceId);
      if (arr) arr.push(item);
      else bySource.set(sourceId, [item]);
    };

    /* 1) 标注与备注 */
    for (const a of annotations) {
      for (const m of a.textMarks ?? []) {
        const isNote = m.kind === 'note';
        push(a.sourceId, {
          id: m.id,
          category: isNote ? 'note' : 'mark',
          page: a.page,
          /* 备注优先显示用户写的话；没有就退回引文 */
          text: isNote ? (m.note?.trim() || '（这条备注没有写内容）') : (m.anchor.exact ?? ''),
          quote: isNote ? (m.anchor.exact ?? null) : null,
          charStart: m.anchor.start,
          charEnd: m.anchor.end,
          markKind: m.kind,
          createdAt: m.createdAt,
        });
      }
    }

    /* 2) 收藏的知识点 */
    for (const kp of favorites) {
      const first = kp.anchors[0];
      push(kp.sourceId ?? null, {
        id: kp.id,
        category: 'favorite',
        page: first?.page ?? null,
        text: kp.statement,
        quote: kp.quotes[0] ?? null,
        ...(first?.charStart !== undefined ? { charStart: first.charStart } : {}),
        ...(first?.charEnd !== undefined ? { charEnd: first.charEnd } : {}),
        createdAt: kp.updatedAt,
      });
    }

    /* 排序：标注/备注按页码，收藏按页码；同页里标注在前 */
    const order: Record<DocItem['category'], number> = { mark: 0, note: 1, favorite: 2 };

    const out: DocGroup[] = [];
    for (const [sourceId, items] of bySource) {
      items.sort((a, b) => {
        const pa = a.page ?? 9999;
        const pb = b.page ?? 9999;
        if (pa !== pb) return pa - pb;
        if (a.category !== b.category) return order[a.category] - order[b.category];
        return (a.charStart ?? 0) - (b.charStart ?? 0);
      });

      const src = sourceId ? srcById.get(sourceId) : undefined;
      out.push({
        sourceId,
        /* 资料被删了也要如实显示，而不是假装它还在 */
        title: src?.title ?? (sourceId ? '（这份资料已删除）' : '未归属资料'),
        items,
        counts: {
          mark: items.filter((i) => i.category === 'mark').length,
          note: items.filter((i) => i.category === 'note').length,
          favorite: items.filter((i) => i.category === 'favorite').length,
        },
      });
    }

    /* 条目多的资料排前面 */
    out.sort((a, b) => b.items.length - a.items.length);
    return out;
  }, [annotations, favorites, sources]);

  /** 关键词过滤（条目文字 + 引文 + 资料标题） */
  const shown = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return groups;
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (i) =>
            i.text.toLowerCase().includes(kw) ||
            (i.quote ?? '').toLowerCase().includes(kw) ||
            g.title.toLowerCase().includes(kw),
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, keyword]);

  const totalItems = groups.reduce((n, g) => n + g.items.length, 0);

  if (totalItems === 0) {
    return (
      <div className="nbs-empty">
        <p>还没有标注、备注或收藏的知识点。</p>
        <p className="nbs-empty__hint">
          在阅读器里选中文字可以加标注和备注；在知识库里点 ☆ 可以收藏知识点。
        </p>
      </div>
    );
  }

  return (
    <div className="nbs">
      {shown.length === 0 ? (
        <p className="nbs-nohit">没有匹配「{keyword}」的内容。</p>
      ) : (
        shown.map((g) => (
          <section key={g.sourceId ?? '__none__'} className="nbs-group">
            <header className="nbs-group__head">
              <span className="nbs-group__title">{g.title}</span>
              <span className="nbs-group__counts">
                {g.counts.mark > 0 ? <span>标注 {g.counts.mark}</span> : null}
                {g.counts.note > 0 ? <span>备注 {g.counts.note}</span> : null}
                {g.counts.favorite > 0 ? <span>收藏 {g.counts.favorite}</span> : null}
              </span>
            </header>

            <ul className="nbs-list">
              {g.items.map((it) => (
                <li key={`${it.category}-${it.id}`} className={`nbs-item nbs-item--${it.category}`}>
                  <button
                    type="button"
                    className="nbs-item__btn"
                    onClick={() => onOpen(it, g.sourceId)}
                    title="回到原文这一处"
                  >
                    <span className="nbs-item__top">
                      <span className={`nbs-tag nbs-tag--${it.category}`}>
                        {it.category === 'mark' && it.markKind
                          ? (MARK_KIND_LABEL[it.markKind] ?? CATEGORY_LABEL.mark)
                          : CATEGORY_LABEL[it.category]}
                      </span>
                      {it.page !== null ? (
                        <span className="nbs-item__page">第 {it.page} 页</span>
                      ) : null}
                    </span>

                    <span className="nbs-item__text">
                      <MathText text={it.text} />
                    </span>

                    {/* 备注显示被标注的原文；标注本身已经显示原文了，不重复 */}
                    {it.quote && it.category === 'note' ? (
                      <span className="nbs-item__quote">
                        「<MathText text={it.quote} />」
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

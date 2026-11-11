/**
 * 学习笔记。
 *
 * ## 这一页解决什么
 *
 * 笔记是**挂在具体内容上**的：某道题、某个知识点、某份资料。
 * 所以这一页有两件事：
 *  1. 列出全部笔记，能搜、能按来源过滤；
 *  2. 能就地在某条笔记下面补写 / 改 / 删。
 *
 * ## 为什么不做一个「空白笔记本」
 *
 * 脱离上下文的笔记本在复习工具里很少被翻开 ——
 * 而挂在具体题上的笔记，复习到那一题时就会看到（见 ReviewPage 的接入）。
 * 这一页是「回头看全部笔记」的入口，不是主要写作入口。
 *
 * ## 「所属内容已删除」要如实标出来
 *
 * 题或资料被删了之后，笔记本身还留在库里（级联清理是尽力而为的，
 * 删库操作失败时不该连带丢笔记）。这种孤儿笔记要显示成
 * 「（所属内容已删除）」，而不是假装它还有归属 ——
 * 否则用户点进去会看到一个不存在的题目。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Note, Question, Source, TextMark, KnowledgePoint } from '@/core/model.ts';
import type { NoteService } from '@/core/notes.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { SourceService } from '@/core/sources.ts';
import type { AnnotationService } from '@/core/annotation-service.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import { EmptyCard } from './EmptyCard.tsx';
import { NotesBySource } from './NotesBySource.tsx';
import { IconNotes } from './icons.tsx';

export interface NotesPageProps {
  notes: NoteService;
  decks: DeckService;
  sourceService: SourceService;
  knowledge: KnowledgeService;
  /** 注释服务（读标注与备注，2026-11-11） */
  annotations?: AnnotationService;
  /** 去阅读器看原文 */
  onOpenSource: (sourceId: string) => void;
  /**
   * 去阅读器**定位到某一页某一处**（2026-11-11）。
   *
   * 「按资料看」里每一条都要能点回原文的那一处，而不只是打开那份资料。
   * 不传就退回 onOpenSource（只能到资料，不能到具体页）。
   */
  onOpenSourceAt?: (sourceId: string, page: number, quote?: string) => void;
  /** 去知识库 */
  onOpenKnowledge: () => void;
}

/** 一条展示用的笔记（带解析出来的归属标题） */
interface NoteRow {
  note: Note;
  /** 归属描述，如「题目：xxx」/「资料：xxx」 */
  belongsTo: string;
  /** 归属是否还在库里 */
  alive: boolean;
  /** 可跳转的资料 id（有就显示「看原文」） */
  sourceId: string | null;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; rows: NoteRow[]; sources: Source[] };

export function NotesPage({
  notes,
  decks,
  sourceService,
  knowledge,
  annotations,
  onOpenSource,
  onOpenSourceAt,
  onOpenKnowledge,
}: NotesPageProps) {
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [keyword, setKeyword] = useState('');
  /** 编辑中的笔记 id → 草稿正文 */
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  /**
   * 页签（2026-11-11）：全部笔记 / 按资料看。
   * 默认停在「全部笔记」—— 那是原有行为，不能因为加了新页签就改变默认落点。
   */
  const [tab, setTab] = useState<'notes' | 'bySource'>('notes');
  /** 「按资料看」自己的关键词与数据 */
  const [docKeyword, setDocKeyword] = useState('');
  const [docAnnotations, setDocAnnotations] = useState<
    readonly { sourceId: string; page: number; textMarks?: TextMark[] }[]
  >([]);
  const [docFavorites, setDocFavorites] = useState<readonly KnowledgePoint[]>([]);

  /**
   * 载入标注 / 备注 / 收藏（2026-11-11）。
   *
   * 与「全部笔记」分开加载：它要读另一个分区（sourceAnnotations）
   * 和收藏筛选，放进主 load() 会让那次 Promise.all 多等几秒，
   * 而大多数人打开这一页只是想看自己写的笔记。
   */
  const loadDocs = useCallback(async () => {
    if (!annotations || !knowledge) return;
    try {
      const [anns, favs] = await Promise.all([
        annotations.listAll(),
        knowledge.listFavorites(),
      ]);
      setDocAnnotations(anns);
      setDocFavorites(favs);
    } catch {
      /* 读不到就显示空态，不阻塞「全部笔记」那一栏 */
      setDocAnnotations([]);
      setDocFavorites([]);
    }
  }, [annotations, knowledge]);

  useEffect(() => {
    if (tab === 'bySource') void loadDocs();
  }, [tab, loadDocs]);

  /** 两条数据的总数（页签上的数字） */
  const docTotal =
    docAnnotations.reduce((n, a) => n + (a.textMarks?.length ?? 0), 0) + docFavorites.length;

  const load = useCallback(async () => {
    try {
      const [allNotes, srcs, deckList] = await Promise.all([
        notes.list(),
        sourceService.list(),
        decks.list(),
      ]);

      /* 题目：把已发布题组里的题一次性取出来建索引 */
      const published = deckList.filter((d) => d.status === 'published');
      const questions = await Promise.all(published.map((d) => decks.getQuestions(d.id)));
      const qById = new Map<string, Question>();
      for (const arr of questions) for (const q of arr) qById.set(q.id, q);
      /* 草稿题组的题也要能解析出来（用户可能给草稿题写过笔记） */
      const drafts = deckList.filter((d) => d.status !== 'published');
      for (const d of drafts) {
        for (const q of await decks.getQuestions(d.id)) qById.set(q.id, q);
      }

      const srcById = new Map(srcs.map((s: Source) => [s.id, s]));

      const rows: NoteRow[] = [];
      for (const n of allNotes) {
        let belongsTo = '';
        let alive = false;
        let sourceId: string | null = null;

        if (n.cardId) {
          const q = qById.get(n.cardId);
          if (q) {
            alive = true;
            belongsTo = `题目：${firstLine(q.prompt)}`;
            /* 题目本身没存 sourceId，要经题组拿 */
            const deck = deckList.find((d) => d.id === q.deckId);
            sourceId = deck?.sourceId ?? null;
          } else {
            /* 可能是知识点 —— 知识点也是「卡片」 */
            const kp = await knowledge.get(n.cardId);
            if (kp) {
              alive = true;
              belongsTo = `知识点：${firstLine(kp.statement)}`;
              sourceId = kp.sourceId ?? null;
            } else {
              belongsTo = '（所属内容已删除）';
            }
          }
        } else if (n.sourceId) {
          const s = srcById.get(n.sourceId);
          if (s) {
            alive = true;
            belongsTo = `资料：${s.title}`;
            sourceId = s.id;
          } else {
            belongsTo = '（所属资料已删除）';
          }
        } else {
          belongsTo = '（未关联）';
        }

        rows.push({ note: n, belongsTo, alive, sourceId });
      }

      setState({ kind: 'ready', rows, sources: srcs });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : '读不出笔记',
      });
    }
  }, [notes, sourceService, decks, knowledge]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = state.kind === 'ready' ? state.rows : [];

  /** 关键词过滤（笔记正文 + 归属描述） */
  const visible = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return rows;
    return rows.filter(
      (r) =>
        r.note.body.toLowerCase().includes(kw) || r.belongsTo.toLowerCase().includes(kw),
    );
  }, [rows, keyword]);

  async function saveEdit(id: string) {
    const draft = editing[id];
    if (draft === undefined) return;
    setBusy(true);
    try {
      await notes.update(id, draft);
      setEditing((e) => {
        const next = { ...e };
        delete next[id];
        return next;
      });
      await load();
      setFlash('已保存');
      setTimeout(() => setFlash(null), 2000);
    } catch (err) {
      setFlash(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function removeNote(id: string) {
    setBusy(true);
    try {
      await notes.remove(id);
      await load();
      setFlash('已删除');
      setTimeout(() => setFlash(null), 2000);
    } catch (err) {
      setFlash(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === 'loading') {
    return (
      <div className="notes-page">
        <p className="nt-hint">正在读笔记…</p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="notes-page">
        <p className="nt-error">{state.message}</p>
      </div>
    );
  }

  return (
    <div className="notes-page">
      <header className="nt-head">
        <h1 className="nt-title">学习笔记</h1>
        <p className="nt-lead">
          笔记挂在具体的题、知识点或资料上。做题时想到的一句话、读原文时想留的标记，
          都记在这里；回头复习到那一题时也会看到。
        </p>
      </header>

      {flash ? <div className="nt-flash">{flash}</div> : null}

      {/*
        两个页签（2026-11-11）：
          - 全部笔记：用户在题 / 知识点上写的自由文字（Note）
          - 按资料看：原文上的标注与备注 + 收藏的知识点，
                      每一条都能点回原文

        为什么不合成一个列表：两者数据源不同、跳转方式也不同。
        硬混在一起会让「我写的一句话」和「我在原文上画的一道」看起来一样，
        而它们其实完全不是一回事。
      */}
      <div className="nt-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'notes'}
          className={`nt-tab${tab === 'notes' ? ' nt-tab--on' : ''}`}
          onClick={() => setTab('notes')}
        >
          全部笔记
          <span className="nt-tab__n">{rows.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'bySource'}
          className={`nt-tab${tab === 'bySource' ? ' nt-tab--on' : ''}`}
          onClick={() => setTab('bySource')}
        >
          按资料看
          <span className="nt-tab__n">{docTotal}</span>
        </button>
      </div>

      {tab === 'bySource' ? (
        <>
          {/*
            「按资料看」也有自己的搜索框。
            共用上面那个 keyword 是错的 —— 用户在「全部笔记」里搜的东西
            切到这一栏时应该清空，否则会看到一个莫名其妙的空列表。
          */}
          <div className="nt-toolbar">
            <input
              className="nt-search"
              type="search"
              placeholder="搜索标注、备注、收藏…"
              value={docKeyword}
              onChange={(e) => setDocKeyword(e.target.value)}
            />
          </div>
          <NotesBySource
            annotations={docAnnotations}
            favorites={docFavorites}
            sources={state.kind === 'ready' ? state.sources : []}
            keyword={docKeyword}
            onOpen={(item, sourceId) => {
              if (sourceId) onOpenSourceAt?.(sourceId, item.page ?? 1, item.quote ?? undefined);
              else if (item.category === 'favorite') onOpenKnowledge();
              else onOpenKnowledge();
            }}
          />
        </>
      ) : rows.length === 0 ? (
        /*
         * 空态用共享的 EmptyCard（2026-11-10 美化）。
         * 原来是一块左对齐的 padding + 三行字，在深色背景上几乎看不出
         * 「这一页是空的」——更像加载失败。换成纸卡后有了视觉重心。
         */
        <EmptyCard
          icon={<IconNotes size={22} />}
          title="还没有任何笔记"
          hint="笔记有两处入口：做题时在题目卡下方，或者在阅读器里给某份资料留一句。记下来的内容会在复习到那一题时再次出现。"
          action={{ label: '去知识库看看', onClick: onOpenKnowledge }}
        />
      ) : (
        <>
          {/* ---- 搜索 ---- */}
          <div className="nt-toolbar">
            <input
              className="nt-search"
              type="search"
              placeholder="搜索笔记内容或所属题目…"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
            <span className="nt-count">
              {visible.length === rows.length
                ? `${rows.length} 条笔记`
                : `${visible.length} / ${rows.length} 条`}
            </span>
          </div>

          {/* ---- 列表 ---- */}
          <ul className="nt-list">
            {visible.map((r) => {
              const isEditing = editing[r.note.id] !== undefined;
              return (
                <li key={r.note.id} className="nt-item">
                  <div className="nt-item__head">
                    <span
                      className={`nt-item__belong${r.alive ? '' : ' nt-item__belong--gone'}`}
                    >
                      {r.belongsTo}
                    </span>
                    <span className="nt-item__time">{formatWhen(r.note.updatedAt)}</span>
                  </div>

                  {isEditing ? (
                    <>
                      <textarea
                        className="nt-textarea"
                        value={editing[r.note.id]}
                        rows={Math.min(12, Math.max(3, (editing[r.note.id] ?? '').split('\n').length + 1))}
                        onChange={(e) =>
                          setEditing((prev) => ({ ...prev, [r.note.id]: e.target.value }))
                        }
                      />
                      <div className="nt-item__actions">
                        <button
                          type="button"
                          className="btn-fill btn-fill--sm"
                          onClick={() => void saveEdit(r.note.id)}
                          disabled={busy}
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          className="btn-text"
                          onClick={() =>
                            setEditing((prev) => {
                              const next = { ...prev };
                              delete next[r.note.id];
                              return next;
                            })
                          }
                        >
                          取消
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="nt-item__body">{r.note.body}</p>
                      <div className="nt-item__actions">
                        <button
                          type="button"
                          className="btn-text"
                          onClick={() =>
                            setEditing((prev) => ({ ...prev, [r.note.id]: r.note.body }))
                          }
                        >
                          编辑
                        </button>
                        {r.sourceId ? (
                          <button
                            type="button"
                            className="btn-text"
                            onClick={() => onOpenSource(r.sourceId!)}
                          >
                            看原文
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="nt-item__delete"
                          onClick={() => void removeNote(r.note.id)}
                          disabled={busy}
                        >
                          删除
                        </button>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>

          {visible.length === 0 ? (
            <p className="nt-hint">没有匹配「{keyword}」的笔记。</p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** 取第一行并截断，用于「所属：xxx」的简短描述 */
function firstLine(s: string, max = 40): string {
  const line = s.split('\n')[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 「11-07 18:20」 */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

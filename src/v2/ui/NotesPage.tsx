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
import { NotesList } from './NotesList.tsx';
import type { RowCategory, UnifiedRow } from './NotesList.tsx';
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
   * 是否按资料分组（2026-11-11 晚按用户纠正改为开关，不再是页签）。
   *
   * 用户原话：「那个『按资料分』不用单独做一个栏目，它就是全部笔记里的
   * 一个分类功能。不分类可以看到全部笔记混杂在一起，分类之后可以看到
   * 各资料对应的笔记。」
   *
   * 默认关（混杂看）—— 与用户描述的默认行为一致。
   */
  const [grouped, setGrouped] = useState(false);
  /** 类型筛选（标注 / 备注 / 收藏 / 手写笔记），null = 全部 */
  const [category, setCategory] = useState<RowCategory | null>(null);
  /** 标注 / 备注 / 收藏三种来源的数据 */
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
  /**
   * 载入标注 / 备注 / 收藏（2026-11-11）。
   *
   * ⚠️ 2026-11-11 晚修：原来只在**切到「按资料看」之后**才调，
   * 于是页签上的数字一开始是 0，点一下才变成真实数量 ——
   * 用户报的「未点击时显示 0，点击后才显示真实数量」就是这个。
   *
   * 现在进页面就并行取一次（数据量小：几十条标注 + 几十条知识点），
   * 两个页签的数字都从一开始就是对的。
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

  /**
   * 进页面就取，不等用户操作 —— 否则计数先是 0 再跳变。
   *
   * 用户报过「未点击时显示 0，点击后才显示真实数量」，
   * 根因就是这段加载曾经绑在页签切换上。现在进页面即取。
   */
  useEffect(() => {
    void loadDocs();
  }, [loadDocs]);

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

  /**
   * 把四种来源合并成统一的列表行（2026-11-11 晚，按用户纠正重做）。
   *
   * 用户的要求：「不分类可以看到全部笔记混杂在一起，分类之后可以看到
   * 各资料对应的笔记」。所以只有**一个**列表，四种来源全在里面：
   *   written（手写笔记）/ mark（标注）/ note（备注）/ favorite（收藏的知识点）
   *
   * 第一版把后三种放进单独页签，导致「全部笔记」是空的 ——
   * 用户库里 Note 记录确实是 0 条，但他理解的「笔记」包含标注与备注。
   */
  const unified = useMemo<UnifiedRow[]>(() => {
    const out: UnifiedRow[] = [];

    /* 1) 手写笔记（Note） */
    for (const r of rows) {
      out.push({
        key: `written-${r.note.id}`,
        category: 'written',
        sourceId: r.sourceId,
        /* 分组标题优先用资料名；没有资料就用归属描述（题目 / 知识点） */
        groupTitle: r.sourceId
          ? (state.kind === 'ready'
              ? (state.sources.find((s) => s.id === r.sourceId)?.title ?? r.belongsTo)
              : r.belongsTo)
          : r.belongsTo,
        page: null,
        text: r.note.body,
        quote: null,
        at: r.note.updatedAt,
        noteId: r.note.id,
        alive: r.alive,
      });
    }

    const srcById = new Map(
      (state.kind === 'ready' ? state.sources : []).map((s) => [s.id, s]),
    );

    /* 2) 标注与备注（TextMark） */
    for (const a of docAnnotations) {
      const src = srcById.get(a.sourceId);
      const groupTitle = src?.title ?? '（这份资料已删除）';
      for (const m of a.textMarks ?? []) {
        const isNote = m.kind === 'note';
        out.push({
          key: `${isNote ? 'note' : 'mark'}-${m.id}`,
          category: isNote ? 'note' : 'mark',
          sourceId: a.sourceId,
          groupTitle,
          page: a.page,
          text: isNote ? (m.note?.trim() || '（这条备注没有写内容）') : (m.anchor.exact ?? ''),
          quote: isNote ? (m.anchor.exact ?? null) : null,
          charStart: m.anchor.start,
          charEnd: m.anchor.end,
          markKind: m.kind,
          at: m.createdAt,
        });
      }
    }

    /* 3) 收藏的知识点 */
    for (const kp of docFavorites) {
      const first = kp.anchors[0];
      const src = kp.sourceId ? srcById.get(kp.sourceId) : undefined;
      out.push({
        key: `favorite-${kp.id}`,
        category: 'favorite',
        sourceId: kp.sourceId ?? null,
        groupTitle: src?.title ?? '未归属资料',
        page: first?.page ?? null,
        text: kp.statement,
        quote: kp.quotes[0] ?? null,
        ...(first?.charStart !== undefined ? { charStart: first.charStart } : {}),
        ...(first?.charEnd !== undefined ? { charEnd: first.charEnd } : {}),
        at: kp.updatedAt,
      });
    }

    return out;
  }, [rows, docAnnotations, docFavorites, state]);

  /** 关键词过滤（四种来源一视同仁） */
  const visibleUnified = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return unified;
    return unified.filter(
      (r) =>
        r.text.toLowerCase().includes(kw) ||
        (r.quote ?? '').toLowerCase().includes(kw) ||
        r.groupTitle.toLowerCase().includes(kw),
    );
  }, [unified, keyword]);

  /**
   * 关键词过滤（四种来源一视同仁）。
   *
   * ⚠️ 旧的 `visible`（只过滤手写笔记）已删除：
   * 现在列表统一走 `visibleUnified`，两边各留一份会让搜索结果不一致。
   */

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
        「按资料分」是一个**分组开关**，不是第二个栏目（2026-11-11 晚按用户纠正改）。

        用户原话：「那个『按资料分』不用单独做一个栏目，它就是全部笔记里的
        一个分类功能。不分类可以看到全部笔记混杂在一起，分类之后可以看到
        各资料对应的笔记。」

        所以只有一个列表，四种来源（手写笔记 / 标注 / 备注 / 收藏）全在里面：
          - 关：全部混在一起，按时间倒序
          - 开：同一份资料的聚在它的标题下
      */}
      <div className="nt-toolbar">
        <input
          className="nt-search"
          type="search"
          placeholder="搜索笔记、标注、备注、收藏…"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <button
          type="button"
          className={`nt-groupbtn${grouped ? ' nt-groupbtn--on' : ''}`}
          aria-pressed={grouped}
          title={grouped ? '取消分组，全部混在一起看' : '按资料分组'}
          onClick={() => setGrouped((v) => !v)}
        >
          {grouped ? '✓ 按资料分组' : '按资料分组'}
        </button>
        <span className="nt-count">
          {visibleUnified.length === unified.length
            ? `${unified.length} 条`
            : `${visibleUnified.length} / ${unified.length} 条`}
        </span>
      </div>

      {unified.length === 0 ? (
        /*
         * 空态用共享的 EmptyCard（2026-11-10 美化）。
         * 原来是一块左对齐的 padding + 三行字，在深色背景上几乎看不出
         * 「这一页是空的」——更像加载失败。换成纸卡后有了视觉重心。
         */
        <EmptyCard
          icon={<IconNotes size={22} />}
          title="还没有任何笔记"
          hint="笔记有四处入口：做题时在题目卡下方写，阅读器里选中文字加标注或备注，知识库里点 ☆ 收藏知识点。它们都会汇总到这里。"
          action={{ label: '去知识库看看', onClick: onOpenKnowledge }}
        />
      ) : (
        <NotesList
          rows={visibleUnified}
          grouped={grouped}
          category={category}
          onCategoryChange={setCategory}
          keyword={keyword}
          editing={editing}
          busy={busy}
          onEditStart={(id, body) =>
            setEditing((prev) => ({ ...prev, [id]: body }))
          }
          onEditChange={(id, draft) => setEditing((prev) => ({ ...prev, [id]: draft }))}
          onEditSave={(id) => void saveEdit(id)}
          onEditCancel={(id) =>
            setEditing((prev) => {
              const next = { ...prev };
              delete next[id];
              return next;
            })
          }
          onDelete={(id) => void removeNote(id)}
          onOpen={(row) => {
            if (row.sourceId) {
              onOpenSourceAt?.(row.sourceId, row.page ?? 1, row.quote ?? undefined);
            } else if (row.page !== null) {
              /* 有页码但没资料 id：至少能打开知识库看那条知识点 */
              onOpenKnowledge();
            } else {
              /* 挂在题或知识点上的手写笔记 → 去它的归属处看 */
              onOpenKnowledge();
            }
          }}
        />
      )}
    </div>
  );
}

/** 取第一行并截断，用于「所属：xxx」的简短描述 */
function firstLine(s: string, max = 40): string {
  const line = s.split('\n')[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

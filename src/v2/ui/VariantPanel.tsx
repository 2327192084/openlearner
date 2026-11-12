/**
 * 变式出题面板（2026-11-12）。
 *
 * ## 用户要求
 *
 * 「出题方式太单一了……让 AI 对特定的知识点，或是错题进行变式。」
 *
 * 面板给两个来源，正好对应用户说的两件事：
 *  - **从错题变式** —— 挑做错的题，出同类不同问法的新题
 *  - **从知识点变式** —— 挑知识点，出同一考点的多种考法
 *
 * ## 为什么单独一个组件
 *
 * `GeneratePage.tsx` 已 600+ 行、`App.tsx` 1988 行。
 * 硬约束：新增 UI 一律独立文件。
 *
 * ## 与 GeneratePage 的分工
 *
 * 本组件只负责「选来源 + 选维度 + 选数量」，然后**回调给宿主**去真正生成。
 * 生成链路（后端、进度、落库）复用 GeneratePage 已有的那套 ——
 * 不在这里重写一遍，避免两套出题逻辑各自演化。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KnowledgePoint, Question, Source } from '@/core/model.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { SourceService } from '@/core/sources.ts';
import {
  VARIANT_AXES,
  type VariantAxis,
  type VariantAxisInfo,
} from '@/core/questions/variants.ts';
import { disambiguateTitles } from '@/core/source-title.ts';
import './variant-panel.css';

/** 变式来源 */
export type VariantSource = 'wrong' | 'knowledge';

/** 选中要变式的东西 */
export interface VariantSelection {
  source: VariantSource;
  /** 错题变式时：选中的题目 id */
  questionIds: string[];
  /** 知识点变式时：选中的知识点 id */
  pointIds: string[];
  axes: VariantAxis[];
  /** 要出几道 */
  count: number;
}

export interface VariantPanelProps {
  decks: DeckService;
  knowledge: KnowledgeService;
  sources: SourceService;
  /**
   * 复习服务。用来取**真实做错过的题**（2026-11-12）。
   *
   * ## 为什么不用 decks.getWrongQuestions()
   *
   * 那走的是 `answerRecords`（题目作答记录），而用户实际做题走的是
   * **卡片复习**，记录在 `reviewLogs`。实测用户的库：
   * `answerRecords` 是空数组，`reviewLogs` 有 47 条、33 条 `again` ——
   * 首页「错 3 次」显示的就是后者。用前者会让面板永远说「还没有错题」。
   *
   * `cards-loader.ts:78` 里 `card.id === question.id`，所以 reviewLogs 的
   * `cardId` 可以直接当题目 id 用（实测 24 个错题卡片里 9 个能匹配到现存题目）。
   */
  review: ReviewServiceLike;
  /** 点「开始变式」时回调宿主去生成 */
  onStart: (sel: VariantSelection) => void;
  /**
   * 进入时预选（2026-11-12）。
   *
   * 用户从错题页点某题的「出变式题」跳来时带上那一题，
   * 面板直接切到「从错题变式」并勾上它 ——
   * 不这样的话用户还得自己在列表里找一遍，等于入口只做了一半。
   */
  preselect?: { questionIds: string[] } | null;
  /** 生成中禁用 */
  busy?: boolean;
}

/** 只用到 reviewService 的一个方法，避免把整个服务类型拖进来 */
export interface ReviewServiceLike {
  wrongCardsDetailed: () => Promise<
    { cardId: string; wrongCount: number; reviewCount: number; lastWrongDay: string }[]
  >;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' };

export function VariantPanel({ decks, knowledge, sources, review, onStart, preselect, busy }: VariantPanelProps) {
  const [source, setSource] = useState<VariantSource>('wrong');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  /** 错题列表（带次数，用来排序：错得多的排前面） */
  const [wrongs, setWrongs] = useState<Array<{ question: Question; wrongCount: number }>>([]);
  /** 可选知识点，按资料分组 */
  const [pointsBySource, setPointsBySource] = useState<Array<{ source: Source; points: KnowledgePoint[] }>>([]);

  const [pickedQ, setPickedQ] = useState<Set<string>>(new Set());
  const [pickedP, setPickedP] = useState<Set<string>>(new Set());
  const [axes, setAxes] = useState<VariantAxis[]>(['context']);
  const [count, setCount] = useState('5');

  /* 载入数据 */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        /*
         * 错题从 reviewLogs 取（用户真实做题的地方），再回查题目表。
         *
         * 找不到对应题目的错题记录直接丢掉 —— 那些是「题目已删但复习记录还在」
         * 的孤儿记录，拿它们变式没有意义（没有题干可参照）。
         */
        const [detail, srcs] = await Promise.all([
          review.wrongCardsDetailed(),
          sources.list(),
        ]);
        if (!alive) return;

        /*
         * 逐题回查：wrongCardsDetailed 只给 cardId + 次数，
         * 题目本体要另外取。用 decks.getQuestion 逐条查（只查做错过的那些，
         * 通常十几个，不开销）。
         */
        const rows: Array<{ question: Question; wrongCount: number }> = [];
        for (const d of detail) {
          if (d.wrongCount <= 0) continue;
          try {
            const q = await decks.getQuestion(d.cardId);
            if (q) rows.push({ question: q, wrongCount: d.wrongCount });
          } catch {
            /* 单条读不出来不影响其它 */
          }
        }

        const groups: Array<{ source: Source; points: KnowledgePoint[] }> = [];
        for (const s of srcs) {
          const pts = await knowledge.listBySource(s.id);
          if (pts.length > 0) groups.push({ source: s, points: pts });
        }
        if (!alive) return;

        /* 错得多的排前面 —— 最该变式的就是反复错的那些 */
        rows.sort((a, b) => b.wrongCount - a.wrongCount);
        setWrongs(rows);
        setPointsBySource(groups);
        setLoad({ kind: 'ready' });

        /*
         * 应用预选（2026-11-12）。
         *
         * 放在载入之后：预选的题必须真在列表里才勾得上。
         * 找不到就不勾（那道题可能已经被删了），并让用户看到空勾选 + 提示，
         * 而不是勾上一个不存在的 id。
         */
        if (preselect && preselect.questionIds.length > 0) {
          const avail = new Set(rows.map((r) => r.question.id));
          const hit = preselect.questionIds.filter((id) => avail.has(id));
          setSource('wrong');
          if (hit.length > 0) setPickedQ(new Set(hit));
        }
      } catch (e) {
        if (alive) setLoad({ kind: 'error', message: e instanceof Error ? e.message : '读不出数据' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [decks, knowledge, sources, review, preselect]);

  /* 资料重名消歧（两处入口共用同一套编号规则） */
  const titles = useMemo(
    () => disambiguateTitles(pointsBySource.map((g) => g.source)),
    [pointsBySource],
  );

  const toggle = useCallback(
    (set: Set<string>, id: string, apply: (next: Set<string>) => void) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      apply(next);
    },
    [],
  );

  const axisToggle = useCallback((id: VariantAxis) => {
    setAxes((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const pickedCount = source === 'wrong' ? pickedQ.size : pickedP.size;
  const canStart = !busy && pickedCount > 0 && Number(count) > 0;

  const start = useCallback(() => {
    if (!canStart) return;
    onStart({
      source,
      questionIds: [...pickedQ],
      pointIds: [...pickedP],
      axes,
      count: Math.max(1, Math.min(50, Number(count) || 1)),
    });
  }, [canStart, onStart, source, pickedQ, pickedP, axes, count]);

  if (load.kind === 'loading') {
    return <p className="vp-hint">正在读数据…</p>;
  }
  if (load.kind === 'error') {
    return <p className="vp-hint vp-hint--bad">{load.message}</p>;
  }

  const hasWrong = wrongs.length > 0;
  const hasPoints = pointsBySource.length > 0;

  return (
    <div className="vp">
      {/* ---- 来源 ---- */}
      <div className="vp-block">
        <span className="vp-label">变式来源</span>
        <div className="vp-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={source === 'wrong'}
            className={`vp-tab${source === 'wrong' ? ' vp-tab--on' : ''}`}
            onClick={() => setSource('wrong')}
          >
            从错题变式
            {hasWrong ? <span className="vp-tab__n">{wrongs.length}</span> : null}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={source === 'knowledge'}
            className={`vp-tab${source === 'knowledge' ? ' vp-tab--on' : ''}`}
            onClick={() => setSource('knowledge')}
          >
            从知识点变式
            {hasPoints ? (
              <span className="vp-tab__n">
                {pointsBySource.reduce((n, g) => n + g.points.length, 0)}
              </span>
            ) : null}
          </button>
        </div>
      </div>

      {/* ---- 选条目 ---- */}
      {source === 'wrong' ? (
        hasWrong ? (
          <div className="vp-block">
            <span className="vp-label">
              选要做变式的错题（错得多的排前面）
            </span>
            <ul className="vp-list">
              {wrongs.slice(0, 40).map(({ question, wrongCount }) => (
                <li key={question.id} className="vp-item">
                  <label className="vp-item__row">
                    <input
                      type="checkbox"
                      checked={pickedQ.has(question.id)}
                      onChange={() => toggle(pickedQ, question.id, setPickedQ)}
                    />
                    <span className="vp-item__text">{question.prompt.slice(0, 80)}</span>
                    <span className="vp-item__badge">错 {wrongCount} 次</span>
                  </label>
                </li>
              ))}
            </ul>
            {wrongs.length > 40 ? (
              <p className="vp-hint">只列了前 40 条（按错题次数），先在这批里挑。</p>
            ) : null}
          </div>
        ) : (
          <div className="vp-block">
            <p className="vp-hint">
              还没有错题记录。先去「错题与待巩固」练几轮，或者换成从知识点变式。
            </p>
          </div>
        )
      ) : hasPoints ? (
        <div className="vp-block">
          <span className="vp-label">选要变式的知识点</span>
          {pointsBySource.map((g) => (
            <div key={g.source.id} className="vp-group">
              <p className="vp-group__title">
                {titles.get(g.source.id) ?? g.source.title}
              </p>
              <ul className="vp-list">
                {g.points.slice(0, 12).map((p) => (
                  <li key={p.id} className="vp-item">
                    <label className="vp-item__row">
                      <input
                        type="checkbox"
                        checked={pickedP.has(p.id)}
                        onChange={() => toggle(pickedP, p.id, setPickedP)}
                      />
                      <span className="vp-item__text">{p.statement.slice(0, 80)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <div className="vp-block">
          <p className="vp-hint">
            还没有已定位的知识点。到「整理知识点」把资料过一遍再来。
          </p>
        </div>
      )}

      {/* ---- 变式维度 ---- */}
      <div className="vp-block">
        <span className="vp-label">怎么变（可多选）</span>
        <div className="vp-axes">
          {VARIANT_AXES.map((a: VariantAxisInfo) => (
            <button
              key={a.id}
              type="button"
              aria-pressed={axes.includes(a.id)}
              className={`vp-axis${axes.includes(a.id) ? ' vp-axis--on' : ''}`}
              onClick={() => axisToggle(a.id)}
              title={a.desc}
            >
              <span className="vp-axis__label">{a.label}</span>
              <span className="vp-axis__desc">{a.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ---- 数量与开始 ---- */}
      <div className="vp-block vp-foot">
        <label className="vp-count">
          <span className="vp-label">出几道</span>
          <input
            type="number"
            min={1}
            max={50}
            value={count}
            onChange={(e) => setCount(e.target.value)}
            className="vp-count__input"
            disabled={busy}
          />
        </label>
        <button
          type="button"
          className="btn-fill btn-fill--sm"
          onClick={start}
          disabled={!canStart}
        >
          {busy ? '正在生成…' : '开始变式'}
        </button>
      </div>

      {pickedCount === 0 ? (
        <p className="vp-hint">先在上面勾选要变式的条目。</p>
      ) : null}
    </div>
  );
}

/**
 * 任务页：后台做过什么、成败如何、花了多少。
 *
 * ## 为什么这一页值得先做
 *
 * 现在「整理知识点」和「出题」都是耗时操作（一本书要跑几分钟），
 * 失败时用户只看到一句报错就没了 —— 具体哪一份资料、什么时候、
 * 失败原因是什么，全部查不到。这一页把 `generationRuns` 摊开：
 * 谁、什么时候、跑了多久、产出多少、为什么失败。
 *
 * ## 数据全部来自现有分区，不新增存储
 *
 * `generationRuns`（整理与出题的运行记录）与 `usageRecords`（用量）
 * 是 v2 已经在写的两张表。这一页**只读**，不改任何数据 ——
 * 所以不会有 schema 迁移、不会动用户已有内容。
 *
 * ## 为什么要把「运行记录」和「用量」放在一起
 *
 * 用户问的其实是同一个问题：「我刚花的钱和刚才那次操作，对得上吗」。
 * 分两个页面看要来回切，而且时间线对不齐。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';import type { Deck, GenerationRun, Source, UsageRecord } from '@/core/model.ts';
import type { SourceService } from '@/core/sources.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { UsageService } from '@/core/usage.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import { ConfirmDialog } from './dialog.tsx';

export interface TasksPageProps {
  sourceService: SourceService;
  decks: DeckService;
  usage: UsageService;
  /** 读整理记录（KnowledgeService.listRuns） */
  knowledge: KnowledgeService;
  /** 去整理知识点 */
  onOpenOrganize: (sourceId: string | null) => void;
  /** 去我的题组 */
  onOpenDecks: () => void;
  /**
   * 删除一条任务记录（2026-11-08）。
   *
   * 只删 generationRuns 里的记录，**不动**知识点与题目 ——
   * 用户想清掉一条失败历史，不该顺手删掉劳动成果。
   * 不传则不显示删除按钮（不摆假按钮）。
   */
  onRemoveRun?: (id: string) => Promise<void>;
  /** 清空全部任务记录 */
  onClearRuns?: () => Promise<void>;
}

/**
 * 一条展示用的运行记录。
 *
 * ## 2026-11-08 的改动（原来这里写着「generationRuns 只记整理」）
 *
 * 那条注释当时是对的，但造成了一个真实问题：出题不写 run，
 * 于是任务页只能从 `decks.createdAt` 反推，**token 永远是 null**。
 * 用户看到的「最近一次任务没统计 token」就是这么来的 ——
 * 而实际上出题确实记了账（真实数据里 11-08 那组 51861 token），
 * 只是记在按天聚合的 usageRecords 里，跟这一行关联不上。
 *
 * 现在 `DeckService.generate` 也会写一条 `kind='questions'` 的 run，
 * 带 deckId 与 actualTokens。所以：
 *  - 有 run 的出题 → 显示真实 token 与耗时
 *  - 老题组没有 run → 仍然走 deck 反推的兜底行，token 如实显示「—」
 *
 * 不把「不知道」写成 0：0 是「花了但没花」，是假数据。
 */
interface RunRow {
  id: string;
  /** 'organize' 整理知识点 / 'questions' 出题 */
  kind: 'organize' | 'questions';
  /** 归属对象标题（资料名或题组名） */
  target: string;
  /** 整理记录有真实状态；出题记录只有「完成」一种（失败的根本不会建 deck） */
  status: GenerationRun['status'];
  produced: number;
  unlocated: number;
  tokens: number | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** 可跳转的 sourceId（整理类才有） */
  sourceId: string | null;
  /** 可跳转的 deckId（出题类有） */
  deckId?: string | null;
}

const STATUS_LABEL: Record<GenerationRun['status'], string> = {
  running: '进行中',
  completed: '完成',
  stopped: '已停止',
  failed: '失败',
};

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; runs: RunRow[]; usage: UsageRecord[] };

export function TasksPage({
  sourceService,
  decks,
  usage,
  knowledge,
  onOpenOrganize,
  onOpenDecks,
  onRemoveRun,
  onClearRuns,
}: TasksPageProps) {
  const [state, setState] = useState<Load>({ kind: 'loading' });

  /* 删除相关的本地状态（2026-11-08） */
  const [pendingRun, setPendingRun] = useState<{ id: string; target: string } | null>(null);
  const [pendingClear, setPendingClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      /*
       * generationRuns 没有公开的「全部列表」方法（KnowledgeService 只暴露
       * latestRun(sourceId)），而这一页要看的是**全部**历史。
       * 直接问 usage 与 sources/decks 组合也无法还原运行记录，
       * 所以这里通过一个轻量查询拿到原始数组 —— 见下面 getRuns。
       */
      const [runs, sources, deckList, usageList] = await Promise.all([
        knowledge.listRuns(),
        sourceService.list(),
        decks.list(),
        usage.list(),
      ]);

      const sourceTitle = new Map<string, string>(sources.map((s: Source) => [s.id, s.title]));
      /* 整理记录：来自 generationRuns（有耗时、有失败原因） */
      /*
       * 2026-11-08：generationRuns 现在也记出题了，所以要按 kind 分开。
       * 老数据没有 kind 字段 → 当时只有整理会写，按 'organize' 处理。
       */
      const isOrganize = (r: GenerationRun) => (r.kind ?? 'organize') === 'organize';

      const organizeRows: RunRow[] = runs.filter(isOrganize).map((r) => ({
        id: r.id,
        kind: 'organize',
        target: sourceTitle.get(r.sourceId) ?? '（资料已删除）',
        status: r.status,
        produced: r.producedCount,
        unlocated: r.unlocatedCount,
        tokens: r.actualTokens,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        error: r.error,
        sourceId: r.sourceId,
      }));

      /* 出题记录：来自 generationRuns（有真实 token 与耗时） */
      const deckTitle = new Map<string, string>(
        deckList.map((d: Deck) => [d.id, d.title]),
      );
      const questionRows: RunRow[] = runs.filter((r) => !isOrganize(r)).map((r) => ({
        id: r.id,
        kind: 'questions',
        target:
          (r.deckId ? deckTitle.get(r.deckId) : null) ??
          sourceTitle.get(r.sourceId) ??
          '（题组已删除）',
        status: r.status,
        produced: r.producedCount,
        unlocated: 0,
        tokens: r.actualTokens,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        error: r.error,
        sourceId: r.sourceId,
        deckId: r.deckId ?? null,
      }));

      /*
       * 出题记录（2026-11-08 改）。
       *
       * ## 改了什么，为什么
       *
       * 原来这里从 `decks.createdAt` 反推，tokens 一律 null ——
       * 因为那时候出题流程**不写 generationRuns**。
       * 后果是用户看到「最近一次任务没统计 token」，而实际上
       * 11-08 那组题确实花了 51861 token，只是记在 usageRecords 里、
       * 任务页关联不上。
       *
       * 现在出题会写 run（kind='questions'，带 deckId 与 actualTokens），
       * 所以优先用 run。deck 反推只作为**兜底**：老数据没有 run，
       * 但题组还在，那些行仍然要显示出来（只是 token 显示「不知道」）。
       */
      const deckIdsWithRun = new Set(
        runs.filter((r) => r.kind === 'questions' && r.deckId).map((r) => r.deckId!),
      );
      const legacyDeckRows: RunRow[] = deckList
        .filter((d: Deck) => !deckIdsWithRun.has(d.id))
        .map((d: Deck) => ({
          id: `deck:${d.id}`,
          kind: 'questions',
          target: d.title,
          status: 'completed',
          produced: d.questionCount,
          unlocated: 0,
          /*
           * 老题组没有 run 可查，token 真的不知道。
           * 留 null 让界面显示「—」，不写 0 —— 0 是「花了但没花」，
           * 那是假数据。
           */
          tokens: null,
          startedAt: d.createdAt,
          finishedAt: null,
          error: null,
          sourceId: d.sourceId,
          deckId: d.id,
        }));

      const rows = [...organizeRows, ...questionRows, ...legacyDeckRows];
      /* 最近的在最上面 */
      rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

      setState({ kind: 'ready', runs: rows, usage: usageList });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : '读不出任务记录',
      });
    }
  }, [sourceService, decks, usage, knowledge]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 删一条记录（2026-11-08） */
  const doRemoveRun = useCallback(async () => {
    if (!pendingRun) return;
    setBusy(true);
    setRemoveError(null);
    try {
      await onRemoveRun?.(pendingRun.id);
      setPendingRun(null);
      await load();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }, [pendingRun, onRemoveRun, load]);

  /** 清空全部记录 */
  const doClearAll = useCallback(async () => {
    setBusy(true);
    setRemoveError(null);
    try {
      await onClearRuns?.();
      setPendingClear(false);
      await load();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : '清空失败');
    } finally {
      setBusy(false);
    }
  }, [onClearRuns, load]);

  const runs = state.kind === 'ready' ? state.runs : [];
  const usageRows = state.kind === 'ready' ? state.usage : [];

  /** 按用途汇总用量 */
  const usageByKind = useMemo(() => {
    const acc = new Map<string, { calls: number; tokens: number }>();
    for (const u of usageRows) {
      const cur = acc.get(u.kind) ?? { calls: 0, tokens: 0 };
      cur.calls += u.calls;
      cur.tokens += u.tokens;
      acc.set(u.kind, cur);
    }
    return acc;
  }, [usageRows]);

  const totalTokens = usageRows.reduce((s, u) => s + u.tokens, 0);

  if (state.kind === 'loading') {
    return (
      <div className="tasks-page">
        <p className="tk-hint">正在读任务记录…</p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="tasks-page">
        <p className="tk-error">{state.message}</p>
      </div>
    );
  }

  return (
    <div className="tasks-page">
      <header className="tk-head">
        <h1 className="tk-title">任务</h1>
        <p className="tk-lead">
          整理知识点和出题的每一次运行都记在这里：什么时候跑的、成没成、
          产出多少条、花了多少 token。失败的原因也在这里，不用再猜。
        </p>
        {onClearRuns && runs.length > 0 ? (
          <button
            type="button"
            className="tk-clear"
            onClick={() => setPendingClear(true)}
          >
            清空全部记录（{runs.length} 条）
          </button>
        ) : null}
      </header>

      {/* ---- 用量概览 ---- */}
      {totalTokens > 0 ? (
        <div className="tk-usage">
          <span className="tk-usage__total">
            累计 <strong>{totalTokens.toLocaleString()}</strong> tokens
          </span>
          {(['organize', 'questions', 'slides'] as const).map((k) => {
            const u = usageByKind.get(k);
            if (!u || u.tokens === 0) return null;
            return (
              <span key={k} className="tk-usage__item">
                {USAGE_KIND_LABEL[k]} {u.tokens.toLocaleString()} · {u.calls} 次
              </span>
            );
          })}
        </div>
      ) : null}

      {/* ---- 运行记录 ---- */}
      {runs.length === 0 ? (
        <div className="tk-empty">
          <p>还没有任何任务记录。</p>
          <p className="tk-hint">
            到「资料」里点某一份的「整理」，或者到「我的题组」出一次题，
            记录就会出现在这里。
          </p>
          <button type="button" className="btn-ghost" onClick={() => onOpenOrganize(null)}>
            去整理知识点
          </button>
        </div>
      ) : (
        <ul className="tk-list">
          {runs.map((r) => (
            <li key={r.id} className="tk-item">
              <div className="tk-item__head">
                <span className={`tk-badge tk-badge--${r.status}`}>{STATUS_LABEL[r.status]}</span>
                <span className="tk-item__kind">
                  {r.kind === 'organize' ? '整理知识点' : '出题'}
                </span>
                <span className="tk-item__time">{formatWhen(r.startedAt)}</span>
                {r.finishedAt ? (
                  <span className="tk-item__dur">{formatDuration(r.startedAt, r.finishedAt)}</span>
                ) : null}
              </div>

              <p className="tk-item__target">{r.target}</p>

              <div className="tk-item__meta">
                <span>产出 {r.produced} 条</span>
                {r.unlocated > 0 ? (
                  <span className="tk-item__warn">{r.unlocated} 条未定位</span>
                ) : null}
                {r.tokens !== null ? <span>{r.tokens.toLocaleString()} tokens</span> : null}
              </div>

              {r.error ? <p className="tk-item__error">{r.error}</p> : null}

              <div className="tk-item__foot">
                {r.kind === 'organize' && r.sourceId ? (
                  <button
                    type="button"
                    className="btn-text"
                    onClick={() => onOpenOrganize(r.sourceId)}
                  >
                    再去整理这份
                  </button>
                ) : (
                  <button type="button" className="btn-text" onClick={onOpenDecks}>
                    去我的题组
                  </button>
                )}
                {/*
                  删除这一条记录（2026-11-08）。
                  只删**记录**，不动知识点/题目本身 —— 用户想清掉一条
                  失败的历史，不该顺手把他的劳动成果也删了。
                  这一点在确认框里写清楚。
                */}
                {onRemoveRun ? (
                  <button
                    type="button"
                    className="tk-remove"
                    onClick={() => setPendingRun({ id: r.id, target: r.target })}
                  >
                    删除记录
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {pendingClear ? (
        <ConfirmDialog
          title={`清空全部 ${runs.length} 条任务记录？`}
          description={
            <>
              只删**记录**，不影响知识点、题目和题组。
              这些记录会移进回收站，30 天内可以还原。
            </>
          }
          confirmLabel={busy ? '正在删除…' : '清空记录'}
          tone="danger"
          blocked={busy}
          onConfirm={doClearAll}
          onClose={() => {
            if (busy) return;
            setPendingClear(false);
            setRemoveError(null);
          }}
        >
          {removeError ? <p className="tk-error">{removeError}</p> : null}
        </ConfirmDialog>
      ) : null}

      {pendingRun ? (
        <ConfirmDialog
          title="删除这条任务记录？"
          description={
            <>
              「{pendingRun.target}」这条记录会移进回收站，30 天内可以还原。
              记录删掉不影响已经产出的知识点或题目。
            </>
          }
          confirmLabel={busy ? '正在删除…' : '删除'}
          tone="danger"
          blocked={busy}
          onConfirm={doRemoveRun}
          onClose={() => {
            if (busy) return;
            setPendingRun(null);
            setRemoveError(null);
          }}
        >
          {removeError ? <p className="tk-error">{removeError}</p> : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

const USAGE_KIND_LABEL: Record<string, string> = {
  organize: '整理',
  questions: '出题',
  slides: '幻灯片',
};

/** 「11-07 18:20」这样的短时间 */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 耗时：秒 / 分秒 */
function formatDuration(fromIso: string, toIso: string): string {
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '';
  const sec = Math.round((b - a) / 1000);
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  return `${m} 分 ${sec % 60} 秒`;
}

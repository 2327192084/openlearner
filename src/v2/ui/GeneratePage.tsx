import { useCallback, useEffect, useState } from 'react';
import type { Source, KnowledgePoint } from '@/core/model.ts';
import type { SourceService } from '@/core/sources.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { BackendService } from '@/core/backends.ts';
import { IconDoc, IconGenerate, IconUpload } from './icons.tsx';

/**
 * 出题页。
 *
 * ## 按截图还原四种方式
 *
 * 用资料出题 / 导入 JSON 题组 / 案例分析题 / 主会话里录题
 *
 * 只有第一种会真的工作（其余三种 v1 没有对应能力）。
 * 未实现的卡片**显示为禁用并说明原因**，不做成「点了没反应的按钮」。
 *
 * ## 流程
 *
 * 选资料 → 选题型/数量 → 生成前显示预估 token → 生成 → 进草稿
 *
 * 预估 token 是 StudyHub 明确做了的事（「出之前可以看到大概要花多少」），
 * 用户在点下去之前应该知道会花多少钱。
 */

export interface GeneratePageProps {
  sourceService: SourceService;
  knowledge: KnowledgeService;
  decks: DeckService;
  backends: BackendService;
  onGenerated: () => void;
  onOpenSources: () => void;
}

type Mode = 'from-source' | 'import-json' | 'case' | 'capture';

const MODES: { id: Mode; title: string; desc: string; ready: boolean }[] = [
  {
    id: 'from-source',
    title: '用资料出题',
    desc: 'AI 按你的资料出题，并逐题检查',
    ready: true,
  },
  {
    id: 'import-json',
    title: '导入 JSON 题组',
    desc: '已有题目，或外部 AI 生成的题',
    ready: false,
  },
  {
    id: 'case',
    title: '案例分析题',
    desc: '长案例 + 开放题，按评分标准逐项批改',
    ready: false,
  },
  {
    id: 'capture',
    title: '在主会话里录题',
    desc: '题册、刷题软件、错题或截图',
    ready: false,
  },
];

export function GeneratePage({
  sourceService,
  knowledge,
  decks,
  backends,
  onGenerated,
  onOpenSources,
}: GeneratePageProps) {
  const [mode, setMode] = useState<Mode>('from-source');
  const [sources, setSources] = useState<Source[] | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [points, setPoints] = useState<KnowledgePoint[] | null>(null);
  const [kind, setKind] = useState<'single' | 'multiple' | 'blank'>('single');
  const [count, setCount] = useState(8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ deck: string; questions: number } | null>(null);

  const loadSources = useCallback(async () => {
    try {
      const all = await sourceService.list();
      setSources(all);
      if (all.length === 0 || selected) return;

      /**
       * 默认选中**第一份真的有知识点的资料**，不是列表第一份。
       *
       * ⚠️ 这里踩过坑：原先直接选 all[0]，而用户库里第一份是
       * 没整理过知识点的 PDF —— 打开出题页就看到「暂时无法从这里出题」，
       * 会以为整个功能坏了，其实切一下就正常。
       *
       * 优先选有知识点的，都选不到才退回第一份（并给明确提示）。
       */
      let best: string | null = null;
      for (const s of all) {
        const pts = await knowledge.listBySource(s.id);
        if (pts.some((p) => p.anchors.length > 0)) {
          best = s.id;
          break;
        }
      }
      setSelected(best ?? all[0]!.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不出资料');
    }
  }, [sourceService, knowledge, selected]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  // 选资料后读它的知识点
  useEffect(() => {
    let cancelled = false;
    if (!selected) {
      setPoints(null);
      return;
    }
    void (async () => {
      try {
        const all = await knowledge.listBySource(selected);
        if (cancelled) return;
        setPoints(all);
      } catch {
        if (!cancelled) setPoints(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [knowledge, selected]);

  /** 已定位的知识点才能出题（未定位的没有出处，题目也就点不回原文） */
  const usablePoints = (points ?? []).filter((p) => p.anchors.length > 0);

  /** 粗略的 token 预估：按知识点的 statement 字数 × 出题倍率 */
  const estimatedTokens = (() => {
    if (usablePoints.length === 0) return 0;
    const chars = usablePoints.reduce((n, p) => n + p.statement.length, 0);
    // 输入约 chars 字，输出约每题 150 token；按项目里实测的经验倍率估
    return Math.round(chars * 0.6 + count * 150);
  })();

  const generate = useCallback(async () => {
    if (busy || usablePoints.length === 0) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const list = await backends.list();
      const ready = list.filter((b) => b.status === 'ready');
      if (ready.length === 0) {
        setError('还没有可用的模型。先到「设置」里添加一个后端。');
        return;
      }
      const backendId = ready[0]!.id;
      const apiKey = await backends.readCredential(backendId);
      if (!apiKey) {
        setError('读不到这个后端的 API Key，请到设置页重新填一次。');
        return;
      }

      // 动态引入，避免首屏加载出题器
      const { DeepSeekQuestionBackend } = await import('@/core/questions/deepseek-backend.ts');
      const backend = new DeepSeekQuestionBackend({
        apiKey,
        provider: ready[0]!.provider,
        model: ready[0]!.model,
        ...(ready[0]!.baseUrl ? { baseUrl: ready[0]!.baseUrl } : {}),
      });

      const controller = new AbortController();
      const out = await decks.generate({
        points: usablePoints,
        title: `${sources?.find((s) => s.id === selected)?.title ?? '资料'} · 题组`,
        sourceId: selected,
        backend,
        options: {
          kinds: [kind],
          count,
          // levels: null = 不限认知层级（按知识点自身层级出题）
          levels: null,
          language: 'zh',
        },
        signal: controller.signal,
      });

      setDone({ deck: out.deck.title, questions: out.questions.length });
      onGenerated();
    } catch (err) {
      setError(err instanceof Error ? err.message : '出题失败');
    } finally {
      setBusy(false);
    }
  }, [busy, usablePoints, backends, decks, sources, selected, kind, count, onGenerated]);

  // ---- 没有资料：先引导导入 ----
  if (sources !== null && sources.length === 0) {
    return (
      <div className="gen-empty">
        <div className="gen-empty__icon" aria-hidden="true">
          <IconDoc size={36} />
        </div>
        <h2 className="gen-empty__title">先添加一份资料</h2>
        <p className="gen-empty__desc">
          讲义、笔记、PDF 或网页都可以。AI 只根据你添加的资料出题，
          并标出每道题的出处。
        </p>
        <div className="gen-empty__actions">
          <button type="button" className="btn-fill btn-fill--sm" onClick={onOpenSources}>
            <IconUpload size={15} />
            添加资料
          </button>
          <button type="button" className="btn-text" onClick={() => setMode('import-json')}>
            已有题目？导入 JSON 题组
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="gen-page">
      <div className="gen-head">
        <h1 className="gen-title">出一组新题</h1>
        <p className="gen-sub">用你的资料让 AI 出题；已经有现成的题目，也可以直接导入。</p>
      </div>

      {/* 四种方式 */}
      <div className="gen-modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`gen-mode${mode === m.id ? ' gen-mode--on' : ''}${
              m.ready ? '' : ' gen-mode--soon'
            }`}
            onClick={() => m.ready && setMode(m.id)}
            disabled={!m.ready}
            title={m.ready ? m.desc : `${m.desc}（还没做）`}
          >
            <span className="gen-mode__title">{m.title}</span>
            <span className="gen-mode__desc">{m.desc}</span>
            {!m.ready ? <span className="gen-mode__badge">还没做</span> : null}
          </button>
        ))}
      </div>

      {/* ---- 用资料出题 ---- */}
      {mode === 'from-source' ? (
        <div className="gen-form">
          <fieldset className="gen-field">
            <legend className="gen-legend">01 / 选资料</legend>
            <select
              className="gen-select"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={busy}
            >
              {(sources ?? []).map((s) => {
                const n = s.id === selected ? usablePoints.length : null;
                return (
                  <option key={s.id} value={s.id}>
                    {s.title}
                    {n !== null ? `（${n} 条可出题）` : ''}
                  </option>
                );
              })}
            </select>
            {points !== null ? (
              <p className="gen-hint">
                {usablePoints.length > 0
                  ? `这份资料有 ${usablePoints.length} 条已定位的知识点可以出题`
                  : /*
                     * 不写「先去学习库整理知识点」—— 学习库页现在只有今日概览，
                     * 没有整理知识点的入口。指向一个不存在的地方比不提示更糟，
                     * 用户会以为是自己没找到。
                     */
                    '这份资料还没有整理过知识点。整理知识点的页面还在重做中，暂时无法从这里出题。'}
              </p>
            ) : null}
          </fieldset>

          <fieldset className="gen-field">
            <legend className="gen-legend">02 / 题型与数量</legend>
            <div className="gen-row">
              <label className="gen-label">
                题型
                <select
                  className="gen-select gen-select--sm"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as typeof kind)}
                  disabled={busy}
                >
                  <option value="single">单选</option>
                  <option value="multiple">多选</option>
                  <option value="blank">填空</option>
                </select>
              </label>
              <label className="gen-label">
                数量
                <input
                  className="gen-input"
                  type="number"
                  min={1}
                  max={30}
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
                  disabled={busy}
                />
              </label>
            </div>
          </fieldset>

          {/* 预估 token：点下去之前就该知道会花多少 */}
          <div className="gen-estimate">
            <span className="gen-estimate__label">预计用量</span>
            <span className="gen-estimate__value">约 {estimatedTokens} token</span>
            <span className="gen-estimate__note">按资料字数与题数估算，实际以服务端返回为准</span>
          </div>

          {error ? <div className="gen-error">{error}</div> : null}
          {done ? (
            <div className="gen-done">
              ✓ 已生成「{done.deck}」，共 {done.questions} 道题。可以去「复习」里做了。
            </div>
          ) : null}

          <div className="gen-actions">
            <button
              type="button"
              className="btn-fill"
              onClick={() => void generate()}
              disabled={busy || usablePoints.length === 0}
            >
              <IconGenerate size={16} />
              {busy ? '正在生成…' : '生成并检查题组'}
            </button>
            {usablePoints.length === 0 ? (
              <span className="gen-hint">先有已定位的知识点才能出题</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* ---- 未实现的方式：说清为什么，不摆假按钮 ---- */}
      {mode !== 'from-source' ? (
        <div className="gen-todo">
          这种方式还没做。现在能用的是「用资料出题」——
          选一份资料，AI 读原文后出题，每道题都标出处。
        </div>
      ) : null}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { Source, KnowledgePoint, QuestionKind } from '@/core/model.ts';
import type { SourceService } from '@/core/sources.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import {
  pickRandom,
  pointsToMaterials,
  segmentsToMaterials,
  type QuestionMaterial,
} from '@/core/questions/materials.ts';
import { OriginPicker, type MaterialOrigin } from './OriginPicker.tsx';
import { KindPicker } from './KindPicker.tsx';
import { QuotaPicker, totalOfCounts, type CognitiveLevel } from './QuotaPicker.tsx';
import { ImportPanel } from './ImportPanel.tsx';
import './import-panel.css';
import { kindLabel } from '@/core/questions/kinds.ts';
import './kind-picker.css';
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
 * 选资料 → 选题型/数量 → 生成前显示预估 token → 生成 → 进待审核
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
  /** 知识点不够时跳去整理页，带上当前选中的资料 */
  onOpenOrganize: (sourceId: string | null) => void;
  /** 出完题跳到「我的题组」并展开这一组 —— 否则用户找不到刚生成的题 */
  onOpenDecks: (deckId?: string | null) => void;
  /**
   * 返回题组列表。
   *
   * 这个组件现在**嵌在「我的题组」页里**（用户要求把「创建题组」
   * 和「我的题组」整合成一页），所以需要一条回去的路。
   */
  onBack?: () => void;
}

type Mode = 'from-source' | 'import-json' | 'case' | 'capture';

/**
 * 四个出题入口。
 *
 * ## 关于第 4 个入口的改动（2026-11-07 用户指出）
 *
 * 原来它叫「在主会话里录题」，描述是「题册、刷题软件、错题或截图」。
 * 那是**照搬 StudyHub** 的说法 —— StudyHub 是 DSH 的插件，
 * 用户有一个 AI 主会话，所以「在主会话里录题」指的是在对话里贴截图让 AI 转成题。
 *
 * OpenLeaner 是**独立桌面软件**，没有「主会话」这个东西。
 * 留着那个名字等于挂一个用户永远无法理解的入口。
 *
 * 改成「从截图或题册导入」：说的是**同一件事**（把手头已有的题弄进来），
 * 但用的是我们这个软件里真实存在的东西 —— 文件。
 * 实现上它也需要 OCR/视觉模型，所以现在标「还没做」并写明依赖。
 */
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
    ready: true,
  },
  {
    id: 'case',
    title: '案例分析题',
    desc: '长案例 + 开放题，按评分标准逐项批改',
    ready: false,
  },
  {
    id: 'capture',
    title: '从截图或题册导入',
    desc: '拍下来的题、刷题软件截图（需要看图模型，还没做）',
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
  onOpenOrganize,
  onOpenDecks,
  onBack,
}: GeneratePageProps) {
  const [mode, setMode] = useState<Mode>('from-source');

  /**
   * 出题素材来源（2026-11-07 用户要求）。
   *  - source-text：资料原文段落（原「从资料出题」改成读原文）
   *  - knowledge：知识库知识点（可整库随机 / 指定一份）
   */
  const [origin, setOrigin] = useState<MaterialOrigin>('source-text');
  const [acrossAll, setAcrossAll] = useState(true);
  const [sources, setSources] = useState<Source[] | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [points, setPoints] = useState<KnowledgePoint[] | null>(null);
  /*
   * 题型从「单选一种」改成「可勾选多种」。
   *
   * 界面部分抽成了 <KindPicker>（独立文件），这里只存状态。
   * 用数组而不是单个值：勾几种就出几种，按题型轮流分配数量。
   */
  const [kinds, setKinds] = useState<QuestionKind[]>(['single']);
  /**
   * 每种题型各出几道（2026-11-08 改）。
   *
   * 原来是单个 `count`（总数），由模型自己分给各题型 ——
   * 实测真实模型常常全给单选，用户勾的判断题/问答题拿不到。
   * 现在逐种填数字，总数由它求和得出，不再有一个会与它打架的独立总数框。
   */
  const [kindCounts, setKindCounts] = useState<Partial<Record<QuestionKind, number>>>({ single: 8 });
  /** 限定的认知层级；空数组 = 不限（按知识点自身层级出） */
  const [levels, setLevels] = useState<CognitiveLevel[]>([]);

  /*
   * 总题数 = 各题型配额之和。
   *
   * 为什么派生而不是单独存一个 state：两个数字必然会被改到一个不一致的状态，
   * 那时界面上「合计 12 道」和「数量 10」会同时出现，用户不知道该信哪个。
   */
  const count = totalOfCounts(kindCounts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 错误附带的下一步建议。
   *
   * ApiError 的构造函数注释写着「不允许只显示 message」，因为
   * 「账号余额不足」只告诉用户发生了什么，没告诉他该做什么。
   * 这些建议在 chat-client 里已经按错误码写好了，不能在这一层丢掉。
   */
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [done, setDone] = useState<{
    deck: string;
    deckId: string;
    questions: number;
    /** 实际出了哪些题型（用于如实告知「你勾的里有几种没出成」） */
    kinds: Record<string, number>;
  } | null>(null);

  /** 统一的报错入口：带上 hint 就一起显示，没带就清掉上一条的 */
  const reportError = useCallback((err: unknown, fallback: string) => {
    const e = err as { message?: string; hint?: string } | null;
    setError(e?.message ?? fallback);
    setErrorHint(typeof e?.hint === 'string' ? e.hint : null);
  }, []);

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
      reportError(err, '读不出资料');
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
    setErrorHint(null);
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

      /*
       * 按来源取素材（2026-11-07）。
       *
       * 原文出题 → segmentsToMaterials：段落自带页码，锚点天然准确；
       * 知识库出题 → pointsToMaterials：用整理时实测出的 anchors。
       */
      let materials: QuestionMaterial[] = [];
      let titleBase = '';

      if (origin === 'source-text') {
        const segs = await sourceService.getSegments(selected);
        materials = segmentsToMaterials(segs);
        titleBase = sources?.find((s) => s.id === selected)?.title ?? '资料';
      } else if (acrossAll) {
        const allPoints = [];
        for (const src of sources ?? []) {
          allPoints.push(...(await knowledge.listBySource(src.id)));
        }
        /*
         * 抽多少条：出题数 × 3，至少 12。
         * 整库可能有几百条，全塞进去会超上下文，而且大部分用不到。
         */
        materials = pickRandom(pointsToMaterials(allPoints), Math.max(count * 3, 12));
        titleBase = '知识库';
      } else {
        materials = pointsToMaterials(await knowledge.listBySource(selected));
        titleBase = sources?.find((s) => s.id === selected)?.title ?? '资料';
      }

      if (materials.length === 0) {
        setError(
          origin === 'source-text'
            ? '这份资料没有可用来出题的正文。到「资料」页看它是不是扫描件（扫描件要先转成正文）。'
            : '这个范围里没有已定位的知识点。到「整理知识点」把资料过一遍再来。',
        );
        return;
      }
      const controller = new AbortController();
      const out = await decks.generate({
        // 素材优先；points 留空 —— generate 会用 materials
        points: [],
        materials,
        title: `${titleBase} · 题组`,
        /*
         * 是不是随机题组：整库随机抽素材时标记「随机题组」，
         * 这样列表里一眼能看出来，而不是事后想不起这批题从哪来的。
         */
        randomSource: origin === 'knowledge' && acrossAll,
        sourceId: origin === 'source-text' || !acrossAll ? selected : null,
        backend,
        options: {
          kinds,
          count,
          /* 逐种数量：后端据此出题（不再靠「尽量平均」的提示词碰运气） */
          kindCounts,
          levels: levels.length > 0 ? levels : null,
          language: 'zh',
        },
        signal: controller.signal,
      });

      /* 统计实际出成的题型分布 —— 用户勾了 N 种，模型可能只给了一两种 */
      const kindCount: Record<string, number> = {};
      for (const q of out.questions) kindCount[q.kind] = (kindCount[q.kind] ?? 0) + 1;
      setDone({
        deck: out.deck.title,
        deckId: out.deck.id,
        questions: out.questions.length,
        kinds: kindCount,
      });
      onGenerated();
    } catch (err) {
      reportError(err, '出题失败');
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    usablePoints,
    backends,
    decks,
    sources,
    selected,
    kinds,
    count,
    kindCounts,
    levels,
    onGenerated,
    origin,
    acrossAll,
    knowledge,
    sourceService,
  ]);

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
          {/*
           * 这个组件现在嵌在「我的题组」页里，空态也必须有一条回去的路 ——
           * 否则用户点进「新建题组」发现没资料，就困在这一屏了。
           */}
          {onBack ? (
            <button type="button" className="btn-text" onClick={onBack}>
              返回题组列表
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="gen-page">
      <div className="gen-head">
        <div>
          <h2 className="gen-title">出一组新题</h2>
          <p className="gen-sub">用你的资料让 AI 出题；已经有现成的题目，也可以直接导入。</p>
        </div>
        {onBack ? (
          <button type="button" className="btn-ghost" onClick={onBack}>
            返回题组列表
          </button>
        ) : null}
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

      {/* ---- 导入 JSON 题组 ---- */}
      {mode === 'import-json' ? (
        <div className="gen-form">
          <ImportPanel
            decks={decks}
            disabled={busy}
            onImported={() => {
              /*
               * 导入完成后刷新外层（题组列表计数要更新），
               * 但不自动跳走 —— 用户可能想接着导第二个。
               * 「再导入一个」按钮由面板自己给。
               */
              onGenerated();
            }}
          />
        </div>
      ) : null}

      {/* ---- 用资料出题 ---- */}
      {mode === 'from-source' ? (
        <div className="gen-form">
          {/* 出题素材来源：资料原文 / 知识库知识点 */}
          <OriginPicker
            origin={origin}
            onOriginChange={setOrigin}
            acrossAll={acrossAll}
            onAcrossAllChange={setAcrossAll}
            sources={sources}
            selected={selected}
            onSelectedChange={setSelected}
            locatedPointCount={origin === 'knowledge' ? usablePoints.length : null}
            disabled={busy}
            onOpenOrganize={onOpenOrganize}
          />


          <fieldset className="gen-field">
            <legend className="gen-legend">03 / 题型与数量</legend>
            <div className="gen-label gen-label--wide">
              题型（可多选）
              <KindPicker
                value={kinds}
                onChange={(next) => {
                  setKinds(next);
                  /*
                   * 新勾上的题型给一个默认数量（2026-11-08）。
                   *
                   * 不给的话它进来是 0 —— 用户勾了判断题，合计却不变，
                   * 会以为勾选没生效。给 2 道是个合理的「先出一两道看看」。
                   *
                   * 取消勾选的题型保留它的旧数量：用户可能只是临时取消、
                   * 待会又勾回来，清掉会让他重新填一遍。
                   */
                  setKindCounts((prev) => {
                    const out = { ...prev };
                    for (const k of next) {
                      if (!(k in out) || (out[k] ?? 0) <= 0) out[k] = 2;
                    }
                    return out;
                  });
                }}
                disabled={busy}
              />
            </div>
            <QuotaPicker
              kinds={kinds}
              counts={kindCounts}
              onCountsChange={setKindCounts}
              levels={levels}
              onLevelsChange={setLevels}
              disabled={busy}
            />
          </fieldset>

          {/* 预估 token：点下去之前就该知道会花多少 */}
          <div className="gen-estimate">
            <span className="gen-estimate__label">预计用量</span>
            <span className="gen-estimate__value">约 {estimatedTokens} token</span>
            <span className="gen-estimate__note">按资料字数与题数估算，实际以服务端返回为准</span>
          </div>

          {error ? (
            <div className="gen-error">
              <span>{error}</span>
              {errorHint ? <span className="gen-error__hint">{errorHint}</span> : null}
            </div>
          ) : null}
          {done ? (
            <div className="gen-done">
              <p className="gen-done__text">
                ✓ 已生成「{done.deck}」，共 {done.questions} 道题。
              </p>
              {/*
                如实列出「实际出了哪些题型」。
                为什么必须有这段：勾了三种题型，模型可能只给出两种 ——
                不说的话用户以为都生效了，去列表里才发现少了。
                这是本项目反复强调的「不撒谎」在生成结果上的体现。
              */}
              <p className="gen-done__kinds">
                实际题型：
                {Object.entries(done.kinds)
                  .map(([k, n]) => `${kindLabel(k)} ${n} 道`)
                  .join(' · ')}
                {(() => {
                  const missing = kinds.filter((k) => !done.kinds[k]);
                  if (missing.length === 0) return null;
                  return (
                    <span className="gen-done__missing">
                      （{missing.map(kindLabel).join('、')} 这次没出成 ——
                      模型不一定每次都按要求分配题型，可以再生成一次）
                    </span>
                  );
                })()}
              </p>
              {/*
               * 说清「待审核 vs 已发布」——生成出来是待审核，要先检查再发布才进复习。
               * 原来只写「可以去复习里做了」，而当时题组是待审核、界面又没有题组列表，
               * 用户照着做只会扑空。
               */}
              <p className="gen-done__hint">
                它现在是<strong>待审核</strong>，先检查一遍题，发布之后才会进入复习。
              </p>
              <button
                type="button"
                className="btn-fill btn-fill--sm"
                onClick={() => onOpenDecks(done.deckId)}
              >
                去看这 {done.questions} 道题
              </button>
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

      {/*
        ---- 未实现的方式：说清为什么，不摆假按钮 ----

        条件必须**逐个列出**真正没做的那几个，不能用 `mode !== 'from-source'`。
        踩过的坑：导入做完之后，那个宽条件把「导入 JSON」也算成「还没做」，
        于是在能用的导入面板下面又挂了一句「这种方式还没做」——
        用户看到互相矛盾的两句话（截图核对时发现的）。
      */}
      {mode === 'case' || mode === 'capture' ? (
        <div className="gen-todo">
          {mode === 'case'
            ? '案例分析题还没做 —— 它需要「长案例 + 评分标准」这套结构，和现在的出题链路是两套。'
            : '从截图或题册导入还没做 —— 它需要看图模型把图片里的题转成文字，这部分还没接。'}
          <br />
          现在能用的是「用资料出题」（AI 读原文出题）和「导入 JSON 题组」（已有题目直接搬进来）。
        </div>
      ) : null}
    </div>
  );
}

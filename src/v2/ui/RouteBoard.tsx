/**
 * 资料级学习路线的**横板爬塔图**（2026-11-21 深夜补）。
 *
 * ## 为什么这个文件是"补"出来的
 *
 * 上一轮把「依据知识点」换成「依据资料本体」时，我重写了规划表单
 * （`RoutePlanner.tsx`），却**只给已确认的路线留了一行文字摘要**
 * （「已确认的路线：信号与系统 · 3 块 · 3 步」）。
 *
 * 结果是：数据有了、图没了。用户截图指出「我没找到地图的入口」——
 * 他要的是那张**看得见路线和进度**的图，不是一行字。
 *
 * 旧的 `RouteMap.tsx` 画的是知识点级路线（节点 = 知识点），
 * 数据结构与资料级（节点 = 章/节）不同，没法直接复用。
 * 但**视觉语言要一致** —— 用户已经认可了那个横板爬塔的样子。
 *
 * ## 借了哪些视觉语言（与 `RouteMap.tsx` 保持一致）
 *
 * - 横向轨道，`overflow-x: auto`（路线比屏幕宽就横着滚）
 * - 按块分「层」，层有标题
 * - 三种状态：已走过 / 当前 / 未到达
 * - 当前关高亮 + 「你在这里」徽标
 * - 终点用 ★ 标记
 *
 * ## 与知识点级版本的关键差别：进度怎么算
 *
 * 知识点级路线有明确的「学过没学过」（`mastery > 0`）。
 * 而资料级路线的一步是**一章**，没有"这一章学完了吗"这种数据。
 *
 * 所以这里的进度改用**资料覆盖度**：
 *  - 这一章对应资料里的 N 段正文
 *  - 其中有多少段已经出过题（`answeredSegments`）
 *  - 按「这一章有多少比例已经有题」判断走到哪
 *
 * 为什么不假装知道「学会没」：项目一贯「如实说不知道，不编数据」。
 * 「出了题」是可观测的事实，「学会了」不是。
 */

import type { SourceRoute, RouteStep } from '@/core/ai/source-route.ts';

export interface RouteBoardProps {
  route: SourceRoute;
  /**
   * 每章的覆盖情况：章号 → { 段数, 已出题的段数 }
   *
   * 由调用方从题库算好传进来（这一层不碰存储）。
   * 缺省时进度只按顺序显示，不显示覆盖度。
   */
  coverageByChapter?: ReadonlyMap<number, { segments: number; withQuestions: number }>;
  /**
   * 这些题有多少能对上当前资料的段落。
   *
   * ## 为什么需要它（2026-11-21 深夜实测）
   *
   * 用户库「信号与系统」有 10 道题，但它们的锚点 segmentId
   * **全部指向已经不存在的段** —— 重新整理知识点时段落被替换过，
   * 题目锚点没跟着更新。
   *
   * 这会导致覆盖度恒为 0%，界面显示「0 段已出题（0%）」——
   * 用户看到会以为「我一道题都没做」，而实际上他有 10 道题，
   * 只是那些题的出处已失效。
   *
   * 所以这里要能区分：
   *  - `resolved > 0`：正常显示覆盖度
   *  - `resolved === 0 && total > 0`：如实说「题目出处失效」，不显示 0%
   */
  anchorHealth?: { total: number; resolved: number };
  /** 点某一步：去练这一章 / 看它的题目 */
  onStep?: (step: RouteStep) => void;
  /** 重新规划 */
  onReplan?: () => void;
  /** 清除路线 */
  onClear?: () => void;
  busy?: boolean;
}

/** 一步的状态 */
type StepState = 'done' | 'current' | 'ahead';

export function RouteBoard(props: RouteBoardProps) {
  const { route, coverageByChapter, anchorHealth, onStep, onReplan, onClear, busy } = props;

  /* 按块分层（保持原顺序） */
  const layers: { title: string; why: string; steps: RouteStep[] }[] = [];
  for (const block of route.blocks) {
    layers.push({ title: block.title, why: block.why, steps: block.steps });
  }

  const total = route.blocks.reduce((n, b) => n + b.steps.length, 0);

  /**
   * 「走到哪一步」。
   *
   * 判据：这一章对应的正文里，**已经把题都出过了**就算走过。
   * 没有覆盖度数据时（`coverageByChapter` 为空）算不出，
   * 那就一条都不标 done —— 不猜。
   */
  const stepDone = (step: RouteStep): boolean => {
    if (!coverageByChapter) return false;
    const cov = coverageByChapter.get(step.chapterNumber);
    if (!cov) return false;
    if (cov.segments === 0) return false;
    /* 出了一半以上的题算「走到这一章」—— 阈值写在这里，不散在界面代码里 */
    return cov.withQuestions / cov.segments >= 0.5;
  };

  const firstAhead = findFirstAhead(route, stepDone);
  const doneCount = route.blocks.reduce(
    (n, b) => n + b.steps.filter(stepDone).length,
    0,
  );

  function stateOf(step: RouteStep): StepState {
    if (stepDone(step)) return 'done';
    if (firstAhead && step.chapterNumber === firstAhead.chapterNumber && step.title === firstAhead.title) {
      return 'current';
    }
    return 'ahead';
  }

  return (
    <section className="rboard">
      <header className="rboard__head">
        <h3 className="rboard__title">
          学习路线
          <span className="rboard__count">
            {doneCount} / {total}
          </span>
        </h3>
        <p className="rboard__lead">
          <b>{route.subject}</b>
          {route.edition ? `（${route.edition}）` : ''} · 依据资料本体排，
          {firstAhead ? (
            <>
              {' '}
              当前在第 <b>{firstAhead.chapterNumber || '—'}</b> 章「
              {shortTitle(firstAhead.title)}」。
            </>
          ) : (
            <> 全部走完了。</>
          )}
          {route.usedSearch ? <span className="rboard__tag">规划时联网过</span> : null}
        </p>
      </header>

      {/* ==================== 横板轨道 ==================== */}
      <div className="rboard__track" role="list" aria-label="学习路线，从左到右">
        {layers.map((layer, li) => (
          <div key={`${layer.title}-${li}`} className="rboard__layer">
            <div className="rboard__layer-label" title={layer.title || layer.why}>
              {layer.title}
            </div>
            <div className="rboard__nodes">
              {layer.steps.map((step, si) => {
                const st = stateOf(step);
                const cov = coverageByChapter?.get(step.chapterNumber);
                const basis = basisLabel(step.basis);
                return (
                  <div key={`${step.chapterNumber}-${step.title}-${si}`} className="rboard__slot">
                    {si > 0 || li > 0 ? (
                      <span
                        className={`rboard__link${st === 'done' ? ' rboard__link--done' : ''}`}
                        aria-hidden="true"
                      />
                    ) : null}

                    <button
                      type="button"
                      className={`rboard__node rboard__node--${st}`}
                      onClick={() => onStep?.(step)}
                      title={
                        [
                          step.chapterNumber ? `第 ${step.chapterNumber} 章` : '无章号',
                          step.difficulty !== null ? `难度 ${step.difficulty}/5` : '难度未知',
                          basis,
                          cov ? `资料里 ${cov.segments} 段，${cov.withQuestions} 段已出题` : '',
                          step.reason ? `为什么排这里：${step.reason}` : '',
                        ]
                          .filter(Boolean)
                          .join('｜')
                      }
                      aria-current={st === 'current' ? 'step' : undefined}
                    >
                      <span className="rboard__order">{step.chapterNumber || '·'}</span>
                      <span className="rboard__label">{shortTitle(step.title)}</span>
                      {step.difficulty !== null ? (
                        <span className="rboard__diff" aria-hidden="true">
                          {step.difficulty}
                        </span>
                      ) : null}
                      {st === 'current' ? <span className="rboard__here">你在这里</span> : null}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {/* 终点 */}
        <div className="rboard__end">
          <span
            className={`rboard__end-mark${firstAhead ? '' : ' rboard__end-mark--reached'}`}
            aria-hidden="true"
          >
            ★
          </span>
          <span className="rboard__end-text">{firstAhead ? `${total} 步` : '通关'}</span>
        </div>
      </div>

      {/* ==================== 当前步详情 ==================== */}
      {firstAhead ? (
        <CurrentStep
          step={firstAhead}
          coverage={coverageByChapter?.get(firstAhead.chapterNumber)}
          {...(anchorHealth ? { anchorHealth } : {})}
          onGo={() => onStep?.(firstAhead)}
        />
      ) : null}

      {/* ==================== 资料外的部分（如实告知） ==================== */}
      {route.beyond.length > 0 ? (
        <div className="rboard__beyond">
          <p className="rboard__beyond-title">
            按学科常规还有这些，但<b>这份资料里没有</b>：
          </p>
          <ul className="rboard__beyond-list">
            {route.beyond.map((b, i) => (
              <li key={`${b.title}-${i}`} className="rboard__beyond-item">
                <span className="rboard__beyond-name">{b.title}</span>
                {b.note ? <span className="rboard__beyond-note">{b.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 越界被丢掉时如实说明（诊断价值 > 好看） */}
      {route.droppedOutOfScope > 0 ? (
        <p className="rboard__dropped">
          规划时 AI 排了 {route.droppedOutOfScope} 步超出这份资料的范围，已丢弃 ——
          路线只覆盖资料里真有的内容。
        </p>
      ) : null}

      <div className="rboard__actions">
        <button type="button" className="btn-ghost" onClick={onReplan} disabled={busy}>
          {busy ? '正在重新规划…' : '重新规划'}
        </button>
        <button type="button" className="btn-ghost" onClick={onClear} disabled={busy}>
          清除这条路线
        </button>
      </div>
    </section>
  );
}

/** 当前这一步的详情（横板上的节点太窄，放不下理由与覆盖度） */
function CurrentStep(props: {
  step: RouteStep;
  coverage: { segments: number; withQuestions: number } | undefined;
  anchorHealth?: { total: number; resolved: number };
  onGo: () => void;
}) {
  const { step, coverage, anchorHealth, onGo } = props;
  return (
    <div className="rboard__current">
      <div className="rboard__current-head">
        <span className="rboard__current-badge">
          当前第 {step.chapterNumber || '—'} 章
        </span>
        <span className="rboard__current-title">{step.title}</span>
      </div>

      <dl className="rboard__current-meta">
        <div>
          <dt>难度</dt>
          <dd>
            {step.difficulty !== null ? (
              <>
                {step.difficulty} / 5
                <span className="rboard__hint">（这一步内容本身有多难，不是你掌握得怎样）</span>
              </>
            ) : (
              <>
                未知
                <span className="rboard__hint">（AI 没给判断，不猜）</span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>依据</dt>
          <dd>
            {basisLabel(step.basis)}
            <span className="rboard__hint">{basisHint(step.basis)}</span>
          </dd>
        </div>
        {coverage ? (
          <div>
            <dt>资料覆盖</dt>
            <dd>
              {/*
                * ⚠️ 题目出处失效时不能显示 0%（2026-11-21 深夜实测）。
                *
                * 用户库「信号与系统」有 10 道题，但它们的锚点 segmentId
                * 全部指向已不存在的段（重新整理时换掉了段落，锚点没更新）。
                * 如果照常算，界面会显示「0 段已出题（0%）」——
                * 用户会以为他一道题都没做。
                */}
              {anchorHealth && anchorHealth.total > 0 && anchorHealth.resolved === 0 ? (
                <>
                  这一章有 {coverage.segments} 段正文
                  <span className="rboard__hint">
                    （有 {anchorHealth.total} 道题，但它们的原文出处已经失效 ——
                    重新整理时换过段落，题目的锚点没跟着更新，所以这里算不出覆盖度）
                  </span>
                </>
              ) : (
                <>
                  这一章有 {coverage.segments} 段正文，其中 {coverage.withQuestions} 段已出题
                  {coverage.segments > 0 ? (
                    <span className="rboard__hint">
                      （{Math.round((coverage.withQuestions / coverage.segments) * 100)}%）
                    </span>
                  ) : null}
                </>
              )}
            </dd>
          </div>
        ) : null}
        {step.reason ? (
          <div>
            <dt>为什么排这里</dt>
            <dd>{step.reason}</dd>
          </div>
        ) : null}
      </dl>

      {step.segmentIds.length === 0 && step.chapterNumber !== 0 ? (
        <p className="rboard__warn">
          这一步在资料里找不到直接对应的正文 —— 可能是 AI 按学科知识补充的。
        </p>
      ) : null}

      <button type="button" className="btn-fill btn-fill--sm" onClick={onGo}>
        去学这一章 →
      </button>
    </div>
  );
}

/** 找第一个「还没走过」的步骤 */
function findFirstAhead(
  route: SourceRoute,
  done: (s: RouteStep) => boolean,
): RouteStep | null {
  for (const block of route.blocks) {
    for (const step of block.steps) {
      if (!done(step)) return step;
    }
  }
  return null;
}

/** 依据来源说人话 */
function basisLabel(basis: RouteStep['basis']): string {
  switch (basis) {
    case 'toc':
      return '来自资料目录';
    case 'search':
      return '来自联网检索';
    case 'model':
      return 'AI 按学科知识推断';
  }
}

function basisHint(basis: RouteStep['basis']): string {
  switch (basis) {
    case 'toc':
      return '（作者写的结构，最可信）';
    case 'search':
      return '（网上查到的常规结构）';
    case 'model':
      return '（资料和检索都没提到，是推断）';
  }
}

/**
 * 节点上的短标题。
 *
 * 横板一屏要放下好几步，节点太宽就只能看到两三个，
 * 反而看不出「这条路有多长」。完整标题在下方详情与悬停 title 里。
 *
 * 截断优先找标点，避免把词切断。
 */
export function shortTitle(title: string, max = 14): string {
  const s = title.trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const m = /[，。；：、,.;:（(）)\s]/g;
  let lastCut = -1;
  let match: RegExpExecArray | null;
  while ((match = m.exec(head)) !== null) lastCut = match.index;
  if (lastCut >= 4) return head.slice(0, lastCut);
  return head + '…';
}
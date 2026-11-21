/**
 * 横板爬塔式学习路线（2026-11-21）。
 *
 * ## 用户要的是什么
 *
 * > 不用单独做个学习顺序的栏，可以把它整合进学习地图里。
 * > 可以以杀戮尖塔那种爬塔式的方式做 ui，只不过是横板的，
 * > 这样更符合「地图」的概念。
 *
 * 所以这一块**不单独成页**，而是学习地图的一部分：
 * 地图上半部分是「我哪块弱」（按资料→章节摊开），
 * 下半部分就是这张横板爬塔图 —— 「我按什么顺序学、推到第几步」。
 *
 * ## 为什么横板
 *
 * 学习路线是**一条有先后的一维路径**（先 A 再 B 再 C）。
 * 竖版会跟上面那张章节表抢垂直空间，而且用户读「第几步」时
 * 视线要上下跳。横板左→右正好对应「往前走」，与「爬塔」的隐喻一致。
 *
 * ## 杀戮尖塔那套里，哪些借了、哪些没借
 *
 * **借的**：
 *  - **节点是一条路径上的关卡**，不是平铺的表格 —— 一眼看出走到哪
 *  - **已走过 / 当前 / 未到达 三种视觉状态**分明
 *  - **当前节点高亮**并给出「你在这里」的明确指示
 *  - **分叉感**：块与块之间留出间隔，像爬塔的层
 *
 * **没借的**：
 *  - 地图随机生成（我们的路径是 AI 排的，有理由）
 *  - 战斗 / 血量 / 卡牌（那是游戏机制，学习不需要假装成游戏）
 *  - 斜向乱序连线（横板就该清楚可读，不是真要做游戏 UI）
 *
 * ## 为什么不做成真画布 / SVG 连线路由
 *
 * 一条线性路径的「连线」就是相邻节点之间的横线段。用 CSS 画
 * 比算 SVG 路径简单得多，也不会在窗口变窄时错位。
 * 节点换行时用 flex-wrap 自然折行，段与段之间仍有视觉连接。
 *
 * ## 数据来源
 *
 * `StudyPlan`（`v2/core/study-plan-store.ts`）：AI 排好、用户确认过的路线。
 * 没有路线时**不显示这一块** —— 不摆一个空的「地图」占位。
 */

import type { KnowledgePoint } from '@/core/model.ts';
import type { StudyPlan, StudyPlanStep } from '@/v2/core/study-plan-store.ts';
import { routeProgress } from '@/v2/core/study-plan-store.ts';

export interface RouteMapProps {
  plan: StudyPlan;
  /** 知识点 id → 当前知识点（已删的查不到） */
  pointById: ReadonlyMap<string, KnowledgePoint>;
  /** 知识点 id → 掌握度 0–1 */
  masteryById: ReadonlyMap<string, number>;
  /** 点某个关卡时的动作（去练它 / 看它） */
  onStep: (step: StudyPlanStep) => void;
  /** 重新排一次（AI） */
  onReplan: () => void;
  /** 清除路线 */
  onClear: () => void;
  /** 正在重排 */
  busy?: boolean;
}

/** 一个关卡的状态 */
type StepState = 'done' | 'current' | 'ahead';

/**
 * 横板爬塔路线图。
 *
 * 布局：按块分组，每块是一「层」，层内节点从左到右。
 * 层与层之间用一段横向间隔 + 一个「下一层」的分隔标记连接。
 */
export function RouteMap(props: RouteMapProps) {
  const { plan, pointById, masteryById, onStep, onReplan, onClear, busy } = props;

  const progress = routeProgress(plan, (id) => (masteryById.get(id) ?? 0) > 0);

  /* 按块分组（保持原顺序） */
  const layers: { title: string; steps: StudyPlanStep[] }[] = [];
  for (const step of plan.steps) {
    const last = layers[layers.length - 1];
    if (last && last.title === step.blockTitle) last.steps.push(step);
    else layers.push({ title: step.blockTitle, steps: [step] });
  }

  function stateOf(step: StudyPlanStep): StepState {
    if ((masteryById.get(step.pointId) ?? 0) > 0) return 'done';
    if (step.pointId === progress.nextPointId) return 'current';
    return 'ahead';
  }

  return (
    <section className="rmap">
      <header className="rmap__head">
        <h2 className="rmap__title">
          学习路线
          <span className="rmap__count">
            {progress.learnedCount} / {progress.total}
          </span>
        </h2>
        <p className="rmap__lead">
          {progress.nextOrder !== null ? (
            <>
              推到<b>第 {progress.nextOrder} 关</b>。
            </>
          ) : (
            <>全部走完了。</>
          )}
          {plan.unplaced > 0 ? (
            <span className="rmap__unplaced">
              {' '}
              另有 {plan.unplaced} 条知识点不在路线里。
            </span>
          ) : null}
        </p>
      </header>

      {/* ==================== 横板路径 ==================== */}
      <div className="rmap__track" role="list" aria-label="学习路线，从左到右">
        {layers.map((layer, li) => (
          <div key={`${layer.title}-${li}`} className="rmap__layer">
            {layer.title ? (
              <div className="rmap__layer-label" title={layer.title}>
                {layer.title}
              </div>
            ) : (
              <div className="rmap__layer-label rmap__layer-label--none" />
            )}

            <div className="rmap__nodes">
              {layer.steps.map((step, si) => {
                const st = stateOf(step);
                const point = pointById.get(step.pointId);
                const gone = !point;
                const statement = point?.statement ?? step.statement;

                return (
                  <div key={step.pointId} className="rmap__slot">
                    {/* 节点之间的连线：除了每层第一个，都有一个「进入」线段 */}
                    {si > 0 || li > 0 ? (
                      <span
                        className={`rmap__link${st === 'done' ? ' rmap__link--done' : ''}`}
                        aria-hidden="true"
                      />
                    ) : null}

                    <button
                      type="button"
                      className={
                        `rmap__node rmap__node--${st}` +
                        (gone ? ' rmap__node--gone' : '') +
                        (step.pointId === progress.nextPointId ? ' rmap__node--next' : '')
                      }
                      onClick={() => onStep(step)}
                      title={
                        (step.difficulty !== null
                          ? `难度 ${step.difficulty}/5（知识点本身的难度，不是你的掌握度）｜`
                          : '难度未知｜') + statement
                      }
                      aria-current={st === 'current' ? 'step' : undefined}
                    >
                      <span className="rmap__order">{step.order}</span>
                      <span className="rmap__label">{shortLabel(statement)}</span>
                      {step.difficulty !== null ? (
                        <span className="rmap__diff" aria-hidden="true">
                          {step.difficulty}
                        </span>
                      ) : null}
                      {st === 'current' ? (
                        <span className="rmap__here">你在这里</span>
                      ) : null}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {/* 路线的终点：全部走完时的「通关」标记，未走完时是「还没到」 */}
        <div className="rmap__end">
          <span
            className={`rmap__end-mark${
              progress.nextOrder === null ? ' rmap__end-mark--reached' : ''
            }`}
            aria-hidden="true"
          >
            ★
          </span>
          <span className="rmap__end-text">
            {progress.nextOrder === null ? '通关' : `${progress.total} 关`}
          </span>
        </div>
      </div>

      {/* ==================== 当前关的详情 ==================== */}
      {progress.nextPointId ? (
        <CurrentStep
          step={plan.steps.find((s) => s.pointId === progress.nextPointId) ?? null}
          point={pointById.get(progress.nextPointId) ?? null}
          mastery={masteryById.get(progress.nextPointId) ?? 0}
          onGo={() => {
            const s = plan.steps.find((x) => x.pointId === progress.nextPointId);
            if (s) onStep(s);
          }}
        />
      ) : null}

      <div className="rmap__actions">
        <button type="button" className="btn-ghost" onClick={onReplan} disabled={busy}>
          {busy ? '正在重新排…' : '让 AI 重新排一次'}
        </button>
        <button type="button" className="btn-ghost" onClick={onClear} disabled={busy}>
          清除这条路线
        </button>
      </div>
    </section>
  );
}

/**
 * 当前这一关的详情。
 *
 * 为什么要单独一块：横板上的节点宽度有限，只放得下短标签。
 * 而用户做决定需要的「这条到底讲什么、为什么排在这里、我掌握到哪」
 * 都得有地方放。放在路径下面比塞进节点里清楚。
 */
function CurrentStep(props: {
  step: StudyPlanStep | null;
  point: KnowledgePoint | null;
  mastery: number;
  onGo: () => void;
}) {
  const { step, point, mastery, onGo } = props;
  if (!step) return null;

  const statement = point?.statement ?? step.statement;
  const gone = !point;

  return (
    <div className="rmap__current">
      <div className="rmap__current-head">
        <span className="rmap__current-badge">当前第 {step.order} 关</span>
        {step.blockTitle ? (
          <span className="rmap__current-block">{step.blockTitle}</span>
        ) : null}
      </div>
      <p className="rmap__current-stmt">{statement}</p>

      <dl className="rmap__current-meta">
        <div>
          <dt>难度</dt>
          <dd>
            {step.difficulty !== null ? (
              <>
                {step.difficulty} / 5
                <span className="rmap__hint-inline">（知识点本身有多难，不是你掌握得怎样）</span>
              </>
            ) : (
              <>
                未知
                <span className="rmap__hint-inline">（AI 没给判断，不猜）</span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>你的掌握</dt>
          <dd>
            {masteryWord(mastery)}
            <span className="rmap__hint-inline">（按你的复习记录算）</span>
          </dd>
        </div>
        {step.reason ? (
          <div>
            <dt>为什么排这里</dt>
            <dd>{step.reason}</dd>
          </div>
        ) : null}
        {step.basis ? (
          <div>
            <dt>依据</dt>
            <dd>{step.basis}</dd>
          </div>
        ) : null}
      </dl>

      {gone ? (
        <p className="rmap__current-gone">
          这条知识点已经从知识库里删掉了。它在路线里的位置还留着，但没法再练。
        </p>
      ) : (
        <button type="button" className="btn-fill btn-fill--sm" onClick={onGo}>
          去攻这一关 →
        </button>
      )}
    </div>
  );
}

/**
 * 掌握度说成人话。
 *
 * 档位与 `srs.ts` 的 `masteryLabel` 对齐（0.85 很熟 / 0.6 熟练 / 0.35 有点印象），
 * 免得同一个数字在两个界面上有两种说法。
 */
function masteryWord(m: number): string {
  if (m <= 0) return '还没练过';
  if (m >= 0.85) return '很熟';
  if (m >= 0.6) return '熟练';
  if (m >= 0.35) return '有点印象';
  return '刚起步';
}

/**
 * 节点上显示的短标签。
 *
 * 为什么截断到 12 个字：横板上一屏要放下好几关，
 * 节点太宽就只能看到两三个，反而看不出「这条路线有多长」。
 * 完整陈述在节点下方详情里，以及悬停 title 里。
 *
 * 截断位置优先找标点，避免把词切断（「信号的分类方式有…」比
 * 「信号的分类方式有三」读起来自然）。
 */
export function shortLabel(statement: string, max = 12): string {
  const s = statement.trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  /* 在标点处断开读起来更自然 */
  const m = /[，。；：、,.;:（(]/g;
  let lastCut = -1;
  let match: RegExpExecArray | null;
  while ((match = m.exec(head)) !== null) lastCut = match.index;
  if (lastCut >= 4) return head.slice(0, lastCut);
  return head + '…';
}
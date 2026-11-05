import type { KnowledgeBackendSummary } from '@/core/knowledge/service.ts';
import { locatedRatio, sumBackends } from './types.ts';

/**
 * 后端筛选 / 对比条（P5 第 4 条）。
 *
 * ## 为什么这不只是「筛选器」
 *
 * 计划书 P5 第 4 条要的是「同一份资料用不同后端整理的结果能**并存对比**」。
 * 如果只做成一个下拉筛选，用户能做的只是「看 A / 看 B」，
 * 而他真正想知道的差别是**这一家跑得怎么样**：产出了多少条、
 * 其中多少条真的能点回原文。所以每组 chip 上直接带
 * `条数 / 可点回 / 待处理` 三个数，并排摆着——横向一比就看出来了。
 *
 * ## 为什么只有 1 个后端时不显示
 *
 * 一个选项的筛选器只是噪音：它占掉一整行，却永远只有一个状态。
 * 由调用方判断 `summaries.length >= 2` 后再渲染本组件。
 *
 * ## 为什么「全部」也要给
 *
 * 默认选条数最多的那组，是为了让用户一进页面就看到「最完整的那一份」；
 * 但两条都看、比对同一句话在两个后端里给出的表述是否一致，也是真实需求。
 */

export interface BackendCompareProps {
  /** core 给出的分组统计，按条数从多到少 */
  summaries: KnowledgeBackendSummary[];
  /** 当前筛选到的后端；null = 全部 */
  selected: string | null;
  onSelect: (backendId: string | null) => void;
  /** backendId → 可读名字。映射不到时必须返回「未知后端（id）」而不是空串 */
  labelOf: (backendId: string) => string;
  /** 整理面板当前选中的后端：在对应 chip 上标「当前」，说明重新整理会写哪一组 */
  currentBackendId: string;
}

/** 全部条目的合计。与各分组同源，不会对不上 */
function totals(summaries: KnowledgeBackendSummary[]) {
  return sumBackends(summaries);
}

function ChipStats({
  count,
  located,
  unlocated,
  waived,
}: {
  count: number;
  located: number;
  unlocated: number;
  waived: number;
}) {
  return (
    <span className="kp-backend-chip__stats">
      <strong>{count}</strong> 条
      <span className="kp-backend-chip__dot" aria-hidden="true">
        ·
      </span>
      {unlocated === 0 ? (
        <span className="kp-backend-chip__ok">全部可点回</span>
      ) : (
        <>
          <span>可点回 {located}</span>
          <span className="kp-backend-chip__dot" aria-hidden="true">
            ·
          </span>
          <span className="kp-backend-chip__warn">待处理 {unlocated}</span>
        </>
      )}
      {waived > 0 ? (
        <>
          <span className="kp-backend-chip__dot" aria-hidden="true">
            ·
          </span>
          <span className="kp-backend-chip__muted">无出处 {waived}</span>
        </>
      ) : null}
    </span>
  );
}

export function BackendCompare({
  summaries,
  selected,
  onSelect,
  labelOf,
  currentBackendId,
}: BackendCompareProps) {
  const all = totals(summaries);

  return (
    <section className="card kp-backends" aria-label="按后端对比整理结果">
      <div className="kp-backends__head">
        <div className="kp-backends__title">这份资料有 {summaries.length} 个后端的结果</div>
        <div className="page__muted">
          点一组只看那一份。数字横向比一下就知道哪家产得多、哪家更多能点回原文——
          这是 P5「不同后端结果并存对比」要回答的问题。
        </div>
      </div>

      <div className="kp-backends__chips" role="group" aria-label="按后端筛选">
        <button
          type="button"
          className={`kp-backend-chip${selected === null ? ' kp-backend-chip--active' : ''}`}
          onClick={() => onSelect(null)}
          aria-pressed={selected === null}
        >
          <span className="kp-backend-chip__name">全部</span>
          <ChipStats {...all} />
        </button>

        {summaries.map((s) => {
          const isCurrent = s.backendId === currentBackendId;
          return (
            <button
              key={s.backendId}
              type="button"
              className={`kp-backend-chip${selected === s.backendId ? ' kp-backend-chip--active' : ''}`}
              onClick={() => onSelect(s.backendId)}
              aria-pressed={selected === s.backendId}
              title={
                isCurrent
                  ? '整理面板当前选的就是这个后端：重新整理会先清空这一份'
                  : `可点回 ${s.located} / ${s.count} 条（${locatedRatio(s)}）`
              }
            >
              <span className="kp-backend-chip__name">
                {labelOf(s.backendId)}
                {isCurrent ? <span className="kp-backend-chip__current">当前</span> : null}
              </span>
              <ChipStats
                count={s.count}
                located={s.located}
                unlocated={s.unlocated}
                waived={s.waived}
              />
            </button>
          );
        })}
      </div>
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Notice } from '@/components/states.tsx';
import { useServices } from '@/app/services-context.ts';
import {
  estimateCostCny,
  formatCost,
  localDay,
  startOfMonth,
  type UsageByBackend,
  type UsageByDay,
} from '@/core/usage.ts';
import { findPreset } from '@/core/ai/presets.ts';
import './usage.css';

/**
 * 用量统计区。
 *
 * ## 设计上的克制
 *
 * 用户填的是自己的 Key，花的是真钱，所以这一区必须存在（计划书 P5 第 5 条）。
 * 但它不该变成一屏折线图加一堆小数：用户真正想知道的只有三件事
 * ——花了多少、谁花的、花在整理还是出题上。
 *
 * 所以这里只有：三个数字、一份按后端的清单、一条按天的柱状趋势。
 *
 * ## 关于金额
 *
 * 明确写「估算，实际以账单为准」。各家计费规则差异很大
 * （输入输出两档价、缓存命中折扣、阶梯价、赠送额度），
 * 我们只有 token 总数，算不出精确金额。给一个量级参考比不给有用，
 * 但必须说清楚它是什么，否则用户拿它对账会怀疑软件在撒谎。
 */

const RANGE_LABEL = {
  month: '本月',
  all: '全部',
} as const;

type Range = keyof typeof RANGE_LABEL;

export function UsageSection() {
  const { usage } = useServices();

  const [range, setRange] = useState<Range>('month');
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'failed'; message: string; hint: string }
    | { kind: 'ready'; total: { tokens: number; calls: number }; byBackend: UsageByBackend[]; byDay: UsageByDay[] }
  >({ kind: 'loading' });
  /** 数据变更计数：清空后要重读，不能靠 range 变化触发 */
  const [revision, setRevision] = useState(0);

  const load = useCallback(async () => {
    const from = range === 'month' ? startOfMonth() : undefined;
    try {
      const [total, byBackend, byDay] = await Promise.all([
        usage.total(from),
        usage.byBackend(from),
        usage.byDay(from),
      ]);
      setState({ kind: 'ready', total, byBackend, byDay });
    } catch (err) {
      setState({
        kind: 'failed',
        message: err instanceof Error ? err.message : String(err),
        hint: '用量记录读不出来时其他功能不受影响，可以先正常使用。如果反复出现，检查浏览器是否禁用了本地存储。',
      });
    }
  }, [usage, range]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const [clearing, setClearing] = useState(false);

  const handleClear = useCallback(async () => {
    /**
     * 二次确认用 window.confirm 而不是自建弹窗：
     * 这是「清空统计」而不是删数据，成本很低，用一个原生确认足够。
     * 自建弹窗要处理焦点、ESC、遮罩，为这一步不值得。
     */
    if (!window.confirm('清空用量统计？已经花掉的钱不会变，只是这里的记录会从零开始。')) {
      return;
    }
    setClearing(true);
    try {
      await usage.clear();
      setRevision((v) => v + 1);
    } finally {
      setClearing(false);
    }
  }, [usage]);

  return (
    <section className="card">
      <div className="card__head">
        <div>
          <div className="card__title">用量统计</div>
          <div className="card__subtitle">
            按天、按后端记录 token 消耗。数据只存在本机，不联网、不上报。
          </div>
        </div>
        <div className="usage-range" role="group" aria-label="统计范围">
          {(Object.keys(RANGE_LABEL) as Range[]).map((key) => (
            <button
              key={key}
              type="button"
              className={`usage-range__btn${range === key ? ' is-active' : ''}`}
              aria-pressed={range === key}
              onClick={() => setRange(key)}
            >
              {RANGE_LABEL[key]}
            </button>
          ))}
        </div>
      </div>

      <div className="card__body">
        {state.kind === 'loading' ? <div className="usage-muted">读取中…</div> : null}

        {state.kind === 'failed' ? (
          <Notice tone="danger" title={state.message}>
            {state.hint}
          </Notice>
        ) : null}

        {state.kind === 'ready' ? (
          <UsageBody
            total={state.total}
            byBackend={state.byBackend}
            byDay={state.byDay}
            range={range}
            clearing={clearing}
            onClear={handleClear}
          />
        ) : null}
      </div>
    </section>
  );
}

function UsageBody({
  total,
  byBackend,
  byDay,
  range,
  clearing,
  onClear,
}: {
  total: { tokens: number; calls: number };
  byBackend: UsageByBackend[];
  byDay: UsageByDay[];
  range: Range;
  clearing: boolean;
  onClear: () => void;
}) {
  if (total.tokens === 0) {
    return (
      <div className="usage-empty">
        <div className="usage-empty__title">
          {range === 'month' ? '本月还没有产生用量' : '还没有产生用量'}
        </div>
        <p className="usage-empty__desc">
          用 AI 整理知识点或出题之后，这里会显示消耗了多少 token。
          备注：示例后端（离线演示用）不花钱，所以不会出现在统计里。
        </p>
      </div>
    );
  }

  /** 全部后端折算后的总金额。按服务商分别算再加，不能用总 token 乘单一单价 */
  const cost = byBackend.reduce((sum, b) => sum + estimateCostCny(b.tokens, b.provider), 0);

  return (
    <div className="usage">
      <div className="usage-stats">
        <Stat label="累计 token" value={total.tokens.toLocaleString('zh-CN')} />
        <Stat label="请求次数" value={String(total.calls)} />
        <Stat label="估算花费" value={formatCost(cost)} note="按公开单价粗算，实际以各家账单为准" />
      </div>

      <div className="usage-block">
        <div className="usage-block__title">按后端</div>
        <ul className="usage-list">
          {byBackend.map((b) => {
            const preset = findPreset(b.provider);
            const share = total.tokens > 0 ? b.tokens / total.tokens : 0;
            return (
              <li key={b.backendId} className="usage-item">
                <div className="usage-item__row">
                  <span className="usage-item__name">{preset?.label ?? providerLabel(b.provider)}</span>
                  <span className="usage-item__tokens">{b.tokens.toLocaleString('zh-CN')} token</span>
                </div>
                <div className="usage-bar" aria-hidden="true">
                  <div className="usage-bar__fill" style={{ width: `${Math.round(share * 100)}%` }} />
                </div>
                <div className="usage-item__meta">
                  <span>{Math.round(share * 100)}%</span>
                  <span>整理 {b.organizeTokens.toLocaleString('zh-CN')}</span>
                  <span>出题 {b.questionsTokens.toLocaleString('zh-CN')}</span>
                  {b.slidesTokens > 0 ? (
                    <span>PPT {b.slidesTokens.toLocaleString('zh-CN')}</span>
                  ) : null}
                  <span>{b.calls} 次请求</span>
                  <span>约 {formatCost(estimateCostCny(b.tokens, b.provider))}</span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="usage-block">
        <div className="usage-block__title">按天</div>
        <DayBars days={byDay} />
      </div>

      <div className="usage-foot">
        <span className="usage-foot__hint">
          只统计真实模型后端；示例后端不产生费用，不计入。
          金额按公开单价粗算，各家计费规则不同（输入输出两档价、缓存折扣、赠送额度），实际以账单为准。
        </span>
        <button type="button" className="btn btn--ghost btn--sm" disabled={clearing} onClick={onClear}>
          {clearing ? '清空中…' : '清空统计'}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="usage-stat">
      <div className="usage-stat__label">{label}</div>
      <div className="usage-stat__value">{value}</div>
      {note ? <div className="usage-stat__note">{note}</div> : null}
    </div>
  );
}

/**
 * 按天的柱状图。
 *
 * 用纯 div + 高度百分比，不引图表库：这里最多几十根柱子，
 * 引一个 200KB 的图表库为了画它不值得，而且样式还要跟设计令牌对齐。
 */
function DayBars({ days }: { days: UsageByDay[] }) {
  const max = Math.max(...days.map((d) => d.tokens), 1);
  const today = localDay();

  return (
    <div className="usage-bars">
      {days.map((d) => {
        const height = Math.max(2, Math.round((d.tokens / max) * 100));
        return (
          <div key={d.day} className="usage-bar-col" title={`${d.day}：${d.tokens.toLocaleString('zh-CN')} token`}>
            <div className="usage-bar-col__track">
              <div
                className={`usage-bar-col__fill${d.day === today ? ' is-today' : ''}`}
                style={{ height: `${height}%` }}
              />
            </div>
            <div className="usage-bar-col__label">{d.day.slice(5)}</div>
          </div>
        );
      })}
    </div>
  );
}

/** 服务商标识认不出时的兜底显示。不能显示空白，否则用户看不出是哪个后端 */
function providerLabel(provider: string): string {
  if (provider === 'unknown') return '未知服务商';
  if (provider === 'custom') return '自定义服务';
  return provider;
}

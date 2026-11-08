/**
 * 出题配额：每种题型各出几道 + 限定认知层级。
 *
 * ## 为什么单独一个组件
 *
 * `GeneratePage.tsx` 是 CRLF/LF 混用的大文件，交接文档警告过「按行号批量替换会错位」
 * （历史上因此改坏过两次）。所以新增 UI 一律独立成文件，GeneratePage 里只插一行引用。
 *
 * ## 为什么不再用「总数 + 按题型轮流分」（2026-11-08）
 *
 * 原来的 `count` 是一个总数，模型自己决定怎么分给各题型。
 * 两个后果：
 *  - 真实后端：勾了判断+问答，模型全给单选（提示词只能「要求」，不能保证）
 *  - mock 后端：`kinds[i % kinds.length]` 硬轮转，6 道 3 种必然 2/2/2，
 *    用户没法要「5 道单选 + 1 道问答」
 *
 * 现在逐种填数字。总题数由它求和得出 —— **不再有一个独立的「总数」输入框**，
 * 否则两个数字会打架（用户填总数 10、配额加起来 12，该信谁？）。
 *
 * ## 认知层级为什么值得暴露
 *
 * 后端一直支持 `levels` 过滤（`generate` 的选项里有），但界面写死 `null` ——
 * 等于「按知识点自身的层级出题」，用户想「只出应用题」时没有办法。
 * 这是「后端有能力、界面够不着」，属于白丢的能力。
 *
 * 层级怎么选都不会让题变少到 0：后端的行为是「过滤后若为空就退回全部」
 * （见 mock-backend 的 filterByLevels），所以不会出现「选了没题」的死路。
 */

import { useMemo } from 'react';
import type { KnowledgePoint, QuestionKind } from '@/core/model.ts';
import { GENERATE_KINDS, kindSpec } from '@/core/questions/kinds.ts';

export type CognitiveLevel = KnowledgePoint['cognitiveLevel'];

/** 认知层级的显示名（由浅到深） */
export const LEVEL_OPTIONS: { key: CognitiveLevel; label: string; hint: string }[] = [
  { key: 'remember', label: '记忆', hint: '背定义、记事实' },
  { key: 'understand', label: '理解', hint: '能解释、能举例' },
  { key: 'apply', label: '应用', hint: '能拿来解题' },
  { key: 'analyze', label: '分析', hint: '能比较、能推论' },
];

export interface QuotaPickerProps {
  /** 已选的题型 */
  kinds: QuestionKind[];
  /** 每种题型的数量（未出现的按 0 计） */
  counts: Partial<Record<QuestionKind, number>>;
  onCountsChange: (next: Partial<Record<QuestionKind, number>>) => void;
  /** 限定的认知层级；空数组 = 不限 */
  levels: CognitiveLevel[];
  onLevelsChange: (next: CognitiveLevel[]) => void;
  disabled?: boolean;
}

/** 单个题型的数量上限：再多也没有意义，而且会拖很久 */
const MAX_PER_KIND = 30;

export function QuotaPicker({
  kinds,
  counts,
  onCountsChange,
  levels,
  onLevelsChange,
  disabled,
}: QuotaPickerProps) {
  const total = useMemo(
    () => kinds.reduce((n, k) => n + Math.max(0, Math.floor(counts[k] ?? 0)), 0),
    [kinds, counts],
  );

  function setCount(kind: QuestionKind, raw: string) {
    /*
     * 空字符串要按 0 处理而不是 NaN。
     * 用户清空输入框准备重打时，NaN 会让上面的「合计」显示 NaN —— 很难看。
     */
    const n = raw.trim() === '' ? 0 : Math.floor(Number(raw));
    const safe = Number.isFinite(n) ? Math.min(MAX_PER_KIND, Math.max(0, n)) : 0;
    onCountsChange({ ...counts, [kind]: safe });
  }

  /** 把总数平均分给已选题型（除不尽的余数给前面的） */
  function spreadEvenly(totalWanted: number) {
    if (kinds.length === 0) return;
    const base = Math.floor(totalWanted / kinds.length);
    const rest = totalWanted % kinds.length;
    const next: Partial<Record<QuestionKind, number>> = {};
    kinds.forEach((k, i) => {
      next[k] = Math.min(MAX_PER_KIND, base + (i < rest ? 1 : 0));
    });
    onCountsChange(next);
  }

  function toggleLevel(key: CognitiveLevel) {
    const has = levels.includes(key);
    onLevelsChange(has ? levels.filter((x) => x !== key) : [...levels, key]);
  }

  return (
    <div className="quota">
      {/* ---------- 每种几张 ---------- */}
      <div className="quota__head">
        <span className="quota__label">每种题型出几道</span>
        <span className={`quota__total${total === 0 ? ' quota__total--zero' : ''}`}>
          合计 <strong>{total}</strong> 道
        </span>
      </div>

      <ul className="quota__list">
        {kinds.map((k) => {
          const spec = kindSpec(k);
          const n = counts[k] ?? 0;
          return (
            <li key={k} className="quota__row">
              <span className="quota__name">{spec?.label ?? k}</span>
              <input
                className="quota__input"
                type="number"
                min={0}
                max={MAX_PER_KIND}
                value={n}
                disabled={disabled}
                aria-label={`${spec?.label ?? k} 出几道`}
                onChange={(e) => setCount(k, e.target.value)}
              />
              <span className="quota__unit">道</span>
            </li>
          );
        })}
      </ul>

      <div className="quota__quick">
        <span className="quota__quick-label">快速填：</span>
        {[4, 6, 10, 20].map((t) => (
          <button
            key={t}
            type="button"
            className="quota__quick-btn"
            disabled={disabled}
            onClick={() => spreadEvenly(t)}
          >
            共 {t} 道
          </button>
        ))}
      </div>

      {total === 0 ? (
        <p className="quota__warn">还没有指定数量 —— 至少要给一种题型填个大于 0 的数。</p>
      ) : null}

      {/* ---------- 认知层级 ---------- */}
      <div className="quota__head quota__head--level">
        <span className="quota__label">限定认知层级</span>
        <span className="quota__hint">
          {levels.length === 0 ? '不限（按知识点自身的层级出）' : `只出这 ${levels.length} 层`}
        </span>
      </div>

      <div className="quota__levels" role="group" aria-label="认知层级">
        {LEVEL_OPTIONS.map((lv) => {
          const on = levels.includes(lv.key);
          return (
            <button
              key={lv.key}
              type="button"
              className={`quota__level${on ? ' quota__level--on' : ''}`}
              aria-pressed={on}
              disabled={disabled}
              title={lv.hint}
              onClick={() => toggleLevel(lv.key)}
            >
              {lv.label}
            </button>
          );
        })}
      </div>

      {levels.length > 0 ? (
        <p className="quota__note">
          只会从这一层的知识点里出题。如果这一层的知识点不够，后端会退回用全部知识点
          —— 不会因为限得太窄而一道题都出不来。
        </p>
      ) : null}
    </div>
  );
}

/** 从 counts 求总题数（调用方用，避免各处再 reduce 一遍） */
export function totalOfCounts(counts: Partial<Record<QuestionKind, number>>): number {
  return GENERATE_KINDS.reduce((n, k) => n + Math.max(0, Math.floor(counts[k] ?? 0)), 0);
}

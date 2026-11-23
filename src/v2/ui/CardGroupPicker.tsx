/**
 * 闪卡归属选择（2026-11-24）。
 *
 * 用户要求：「用户使用这个功能写完闪卡后再决定闪卡归属知识点类、错题类
 * 还是记忆类」。所以这个选择器出现在**写完之后**（写卡面板、编辑面板、
 * 导入确认），而不是在点「＋ 写闪卡」的那一刻。
 *
 * 三档对应数据层的 `Flashcard.sourceKind`（见 `sourceKindOfGroup`）：
 * 知识点 → 'point'、错题 → 'wrong'、记忆 → 'manual'。
 *
 * 为什么用 radio 而不是分段按钮：三档是互斥的**单选**语义，
 * radio 让屏幕阅读器读得出"三选一、当前选的是哪个"，
 * 而一排 button 只会被读成三个独立按钮。
 */
import { useId } from 'react';
import type { CardGroup } from '@/v2/core/callout-kind.ts';

export interface CardGroupPickerProps {
  value: CardGroup;
  onChange: (next: CardGroup) => void;
  disabled?: boolean;
  /** 上面那行说明；不给就不显示 */
  label?: string;
  /** 下面那行补充说明；不给就不显示 */
  hint?: string;
}

const OPTIONS: { group: CardGroup; label: string; title: string }[] = [
  { group: 'point', label: '知识点', title: '从知识库里来的、陈述知识点的卡' },
  { group: 'wrong', label: '错题', title: '记录自己错在哪、怎么不重犯的卡' },
  { group: 'memory', label: '记忆', title: '自己写的、让 AI 组织的、靠挖空记的卡' },
];

export function CardGroupPicker({
  value,
  onChange,
  disabled = false,
  label,
  hint,
}: CardGroupPickerProps) {
  const name = useId();
  return (
    <div className="fcx__grouppick">
      {label ? <span className="fcx__grouppick-label">{label}</span> : null}
      <div className="fcx__grouppick-opts" role="radiogroup" aria-label="闪卡归属">
        {OPTIONS.map((o) => (
          <label
            key={o.group}
            className={`fcx__grouppick-opt${value === o.group ? ' fcx__grouppick-opt--on' : ''}`}
            title={o.title}
          >
            <input
              type="radio"
              name={name}
              value={o.group}
              checked={value === o.group}
              disabled={disabled}
              onChange={() => onChange(o.group)}
            />
            {o.label}
          </label>
        ))}
      </div>
      {hint ? <span className="fcx__grouppick-hint">{hint}</span> : null}
    </div>
  );
}

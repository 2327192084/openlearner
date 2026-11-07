/**
 * 题型多选器。
 *
 * ## 为什么抽成独立组件
 *
 * `GeneratePage.tsx` 是 CRLF/LF 混用的大文件，交接文档明确警告过
 * 「按行号批量替换会错位」（本轮之前已经因此把结构改坏两次）。
 * 所以新增的这块 UI 单独一个文件，在 GeneratePage 里只插入一行引用。
 *
 * ## 从「单选一种」改成「可多选」
 *
 * 原来是一个 `<select>`，只能选一种题型。但实际出题时经常想
 * 「这一章既要有选择题也要有问答」—— 一种一种出要来回改设置。
 *
 * 现在勾选式：勾几种就出几种，按题型轮流分配数量。
 *
 * ## 为什么带「说明」和「耗时」
 *
 * 用户不一定知道「问答比单选记得牢」这类结论。每题一行说明，
 * 把「为什么该选它」讲清楚，比只列四个名字有用。
 */

import type { QuestionKind } from '@/core/model.ts';
import { GENERATE_KINDS, KIND_SPECS, kindSpec } from '@/core/questions/kinds.ts';

export interface KindPickerProps {
  /** 已选的题型（顺序无关） */
  value: QuestionKind[];
  onChange: (next: QuestionKind[]) => void;
  disabled?: boolean;
}

export function KindPicker({ value, onChange, disabled }: KindPickerProps) {
  const picked = new Set(value);

  function toggle(id: QuestionKind) {
    const next = new Set(picked);
    if (next.has(id)) {
      /*
       * 至少要留一种题型。
       *
       * 全都不选时静默退回「单选」是坏做法 —— 用户以为出的是自己
       * 想要的题型，结果出来单选。所以这里直接禁止取消最后一个。
       */
      if (next.size <= 1) return;
      next.delete(id);
    } else {
      next.add(id);
    }
    /* 保持注册表顺序，避免勾选顺序影响出题配比 */
    onChange(GENERATE_KINDS.filter((k) => next.has(k)));
  }

  return (
    <div className="gen-kinds">
      {GENERATE_KINDS.map((id) => {
        const spec = kindSpec(id);
        if (!spec) return null;
        const on = picked.has(id);
        return (
          <button
            key={id}
            type="button"
            className={`gen-kind${on ? ' gen-kind--on' : ''}`}
            onClick={() => toggle(id)}
            disabled={disabled}
            aria-pressed={on}
            title={spec.hint}
          >
            {/*
              勾选框里的对勾是**纯装饰**。
              用 CSS 画（::after）而不是塞一个字符：
              塞字符会让 innerText 变成「✓
单选题
说明」，
              于是按文本找按钮的地方（自动化测试、读屏软件）
              拿到的第一行是 ✓，而不是题型名 —— 实测踩过。
            */}
            <span className="gen-kind__box" aria-hidden="true" />
            <span className="gen-kind__body">
              <span className="gen-kind__name">
                {spec.label}
                {spec.graded === 'self' ? (
                  <span className="gen-kind__tag">自评</span>
                ) : null}
              </span>
              <span className="gen-kind__hint">{spec.hint}</span>
            </span>
          </button>
        );
      })}

      {picked.size > 1 ? (
        <p className="gen-kinds__note">
          选了 {picked.size} 种：题目会按题型轮流分配。数量填 {`N`} 表示总数。
        </p>
      ) : null}
    </div>
  );
}

/** 供测试与别处复用：题型短名表 */
export const KIND_SHORT: Record<QuestionKind, string> = Object.fromEntries(
  KIND_SPECS.map((s) => [s.id, s.short]),
) as Record<QuestionKind, string>;

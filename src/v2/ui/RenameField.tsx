/**
 * 就地改名（2026-11-13 傍晚，用户要求）。
 *
 * ## 用户原话
 *
 * > 「建议：加个更名功能，可以更名资料库的资料，题组。」
 *
 * 截图里那些名字是从 PDF 文件名自动带出来的：
 * 「信号与系统（第二版）第1章 信号与系统 正文（不含习题）」——
 * 长到在列表里被截断，用户没法把它改成「第1章 信号与系统」。
 *
 * ## 为什么做成一个独立组件
 *
 * 资料页 656 行、题组页也不小，两边都要同一套交互。
 * 复制一遍必然有一边慢慢走样（这个项目已经因为「反馈实现两遍」漏过一次，
 * 见 `GenFeedback.tsx` 的注释）。所以抽成一处，两边只用它。
 *
 * ## 为什么是「就地展开」而不是弹模态框
 *
 * 与「跳页」一致（2026-11-13 上午那次）：改名是**一行内的小改动**，
 * 弹一个盖住全屏的模态框会让用户失去「我改的是哪一行」的参照。
 * 就地展开时那一行仍在原处，输入框里就是当前名字。
 *
 * ## 交互约定
 *
 * - 回车 = 保存（写库的活儿交给调用方，这里只负责收集与校验）
 * - Esc = 取消，**不保存**
 * - 失焦 = 取消（不是保存）。理由：误点别处就悄悄改了名字，
 *   比「白改一次」更糟 —— 改名是可见且需要确认意图的操作。
 * - 出错时把原因写在输入框下面，不弹窗（不用关掉一个对话框才能继续改）
 */

import { useEffect, useRef, useState } from 'react';
import { checkNewTitle, isRenameError } from '@/v2/core/rename.ts';

export interface RenameFieldProps {
  /** 当前名字（输入框的初始值） */
  current: string;
  /** 保存。抛错时错误会显示在输入框下面 */
  onSave: (title: string) => Promise<void> | void;
  /** 取消（用户按 Esc / 失焦 / 点「取消」） */
  onCancel: () => void;
  /** 自动聚焦（默认 true）。列表里点「改名」展开时是需要聚焦的 */
  autoFocus?: boolean;
  /** 输入框的无障碍名，如「资料名」「题组名」 */
  label: string;
}

export function RenameField({
  current,
  onSave,
  onCancel,
  autoFocus = true,
  label,
}: RenameFieldProps) {
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /**
   * 已经提交/取消过就不再响应失焦。
   *
   * 不加这个：按回车保存成功后组件被父级卸载，卸载过程中可能触发一次
   * blur，blur 又调 onCancel —— 表现是「保存之后又闪一下」。
   */
  const doneRef = useRef(false);

  useEffect(() => {
    if (!autoFocus) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    /* 全选：用户多半是要整段替换（把一长串文件名改成短标题） */
    el.select();
  }, [autoFocus]);

  async function commit() {
    if (doneRef.current) return;
    const check = checkNewTitle(draft, current);
    if (!check.ok) {
      /*
       * 「和原来一样」不是错误：直接当取消处理，不写库
       * （写库会无谓刷 updatedAt，让资料看起来刚被编辑过）。
       */
      if (isRenameError(check)) {
        setError(check.reason);
        return;
      }
      doneRef.current = true;
      onCancel();
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave(check.title);
      doneRef.current = true;
    } catch (e) {
      /* 保存失败要留在原地让用户重试，所以这里**不**置 doneRef */
      setError(e instanceof Error ? e.message : '改名没成功，再试一次');
      setSaving(false);
    }
  }

  function cancel() {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  }

  return (
    <span className="rename-field">
      <input
        ref={inputRef}
        type="text"
        className={`rename-field__input${error ? ' rename-field__input--bad' : ''}`}
        value={draft}
        disabled={saving}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          /* 一边改一边清掉上一次的错误，否则红字会一直挂到重新提交 */
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => {
          /*
           * 失焦 = 取消。
           * 用 setTimeout 让「点保存按钮」那条路径先跑完 ——
           * 点按钮会先触发 input 的 blur，再触发按钮的 click；
           * 若在这里立刻取消，按钮就再也点不到了。
           */
          setTimeout(() => {
            if (!doneRef.current && !saving) cancel();
          }, 120);
        }}
      />
      <button
        type="button"
        className="rename-field__ok"
        disabled={saving}
        onClick={() => void commit()}
        onMouseDown={(e) => e.preventDefault()}
      >
        {saving ? '保存中…' : '保存'}
      </button>
      <button
        type="button"
        className="rename-field__cancel"
        disabled={saving}
        onClick={cancel}
        onMouseDown={(e) => e.preventDefault()}
      >
        取消
      </button>
      {error ? (
        <span className="rename-field__error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

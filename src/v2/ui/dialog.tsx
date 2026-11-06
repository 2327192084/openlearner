import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * 二次确认框。
 *
 * 只用来拦「不可撤销」的动作：删除后端、用备份整体替换学习库。
 * 三件事必须做到，缺一样这个框就比 window.confirm 更糟：
 *
 *  1. 初始焦点落在「取消」上 —— 回车不该等于确认
 *  2. 执行中不可关闭、不可重复点 —— 连点两次不会删两遍
 *  3. 失败时错误留在框里，不关框 —— 用户需要知道为什么没成
 *
 * 用原生 <div role="dialog"> 而不是 <dialog>：后者的 showModal()
 * 在 Electron 与某些 Edge 版本上会吃掉 Escape 键，得再补一层。
 */
export interface ConfirmDialogProps {
  title: string;
  /** 一句话讲清「会发生什么」，不是「确定吗」 */
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  blocked?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

export function ConfirmDialog({
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = '取消',
  tone = 'danger',
  blocked = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const alive = useRef(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = working || blocked;

  useEffect(() => {
    alive.current = true;
    cancelRef.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || locked) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [locked, onClose]);

  const confirm = async () => {
    if (locked) return;
    setWorking(true);
    setError(null);
    try {
      await onConfirm();
      // 成功后由调用方关闭；这里不主动 onClose，
      // 因为调用方可能要先刷新数据再关。
    } catch (err) {
      if (alive.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (alive.current) setWorking(false);
    }
  };

  return (
    <div className="set-modal">
      <button
        type="button"
        className="set-modal__scrim"
        aria-label="关闭"
        onClick={() => {
          if (!locked) onClose();
        }}
      />
      <div
        className="set-modal__box"
        role="dialog"
        aria-modal="true"
        aria-labelledby="set-modal-title"
      >
        <h2 className="set-modal__title" id="set-modal-title">
          {title}
        </h2>
        {description ? <p className="set-modal__desc">{description}</p> : null}
        {children}
        {error ? (
          <p className="set-inline set-inline--error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="set-modal__actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn-ghost"
            onClick={onClose}
            disabled={locked}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn-fill btn-fill--sm${tone === 'danger' ? ' btn-fill--danger' : ''}`}
            onClick={() => void confirm()}
            disabled={locked}
          >
            {working ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

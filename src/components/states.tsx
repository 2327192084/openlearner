import type { ReactNode } from 'react';

/**
 * 统一的状态组件。
 *
 * P0 第 5 条要求「空状态与错误状态的统一样式：没资料时显示什么、失败时怎么提示」。
 * 集中在这里定义，页面只传文案，所以全应用不会出现五种长相的空态。
 */

export function EmptyState({
  title,
  description,
  icon = '◍',
  actions,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty__icon" aria-hidden="true">
        {icon}
      </div>
      <div className="empty__title">{title}</div>
      {description ? <div className="empty__desc">{description}</div> : null}
      {actions ? <div className="empty__actions">{actions}</div> : null}
    </div>
  );
}

/**
 * 错误态。
 *
 * 强制要求 `hint`：计划书 P1 明确「导入失败给明确原因，不要只说失败」。
 * 把「下一步怎么办」做成必填参数，从类型上就不允许写出一个只说失败的错误页。
 * `detail` 是给开发排查用的原文，默认折叠展示，不给普通用户看。
 */
export function ErrorState({
  title,
  message,
  hint,
  detail,
  onRetry,
  retryLabel = '重试',
}: {
  title: string;
  message: string;
  hint: string;
  detail?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="error-state" role="alert">
      <div className="error-state__icon" aria-hidden="true">
        !
      </div>
      <div className="error-state__title">{title}</div>
      <div className="error-state__message">{message}</div>
      <div className="error-state__hint">
        <strong>下一步：</strong>
        {hint}
      </div>
      {detail ? <pre className="error-state__detail">{detail}</pre> : null}
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

export function LoadingState({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'planned' | 'ready' | 'info' | 'danger';
  children: ReactNode;
}) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warning' | 'danger';
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={`notice notice--${tone}`}>
      <div>
        {title ? <div className="notice__title">{title}</div> : null}
        <div className="notice__body">{children}</div>
      </div>
    </div>
  );
}

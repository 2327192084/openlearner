import type { ReactNode } from 'react';
import { Badge, Notice } from '@/components/states.tsx';
import './page.css';

/**
 * 占位页。
 *
 * P0 阶段六个入口都还没有业务功能，点进去要显示「该功能待接入」。
 * 关键是不能让占位页看起来像坏了——所以它要说清三件事：
 * 这里将来做什么、现在到哪一步了、现在能去哪。
 *
 * 刻意不做「画个假界面」：假界面会让评审和队友都误判进度。
 */
export function PlaceholderPage({
  title,
  summary,
  phase,
  items,
  footer,
}: {
  title: string;
  summary: string;
  phase?: string;
  /** 计划书里这一阶段「要实现的功能」，让占位页有信息量 */
  items?: string[];
  footer?: ReactNode;
}) {
  return (
    <div className="page">
      <header className="page__head">
        <div className="page__head-main">
          <h2 className="page__title">{title}</h2>
          <p className="page__summary">{summary}</p>
        </div>
        <div className="page__head-side">
          {phase ? <Badge tone="neutral">{phase}</Badge> : null}
          <Badge tone="planned">待接入</Badge>
        </div>
      </header>

      <Notice tone="info" title="该功能待接入">
        当前是 P0 骨架阶段，这个页面只有入口，没有业务功能。骨架本身（导航、存储、备份、设置）
        已经可用，可以先去「设置」看看学习库。
      </Notice>

      {items && items.length > 0 ? (
        <section className="card">
          <div className="card__head">
            <div>
              <div className="card__title">计划书里这一步要做的事</div>
              <div className="card__subtitle">
                来自 PLAN.md {phase} 节，勾选状态在实现并验收后才会更新
              </div>
            </div>
          </div>
          <div className="card__body">
            <ol className="page__items">
              {items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          </div>
        </section>
      ) : null}

      {footer}
    </div>
  );
}

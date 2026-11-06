import { useEffect, useState, type ReactNode } from 'react';
import { MAIN_PAGES, FOOT_PAGES, pageById, type PageId } from './pages.ts';

/**
 * 应用外壳：侧栏 + 顶栏 + 内容区。
 *
 * 布局与尺寸直接按 StudyHub 4.4.3 的 shell.css 复原：
 * 侧栏 244px 固定、顶栏 51px sticky、内容区 1200px 居中。
 *
 * ## 窄屏的处理
 *
 * ≤560px 时侧栏变抽屉，而不是收缩成图标条。
 * 图标条在 420px 下只能挤出 60px 宽度，还得让用户记图标含义 ——
 * 抽屉把整个宽度还给内容，代价只是点一次汉堡。
 */

export interface AppShellProps {
  current: PageId;
  onNavigate: (id: PageId) => void;
  /** 侧栏每项的计数徽章（比如「复习 12」） */
  counts?: Partial<Record<PageId, number>>;
  children: ReactNode;
}

export function AppShell({ current, onNavigate, counts, children }: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const page = pageById(current);

  // 切换页面时自动收起抽屉，否则窄屏下会挡住内容
  useEffect(() => {
    setDrawerOpen(false);
  }, [current]);

  // Esc 关抽屉
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  return (
    <div className="app">
      {drawerOpen ? (
        <button
          type="button"
          className="scrim"
          aria-label="关闭菜单"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}

      <aside className={`sidebar${drawerOpen ? ' sidebar--open' : ''}`} aria-label="主导航">
        <div className="brand">
          <div className="brand__mark" aria-hidden="true" />
          <div className="brand__text">
            <div className="brand__name">OpenLeaner</div>
            <div className="brand__tag">每道题都点得回原页</div>
          </div>
        </div>

        <nav className="side-nav">
          {MAIN_PAGES.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`nav-item${current === p.id ? ' nav-item--on' : ''}`}
              onClick={() => onNavigate(p.id)}
              // purpose 放进 title：这是「这一页解决什么问题」的最短说明
              title={p.purpose}
              aria-current={current === p.id ? 'page' : undefined}
            >
              <span className="nav-item__icon" aria-hidden="true">
                {p.glyph}
              </span>
              <span className="nav-item__label">{p.label}</span>
              {counts?.[p.id] ? (
                <span className="nav-item__count">{counts[p.id]}</span>
              ) : null}
            </button>
          ))}
        </nav>

        <div className="sidebar__foot">
          {FOOT_PAGES.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`nav-item${current === p.id ? ' nav-item--on' : ''}`}
              onClick={() => onNavigate(p.id)}
              title={p.purpose}
            >
              <span className="nav-item__icon" aria-hidden="true">
                {p.glyph}
              </span>
              <span className="nav-item__label">{p.label}</span>
            </button>
          ))}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label="打开菜单"
            aria-expanded={drawerOpen}
          >
            ☰
          </button>
          <span className="topbar__crumb">OpenLeaner ›</span>
          <span className="topbar__title">{page.title}</span>
          <span className="topbar__spacer" />
        </header>

        <div className="page">{children}</div>
      </main>
    </div>
  );
}

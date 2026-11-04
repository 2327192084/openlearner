import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { allPages, navPages, findPage } from '@/core/registry.ts';
import { useServices } from '@/app/services-context.ts';
import { Badge } from '@/components/states.tsx';
import './shell.css';

/**
 * 应用外壳：左侧导航 + 主内容区。
 *
 * 导航条目**完全由注册表推导**（P0 验收：加一个假页面也能立刻工作）。
 * 这里没有写死任何页面名或路径。
 */
export function AppShell() {
  const pages = navPages();
  const { env } = useServices();
  const location = useLocation();

  // 从当前路径解析页面标题，供顶栏显示；解析不到就用应用名兜底
  const currentId = location.pathname.replace(/^\//, '').split('/')[0] ?? '';
  const current = currentId ? findPage(currentId) : undefined;

  return (
    <div className="shell">
      <aside className="shell__nav" aria-label="主导航">
        <div className="shell__brand">
          <span className="shell__brand-mark" aria-hidden="true">
            OL
          </span>
          <span className="shell__brand-text">
            <strong>OpenLeaner</strong>
            <small>学习备考</small>
          </span>
        </div>

        <nav className="shell__links">
          {pages.map((page) => (
            <NavLink
              key={page.id}
              to={`/${page.id}`}
              className={({ isActive }) =>
                `shell__link${isActive ? ' shell__link--active' : ''}`
              }
            >
              <span className="shell__link-title">{page.title}</span>
              {page.status === 'planned' ? (
                <span className="shell__link-dot" title="待接入" aria-label="待接入" />
              ) : null}
            </NavLink>
          ))}
        </nav>

        <div className="shell__nav-foot">
          <span>{env === 'desktop' ? '桌面端' : env === 'web' ? '浏览器' : '测试环境'}</span>
          <span className="shell__nav-foot-version">v0.0.0 · P0</span>
        </div>
      </aside>

      <div className="shell__main">
        <header className="shell__topbar">
          <div className="shell__topbar-left">
            <h1 className="shell__page-title">{current?.title ?? 'OpenLeaner'}</h1>
            {current?.phase ? <Badge tone="neutral">{current.phase}</Badge> : null}
            {current?.status === 'planned' ? <Badge tone="planned">待接入</Badge> : null}
          </div>
          <div className="shell__topbar-right">
            <span className="shell__count">{allPages().length} 个页面已注册</span>
          </div>
        </header>

        <main className="shell__content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

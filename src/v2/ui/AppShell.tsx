import { useEffect, useState, type ReactNode } from 'react';
import {
  GROUPS,
  pagesInGroup,
  pageById,
  SETTINGS_ITEM,
  TRASH_ITEM,
  FOOT_ITEMS,
  type PageId,
  type NavGroup,
} from './pages.ts';
import { IconChevron, IconDot, IconMail } from './icons.tsx';

/**
 * 应用外壳：侧栏 + 顶栏 + 内容区。
 *
 * 按你提供的真实截图还原（4 张：学习库欢迎页 / 资料 / 任务 / 学习笔记 / 创建题组）。
 *
 * ## 与先前版本的差异
 *
 * 先前我做的是「扁平 7 项 + unicode 图标」，与真实界面差得远。
 * 现在改成截图里的结构：
 *  - 顶部单行「开始学习」+ 进度 chip
 *  - 三组可折叠：每天 / 阶段性 / 课程准备与管理
 *  - 底部：语言切换（中文/EN）+ 功能导览 + 设置
 *  - 顶栏右侧：「工作库: openleaner」+「● 已连接」+ 信封图标
 */

export interface AppShellProps {
  current: PageId;
  onNavigate: (id: PageId) => void;
  counts?: Partial<Record<PageId, number>>;
  /** 复习进度，显示在「开始学习」后面，如 3/12 */
  reviewProgress?: { done: number; total: number } | null;
  /** 模型连接状态 */
  connected?: boolean;
  /** 当前工作库名 */
  libraryName?: string;
  /**
   * 回收站里「快被彻底删除」的项数（2026-11-08）。
   *
   * 显示成角标。为什么需要：用户不一定会主动点开回收站，
   * 角标是唯一能让他注意到「有东西明天就要没了」的地方。
   * 0 或不传就不显示角标。
   */
  trashBadge?: number;
  /**
   * 左上角返回（2026-11-09）。
   *
   * 需求原话：「需要一个返回按钮放在软件左上角，从错题库或是知识点
   * 跳转到资料内时，不能返回回去。频繁的跳转很麻烦，同时也不好
   * 定位原先的位置。」
   *
   * `canGoBack` 为假时不渲染 —— 不做点了没反应的箭头。
   */
  onBack?: () => void;
  canGoBack?: boolean;
  /** 返回目标页名，用于 title（如「返回错题与待巩固」） */
  backToLabel?: string | null;
  children: ReactNode;
}

export function AppShell({
  current,
  onNavigate,
  counts,
  reviewProgress,
  connected = false,
  libraryName = 'openleaner',
  trashBadge = 0,
  onBack,
  canGoBack = false,
  backToLabel,
  children,
}: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  /**
   * 分组折叠状态。
   *
   * 默认「每天」展开，其余收起 —— 照截图：
   * 截图里「阶段性」「课程准备与管理」都是收起状态（显示 chevron 指向右），
   * 只有「每天」展开列出 8 项。
   */
  const [open, setOpen] = useState<Record<NavGroup, boolean>>({
    daily: true,
    staged: false,
    prep: false,
  });

  const page = pageById(current);

  useEffect(() => {
    setDrawerOpen(false);
  }, [current]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const toggle = (g: NavGroup) => setOpen((s) => ({ ...s, [g]: !s[g] }));

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
        {/* 品牌 */}
        <div className="brand">
          <div className="brand__mark" aria-hidden="true">
            <BrandGlyph />
          </div>
          <div className="brand__text">
            <div className="brand__name">OpenLeaner</div>
            <div className="brand__tag">每道题都点得回原页</div>
          </div>
        </div>

        {/* 开始学习（顶部单行） */}
        <button
          type="button"
          className={`nav-item nav-item--back${
            current === 'study' || current === 'review' ? ' nav-item--on' : ''
          }`}
          onClick={() => onNavigate('study')}
          title="选一件事开始：学知识、做题、复习或刷错题"
        >
          <span className="nav-item__icon" aria-hidden="true">
            <BackGlyph />
          </span>
          <span className="nav-item__label">开始学习</span>
          {reviewProgress ? (
            <span className="nav-item__chip">
              {reviewProgress.done}/{reviewProgress.total}
            </span>
          ) : null}
        </button>

        <nav className="side-nav">
          {GROUPS.map((g) => {
            const items = pagesInGroup(g.id);
            if (items.length === 0) return null;
            const isOpen = open[g.id];

            return (
              <div key={g.id} className="nav-section">
                {/* 分组标题可点折叠 */}
                <button
                  type="button"
                  className="nav-group"
                  onClick={() => toggle(g.id)}
                  aria-expanded={isOpen}
                >
                  <span className="nav-group__label">{g.label}</span>
                  <span
                    className={`nav-group__chev${isOpen ? ' nav-group__chev--open' : ''}`}
                    aria-hidden="true"
                  >
                    <IconChevron size={14} />
                  </span>
                </button>

                {isOpen ? (
                  <div className="nav-items">
                    {items.map((p) => {
                      const Icon = p.icon;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          className={`nav-item${current === p.id ? ' nav-item--on' : ''}`}
                          onClick={() => onNavigate(p.id)}
                          title={p.purpose}
                          aria-current={current === p.id ? 'page' : undefined}
                        >
                          <span className="nav-item__icon" aria-hidden="true">
                            <Icon size={18} />
                          </span>
                          <span className="nav-item__label">{p.label}</span>
                          {/*
                            计数徽章只在有数据时显示。
                            截图里只有「资料」「待办」挂着 0，
                            那是它们的「条目数」语义（0 份资料 = 空库，有意义）；
                            其余页面没有计数概念，挂个 0 只是噪音。
                          */}
                          {counts?.[p.id] !== undefined ? (
                            <span
                              className={`nav-item__count${
                                counts[p.id] === 0 ? ' nav-item__count--zero' : ''
                              }`}
                            >
                              {counts[p.id]}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>

        {/* 底部：功能导览 + 设置 */}
        <div className="sidebar__foot">
          {FOOT_ITEMS.map((f) => {
            const Icon = f.icon;
            return (
              <button
                key={f.id}
                type="button"
                className="nav-item"
                onClick={() => onNavigate(f.id)}
                title="功能导览与快捷键"
              >
                <span className="nav-item__icon" aria-hidden="true">
                  <Icon size={18} />
                </span>
                <span className="nav-item__label">{f.label}</span>
              </button>
            );
          })}

          {/*
            回收站入口（2026-11-08）。
            放底部固定区而不是分组里：它不是日常学习流程的一环，
            而是「误删后回来找」的兜底，和设置同类。

            有快过期的东西时显示一个数字角标 —— 用户不一定会主动点进来，
            角标是唯一能提醒到他的地方（启动时的弹窗见 App.tsx）。
          */}
          <button
            type="button"
            className={`nav-item${current === TRASH_ITEM.id ? ' nav-item--on' : ''}`}
            onClick={() => onNavigate(TRASH_ITEM.id)}
            title="删掉的东西先放这里，30 天后彻底删除"
          >
            <span className="nav-item__icon" aria-hidden="true">
              <TRASH_ITEM.icon size={18} />
            </span>
            <span className="nav-item__label">{TRASH_ITEM.label}</span>
            {trashBadge > 0 ? (
              <span className="nav-item__badge" aria-label={`${trashBadge} 项即将被彻底删除`}>
                {trashBadge}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            className={`nav-item${current === SETTINGS_ITEM.id ? ' nav-item--on' : ''}`}
            onClick={() => onNavigate(SETTINGS_ITEM.id)}
            title="接入模型、选择主题、导出备份"
          >
            <span className="nav-item__icon" aria-hidden="true">
              <SETTINGS_ITEM.icon size={18} />
            </span>
            <span className="nav-item__label">{SETTINGS_ITEM.label}</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          {/*
            左上角返回（2026-11-09）。
            只在真能返回时渲染 —— 不能退时画一个灰箭头，
            用户点了没反应，比不画更糟（项目一贯的「不做假开关」）。
          */}
          {onBack && canGoBack ? (
            <button
              type="button"
              className="topbar__back"
              onClick={onBack}
              title={backToLabel ? `返回${backToLabel}` : '返回上一页'}
              aria-label={backToLabel ? `返回${backToLabel}` : '返回上一页'}
            >
              <span aria-hidden="true">←</span>
            </button>
          ) : null}
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label="打开菜单"
            aria-expanded={drawerOpen}
          >
            ☰
          </button>
          {/* 面包屑：品牌 › 页名。只用一个 ›，多一个是多余的 */}
          <span className="topbar__crumb">
            OpenLeaner <span className="topbar__crumb-sep">›</span>
          </span>
          <span className="topbar__title">{page.title}</span>

          <span className="topbar__spacer" />

          {/* 右侧状态区：工作库 + 连接状态 + 信封 */}
          <span className="topbar__lib">
            工作库：<strong>{libraryName}</strong>
          </span>
          <span
            className={`topbar__status${connected ? ' topbar__status--on' : ''}`}
            title={connected ? '模型已接入' : '还没接入模型，去设置里添加'}
          >
            <span className="topbar__dot" aria-hidden="true">
              <IconDot size={8} />
            </span>
            {connected ? '已连接' : '未连接'}
          </span>
          <button type="button" className="topbar__icon-btn" aria-label="消息">
            <IconMail size={17} />
          </button>
        </header>

        <div className="page">{children}</div>
      </main>
    </div>
  );
}

/** 品牌图标：练习本（带横线与朱砂书脊） */
function BrandGlyph() {
  return (
    <svg width={26} height={26} viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <rect
        x="5.5"
        y="3.5"
        width="15"
        height="19"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M9 3.5v19" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 9h5M12 13h5M12 17h3" stroke="currentColor" strokeWidth="1.2" opacity="0.6" />
    </svg>
  );
}

/** 返回箭头（开始学习） */
function BackGlyph() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M10 7l-5 5 5 5M5 12h14"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

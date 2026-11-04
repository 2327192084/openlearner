import type { ComponentType } from 'react';

/**
 * 页面注册表。
 *
 * P0 的验收要求：「加一个假页面也能立刻工作（证明模块是可插拔的，不是硬编码）」。
 * 做法是让**导航**和**路由**都由同一份注册表推导出来 —— 只要 register 一个模块，
 * 左侧导航条目、路由、页面标题三处同时出现，不需要去任何别的地方再改一行。
 *
 * 因此禁止在 AppShell 或 router 里写死页面名/路径。
 */

/** 页面成熟度，直接显示在界面上，避免把「待接入」冒充成「已完成」 */
export type PageStatus = 'ready' | 'planned';

export interface PageModule {
  /** 唯一标识，也用作路由 path 片段（不含前导斜杠） */
  id: string;
  /** 导航与页面标题 */
  title: string;
  /** 一句话说明这个页面将来做什么，展示在占位页上 */
  summary: string;
  /** 导航排序，小的在前 */
  order: number;
  /** 是否出现在左侧导航（详情页之类不外露的置 false） */
  inNav: boolean;
  status: PageStatus;
  /** 计划书里对应的阶段，如 'P1'，占位页用来告诉用户这块什么时候来 */
  phase?: string;
  component: ComponentType;
}

const modules = new Map<string, PageModule>();

/**
 * 注册一个页面模块。
 *
 * 重复 id 直接抛错而不是静默覆盖：静默覆盖会让「我明明注册了却看不到」
 * 变成一场排查——这类问题在多人协作时尤其费时间。
 */
export function register(page: PageModule): void {
  if (modules.has(page.id)) {
    throw new Error(`页面模块 "${page.id}" 重复注册，请检查 id 是否冲突`);
  }
  modules.set(page.id, page);
}

/** 按导航顺序取出全部页面 */
export function allPages(): PageModule[] {
  return [...modules.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

/** 只取导航可见的页面 */
export function navPages(): PageModule[] {
  return allPages().filter((p) => p.inNav);
}

export function findPage(id: string): PageModule | undefined {
  return modules.get(id);
}

/**
 * 默认落地页：第一个导航页面。
 * 不写死某个 id，这样调整 order 就能改默认页。
 */
export function defaultPageId(): string {
  const first = navPages()[0];
  if (!first) throw new Error('没有注册任何页面模块，应用无法启动');
  return first.id;
}

/** 仅供测试使用：清空注册表，避免用例之间互相污染 */
export function __resetRegistryForTests(): void {
  modules.clear();
}

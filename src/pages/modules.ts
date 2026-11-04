import { register } from '@/core/registry.ts';
import { SourcesPage } from './sources/SourcesPage.tsx';
import { KnowledgePage } from './KnowledgePage.tsx';
import { SlidesPage } from './SlidesPage.tsx';
import { DecksPage } from './DecksPage.tsx';
import { PracticePage } from './PracticePage.tsx';
import { SettingsPage } from './settings/SettingsPage.tsx';
import { DemoPage } from './DemoPage.tsx';

/**
 * 页面模块装配。
 *
 * 这里是**唯一**需要改动的地方：新增页面时加一行 import 加一次 register。
 * 导航、路由、顶栏标题都由注册表推导，不需要动 AppShell 或 router。
 *
 * 注意 order 的排序意图：按学生实际使用顺序排，而不是按开发顺序。
 * 资料 → 知识点 → 习题 → 练习 → PPT，设置永远在最后。
 */

register({
  id: 'sources',
  title: '资料库',
  summary: '导入并阅读教材、课件、讲义',
  order: 10,
  inNav: true,
  // P1 已实现：导入、按课程分组、阅读器、全文搜索、详情与删除
  status: 'ready',
  phase: 'P1',
  component: SourcesPage,
});

register({
  id: 'knowledge',
  title: '知识点',
  summary: 'AI 整理出的中间层，可校对回原文',
  order: 20,
  inNav: true,
  status: 'planned',
  phase: 'P2',
  component: KnowledgePage,
});

register({
  id: 'decks',
  title: '习题集',
  summary: '从知识点出题，每题带答案·解析·出处',
  order: 30,
  inNav: true,
  status: 'planned',
  phase: 'P3',
  component: DecksPage,
});

register({
  id: 'practice',
  title: '练习',
  summary: '作答判分、错题归集、重刷',
  order: 40,
  inNav: true,
  status: 'planned',
  phase: 'P3',
  component: PracticePage,
});

register({
  id: 'slides',
  title: '生成 PPT',
  summary: '从知识点生成可编辑的幻灯片',
  order: 50,
  inNav: true,
  status: 'planned',
  phase: 'P4',
  component: SlidesPage,
});

register({
  id: 'settings',
  title: '设置',
  summary: '学习库与 AI 后端',
  order: 90,
  inNav: true,
  // 设置页在 P0 就有真实功能（建库、备份、后端录入），不是占位页
  status: 'ready',
  phase: 'P0',
  component: SettingsPage,
});

/**
 * P0 验收用的可插拔验证页。
 * 保留在导航里，是因为评审和队友都能点开看到「加页面不用改骨架」这件事本身。
 */
register({
  id: 'demo',
  title: '可插拔验证页',
  summary: '证明新增页面不需要改动骨架',
  order: 900,
  inNav: true,
  status: 'planned',
  phase: 'P0',
  component: DemoPage,
});

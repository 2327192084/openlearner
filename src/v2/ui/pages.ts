/**
 * 导航注册表 —— 界面的唯一真源。
 *
 * 结构照搬 StudyHub 的 ui/pages.js：
 * 每一项带 label / purpose / main，
 * 侧栏、顶栏标题、快捷键全部从这里推导，不各写一份。
 *
 * `purpose` 不是装饰：它会出现在 hover 提示与「找功能」搜索里。
 * 写它的时候要回答「用户为什么要去这一页」，而不是复述标签。
 */

export type PageId =
  | 'today'
  | 'sources'
  | 'generate'
  | 'review'
  | 'wrongbook'
  | 'stats'
  | 'settings';

export interface PageDef {
  id: PageId;
  /** 侧栏显示的文字 */
  label: string;
  /** 顶栏标题 */
  title: string;
  /** 侧栏图标（单个字符，避免引入图标库） */
  glyph: string;
  /** 一句话说明这一页解决什么问题，用于提示与搜索 */
  purpose: string;
  /** 是否进主导航（false 的只出现在「更多」里） */
  main: boolean;
  /** 分组 */
  group: 'practice' | 'material' | 'system';
}

/**
 * 页面定义。
 *
 * 只有 6 项进主导航 —— 与 StudyHub 的「默认 6 项」一致。
 * 导航超过 6 项时，用户的点击分布会明显分散；
 * 剩下的一律收进「更多」或底部。
 */
export const PAGES: PageDef[] = [
  {
    id: 'today',
    label: '今日',
    title: '今日',
    glyph: '◈',
    purpose: '每次打开先看这里：今天该复习几张、可以学几张、昨天做得怎样',
    main: true,
    group: 'practice',
  },
  {
    id: 'sources',
    label: '资料',
    title: '资料',
    glyph: '▤',
    purpose: '导入讲义、课件和教材，也可以在这里读原文、做批注',
    main: true,
    group: 'material',
  },
  {
    id: 'generate',
    label: '出题',
    title: '创建题组',
    glyph: '✦',
    purpose: '选好资料出题；出之前能看到大概要花多少',
    main: true,
    group: 'material',
  },
  {
    id: 'review',
    label: '复习',
    title: '复习',
    glyph: '▷',
    purpose: '按遗忘曲线做今天该复习的卡片，做完能看见自己变熟',
    main: true,
    group: 'practice',
  },
  {
    id: 'wrongbook',
    label: '错题',
    title: '错题与待巩固',
    glyph: '⚑',
    purpose: '答错的题和还没巩固的题收在这里，可以只练它们',
    main: true,
    group: 'practice',
  },
  {
    id: 'stats',
    label: '统计',
    title: '学习统计',
    glyph: '▦',
    purpose: '练了多少、掌握得怎么样、哪一块还薄弱',
    main: true,
    group: 'practice',
  },
  {
    id: 'settings',
    label: '设置',
    title: '设置',
    glyph: '⚙',
    purpose: '接入模型、选择主题、导出备份',
    main: false,
    group: 'system',
  },
];

/** 主导航（侧栏上半部分） */
export const MAIN_PAGES = PAGES.filter((p) => p.main);

/** 底部固定项 */
export const FOOT_PAGES = PAGES.filter((p) => !p.main);

/** 按 id 取定义 */
export function pageById(id: PageId): PageDef {
  const p = PAGES.find((x) => x.id === id);
  if (!p) throw new Error(`未知页面：${id}`);
  return p;
}

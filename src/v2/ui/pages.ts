import type { ReactElement } from 'react';
import {
  IconBack,
  IconBoard,
  IconBook,
  IconAudio,
  IconExam,
  IconFlow,
  IconGenerate,
  IconHelp,
  IconLibrary,
  IconNotes,
  IconRecord,
  IconSettings,
  IconSkeleton,
  IconSources,
  IconStats,
  IconTarget,
  IconTasks,
  IconWrongbook,
} from './icons.tsx';

/**
 * 导航注册表 —— 界面的唯一真源。
 *
 * 按你给的真实截图还原：
 *  - 顶部单行「回到题目」（带进度 chip）
 *  - 三组可折叠：每天 / 阶段性 / 课程准备与管理
 *  - 底部固定：功能导览、设置
 *
 * 组的顺序与命名照截图，不自创。
 * 语言切换（中文/EN）已移除：EN 从来没有实现过，只放一个点了没反应的按钮
 * 比没有更糟。
 */

export type PageId =
  | 'today'
  | 'review'
  | 'study'
  | 'knowledge'
  | 'sources'
  | 'generate'
  | 'decks'
  | 'tasks'
  | 'wrongbook'
  | 'flow'
  | 'notes'
  | 'board'
  | 'exam'
  | 'examprep'
  | 'book'
  | 'stats'
  | 'skeleton'
  | 'audio'
  | 'record'
  | 'organize'
  | 'reader'
  | 'guide'
  | 'practice'
  | 'settings';

export type NavGroup = 'daily' | 'staged' | 'prep';

export interface PageDef {
  id: PageId;
  label: string;
  title: string;
  icon: (p: { size?: number }) => ReactElement;
  /** 一句话说明这一页解决什么问题 */
  purpose: string;
  group: NavGroup;
  /** 是否进主导航（false 的暂不显示，或只在占位里出现） */
  show: boolean;
  /** 是否已实现（未实现的点了给占位说明） */
  ready?: boolean;
}

export const PAGES: PageDef[] = [
  // ---------- 每天 ----------
  {
    id: 'today',
    label: '学习库',
    title: '学习库',
    icon: IconLibrary,
    purpose: '每次打开先看这里：今天的安排、各门课的进度和最近在练的题',
    group: 'daily',
    show: true,
    ready: true,
  },
  {
    id: 'sources',
    label: '资料',
    title: '资料',
    icon: IconSources,
    purpose: '导入讲义、课件和笔记，也可以在这里读原文',
    group: 'daily',
    show: true,
    ready: true,
  },
  {
    /*
     * 「创建题组」不再是独立入口 —— 用户要求把它和「我的题组」
     * 整合成一页。出题表单内嵌在 DecksPage 里，点「新建题组」就地展开。
     * show: false 让它从侧栏消失，PageId 保留以兼容旧状态。
     */
    id: 'generate',
    label: '创建题组',
    title: '创建题组',
    icon: IconGenerate,
    purpose: '选好资料出题；出之前能看到大概要花多少',
    group: 'daily',
    show: false,
  },
  /**
   * 知识库 —— 按来源文件归类全部知识点。
   *
   * 用户要求：「做个知识库界面，将不同文件产生的知识点放进去，
   * 然后把文件对应的知识点归属到那个文件名下」。
   */
  {
    id: 'knowledge',
    label: '知识库',
    title: '知识库',
    icon: IconBook,
    purpose: '按资料文件归类看所有整理出来的知识点',
    group: 'daily',
    show: true,
    ready: true,
  },
  {
    /*
     * 「我的题组」—— 用户出完题找不到题的根因就是缺这一页。
     * 生成后给的那句「可以去复习里做了」在当时是空话：
     * 复习只显示卡片正反面，看不到题单，也看不到题组。
     */
    id: 'decks',
    label: '我的题组',
    title: '我的题组',
    icon: IconGenerate,
    purpose: '查看生成过的题组，检查草稿并发布',
    group: 'daily',
    show: true,
    ready: true,
  },
  {
    id: 'tasks',
    label: '任务',
    title: '任务',
    icon: IconTasks,
    purpose: '整理与出题的每一次运行：成没成、产出多少、花了多少',
    group: 'daily',
    show: true,
    ready: true,
  },
  {
    id: 'wrongbook',
    label: '错题与待巩固',
    title: '错题与待巩固',
    icon: IconWrongbook,
    purpose: '答错的题收在这里：看错几次、错在哪天，也能直接去练',
    group: 'daily',
    show: true,
    ready: true,
  },
  {
    id: 'flow',
    label: '学习流',
    title: '学习流',
    icon: IconFlow,
    purpose: '按每份资料看走到哪一步、下一步该做什么',
    group: 'daily',
    show: true,
    ready: true,
  },
  {
    id: 'notes',
    label: '学习笔记',
    title: '学习笔记',
    icon: IconNotes,
    purpose: '挂在题、知识点或资料上的笔记，能搜能改',
    group: 'daily',
    show: true,
    ready: true,
  },
  {
    id: 'board',
    label: '待办',
    title: '待办',
    icon: IconBoard,
    purpose: '记下这周要做什么，可设截止日；逾期会单独标出',
    group: 'daily',
    show: true,
    ready: true,
  },

  // ---------- 阶段性 ----------
  {
    id: 'exam',
    label: '模拟考试',
    title: '模拟考试',
    icon: IconExam,
    purpose: '限时整卷，交卷后统一批改，成绩单独记录',
    group: 'staged',
    show: true,
    ready: true,
  },
  {
    id: 'examprep',
    label: '备考补习',
    title: '备考补习',
    icon: IconTarget,
    /*
     * 从侧栏摘掉。
     *
     * 这一页需要「考试大纲」作为输入：知道要考哪些点，才能算「缺什么补什么」。
     * 项目里目前没有任何导入考纲的入口，也没有考纲的数据结构 ——
     * 做出来只会是一个让人填不出东西的空壳。
     *
     * 按项目一贯的规矩：不摆点了没反应的入口。
     * 等真的要做了（并确定考纲从哪来），再把 show 打开。
     */
    purpose: '按考试大纲整理要复习的清单（需要先支持导入考纲，暂未做）',
    group: 'staged',
    show: false,
  },
  {
    id: 'book',
    label: '复习全书',
    title: '复习全书',
    icon: IconBook,
    purpose: '把已发布的题按资料聚成一册，可整本导出 Markdown',
    group: 'staged',
    show: true,
    ready: true,
  },
  {
    id: 'stats',
    label: '统计',
    title: '学习统计',
    icon: IconStats,
    purpose: '练了多少、掌握得怎么样、哪一块还薄弱',
    group: 'staged',
    show: true,
    ready: true,
  },

  // ---------- 课程准备与管理 ----------
  {
    id: 'skeleton',
    label: '知识骨架',
    title: '知识骨架',
    icon: IconSkeleton,
    purpose: '按资料与章节摊开知识点，看清层级分布与薄弱处',
    group: 'prep',
    show: true,
    ready: true,
  },
  {
    id: 'audio',
    label: '音频转写',
    title: '音频转写',
    icon: IconAudio,
    /*
     * 从侧栏摘掉：需要接一个语音转写引擎（Whisper / 云端 API 等），
     * 选哪个是产品决策，得由用户定。在那之前做不了，也就没有入口。
     */
    purpose: '把课堂录音转成文字（需要先定用哪个转写引擎，暂未做）',
    group: 'prep',
    show: false,
  },
  {
    id: 'record',
    label: '课堂实录',
    title: '课堂实录',
    icon: IconRecord,
    /*
     * 从侧栏摘掉：它依赖音频转写（先录下来再转文字），
     * 而转写引擎还没定。链路上游没有，下游就不能摆出来。
     */
    purpose: '边上课边记，课后自动整理（依赖音频转写，暂未做）',
    group: 'prep',
    show: false,
  },
];

/** 分组定义（顺序照截图） */
export const GROUPS: { id: NavGroup; label: string }[] = [
  { id: 'daily', label: '每天' },
  { id: 'staged', label: '阶段性' },
  { id: 'prep', label: '课程准备与管理' },
];

/** 底部固定项 */
export const FOOT_ITEMS: { id: PageId; label: string; icon: (p: { size?: number }) => ReactElement }[] = [
  // 「功能导览」有自己的 id，不再借用 settings —— 之前点它其实是跳去设置页，
  // 名不副实。真正的导览页还没做，进去会看到明确的占位说明。
  { id: 'guide', label: '功能导览', icon: IconHelp },
];

export const SETTINGS_ITEM = { id: 'settings' as PageId, label: '设置', icon: IconSettings };
export const BACK_ICON = IconBack;

/**
 * 不在导航列表里、但仍需要有标题与图标的页面。
 *
 * review 由「回到题目」进入，不出现在分组导航里；
 * settings 在底部固定区。两者都要能被 pageById 找到，
 * 否则顶栏标题会回退成错的页名（曾经显示成「设置」）。
 */
const OFF_NAV: Partial<Record<PageId, PageDef>> = {
  /**
   * 「开始学习」导览页。
   *
   * 点顶部按钮先到这里，四个选项自己挑：学习知识 / 开始做题 /
   * 开始复习 / 错题闪卡。原来直接掉进做题界面，用户没有选择权。
   */
  study: {
    id: 'study',
    label: '开始学习',
    title: '开始学习',
    icon: IconLibrary,
    purpose: '先选一件事做：学知识、做题、复习或刷错题',
    group: 'daily',
    show: false,
    ready: true,
  },
  review: {
    /*
     * 名字与「开始学习」导览里的「开始做题」对齐。
     * 原来这里叫「复习」，而导览里叫「开始做题」，用户看到顶栏写「复习」
     * 会以为进错了地方。
     */
    id: 'review',
    label: '做题',
    title: '做题',
    icon: IconLibrary,
    purpose: '选一种做法：今日该复习的、自由练习、或错题巩固',
    group: 'daily',
    show: false,
    ready: true,
  },
  /**
   * 正在做题的那一页。
   *
   * 与 review（选题页）分开：review 是「选哪种模式、练哪个题组」，
   * practice 是「正在一道一道做」。两者混在一起会导致
   * 「做完一轮回到选题页」时状态残留（上一轮的队列还在）。
   */
  practice: {
    id: 'practice',
    label: '做题中',
    title: '做题',
    icon: IconLibrary,
    purpose: '正在做这一轮的题',
    group: 'daily',
    show: false,
    ready: true,
  },
  settings: {
    id: 'settings',
    label: '设置',
    title: '设置',
    icon: IconSettings,
    purpose: '接入模型、管理学习库、导出备份',
    group: 'prep',
    show: false,
    ready: true,
  },
  guide: {
    id: 'guide',
    label: '功能导览',
    title: '功能导览',
    icon: IconHelp,
    purpose: '每一页能做什么、从哪里进、哪些还没做',
    group: 'prep',
    show: false,
    ready: true,
  },
  organize: {
    id: 'organize',
    label: '整理知识点',
    title: '整理知识点',
    icon: IconSkeleton,
    purpose: '把资料的正文整理成一条条能点回原文的知识点',
    group: 'daily',
    show: false,
    ready: true,
  },
  reader: {
    id: 'reader',
    label: '阅读原文',
    title: '阅读原文',
    icon: IconSources,
    purpose: '看资料的正文，并把知识点定位到具体那一句',
    group: 'daily',
    show: false,
    ready: true,
  },
};

export function pageById(id: PageId): PageDef {
  const p = PAGES.find((x) => x.id === id) ?? OFF_NAV[id];
  if (p) return p;
  return {
    id,
    label: String(id),
    title: String(id),
    icon: IconSettings,
    purpose: '',
    group: 'prep',
    show: false,
  };
}

export function pagesInGroup(group: NavGroup): PageDef[] {
  return PAGES.filter((p) => p.group === group && p.show);
}

/**
 * 首页各行的「点进去」目标（2026-11-13 深夜，用户要求）。
 *
 * ## 用户原话
 *
 * > 「建议：点击界面上的题组、错题或是资料能直接跳转到对应的题组、
 * >  错题或是资料页面，不用再到对于功能栏打开」
 *
 * 也就是说：首页那四块（题组进度 / 资料阅读 / 最近在练的题组 / 错题）
 * 里**每一行**都该能直接点到它对应的那一件事，而不是：
 *  - 只能点右上角的「学习地图 →」「资料库 →」进到那一页的顶部，再自己找
 *  - 或者更糟：点了没反应（原来「题组进度」与「资料阅读」的行是纯 div）
 *
 * ## 为什么需要这个模块
 *
 * 「点了去哪」不是随便挑一个页面就行，四块的内容物根本不是同一种东西：
 *
 * | 块 | 一行代表 | 该去哪 | 为什么不是别处 |
 * |---|---|---|---|
 * | 题组进度 | **一份资料的题目掌握度**（`MapSource.sourceId`） | 学习地图并展开那份资料 | 它统计的是题目，不是阅读；去「资料库」会让人以为要看正文 |
 * | 资料阅读 | **一份资料的阅读位置**（`Source.readProgress`） | **直接打开这份资料的阅读器** | 用户想看的就是「我读到哪了」，中间再插一页等于少一次点击就没做到 |
 * | 最近在练的题组 | 一个题组 | 我的题组并展开该组 | 与 2026-11-09 的既有行为一致 |
 * | 错题 | **一道具体的题** | 错题页并定位到那一题 | 原来五行都跳同一页顶部，用户看不出自己点的是哪道 |
 *
 * 所以把「行类型 → 目标」抽成纯函数，四块共用一处判断，
 * 并有单测钉住 —— 否则四块各写一遍，改一块忘三块是这个项目的常见病。
 *
 * ## 这一层不负责渲染
 *
 * 它只回答「该叫什么回调、带什么参数」，具体怎么跳由 App 决定
 * （App 才知道 openReader / goPage 怎么调）。
 */

import type { PageId } from './pages.ts';

/** 首页某一行的类型 */
export type HomeRowKind = 'study-progress' | 'read-progress' | 'deck' | 'wrong-card';

/** 点了这一行之后要去做什么 */
export type HomeRowAction =
  /** 打开某份资料的阅读器（可带页码） */
  | { kind: 'open-source'; sourceId: string; page?: number }
  /** 去学习地图，并展开/滚动到这份资料 */
  | { kind: 'focus-map'; sourceId: string }
  /** 去我的题组，并展开这个题组 */
  | { kind: 'focus-deck'; deckId: string }
  /** 去错题页，并定位到这张卡 */
  | { kind: 'focus-wrong'; cardId: string };

/**
 * 某一行的目标。
 *
 * 注意这里**故意不返回 null**：四块里的每一行都必须有个去处。
 * 若哪天出现「这一行点不了」，那是上面的映射表缺了一项，
 * 应该在这里就编译报错，而不是运行时静默什么都不做
 * （那正是用户抱怨的「点了没反应」）。
 *
 * 只写一个签名、按 kind 收窄返回值 —— 一开始用了四条重载，
 * 在单测里用联合类型调用时 TypeScript 会挑最后一条重载而报错。
 * 一个签名反而更稳，也不损失任何类型信息（返回的联合类型里有 kind 判别）。
 */
export function homeRowAction(
  kind: HomeRowKind,
  id: string,
  opts?: { page?: number },
): HomeRowAction {
  switch (kind) {
    case 'study-progress':
      /*
       * 「题组进度」统计的是题目掌握度，所以去**学习地图**。
       *
       * 不去资料库：那一页是文件管理，看不到掌握度；
       * 也不去阅读器：用户点的不是「我要读正文」，
       * 而是「这组题我练得怎么样」。
       */
      return { kind: 'focus-map', sourceId: id };

    case 'read-progress':
      /*
       * 「资料阅读」直接开阅读器 —— 用户想看的就是读到哪了。
       *
       * 带 page 时定位到那一页：首页写着「到过第 10/36 页」，
       * 点进去却停在第 1 页会显得那个数字是假的。
       * 不带 page 时由阅读器按 `readProgress` 自己恢复
       * （那是 2026-11-13 下午做的跨会话记忆）。
       */
      return opts?.page !== undefined
        ? { kind: 'open-source', sourceId: id, page: opts.page }
        : { kind: 'open-source', sourceId: id };

    case 'deck':
      return { kind: 'focus-deck', deckId: id };

    case 'wrong-card':
      return { kind: 'focus-wrong', cardId: id };
  }
}

/**
 * 这一行跳过去之后，目标页上应该高亮/展开谁。
 *
 * 抽出来的原因：App 要把「要去哪」翻译成各页面自己的入参
 * （MapPage 用 sourceId 展开、WrongBookPage 用 cardId 定位），
 * 而「哪些页需要这种提示」本身也是判断，写在一处免得漏。
 */
export function targetPageOf(action: HomeRowAction): PageId {
  switch (action.kind) {
    case 'open-source':
      return 'reader';
    case 'focus-map':
      return 'flow';
    case 'focus-deck':
      return 'decks';
    case 'focus-wrong':
      return 'wrongbook';
  }
}

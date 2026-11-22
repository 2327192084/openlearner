/**
 * 「选取会话」的纯逻辑（2026-11-23，用户待办第 1 项）。
 *
 * ## 用户原话（2026-11-22 23:19）
 *
 * > 这个选闪卡的界面每个闪卡的边界都不明显，
 * > 我觉得这两个选取都改为跳转到对应的功能界面进行选取好一点。
 *
 * 所以小节详情的绑定面板不再内嵌搜索列表：点「+ 加闪卡」跳到闪卡管理页，
 * 在那一页的大卡片上点「选这个」，绑上后回地图。题组同理跳「我的题组」。
 *
 * ## 为什么要一个独立模块
 *
 * 跳转选取要跨三处协作（App 的会话状态、功能页的选取模式、回来后写回哪棵树
 * 的哪一节）。状态本身在 App 的 useState 里，但**合并规则**与**页码映射**
 * 是纯逻辑 —— 放在这里才能单测（项目惯例：UI 不碰存储，逻辑不碰 DOM）。
 *
 * ## 会话形状（照 App 里 `pickingFor` 枚举的先例，不用两个布尔）
 *
 * 两个布尔会出现「同时在挑闪卡又在挑题组」的非法状态，行为取决于判断顺序。
 * 一个可空对象表达不出来那种状态。`token` 学 `incomingAiCards`：
 * 同一小节连续两次发起跳转，token 不同，目标页的 effect 才会重新接住。
 *
 * ## 选取语义：点一下即绑、留在页里继续挑
 *
 * 绑定面板原来的语义就是「点一个加一个、即时写回」。跳转版保持这个语义：
 * 「选这个」点了就绑上（写回树 + saveTree），横幅如实显示已绑数，
 * 用户挑够了点「返回地图」。不做勾选-确认两步：那是另一种交互，
 * 而且即时写回没有"草稿丢了"的问题 —— 每一次点击都是完成态。
 */

/** 去哪一页挑 */
export type PickTarget = 'flashcards' | 'decks';

/**
 * 一次选取会话。
 *
 * ⚠️ 存的是 **id + 标题文本**，不存小节对象引用 ——
 * 跳回来时树可能已被重渲染（甚至重规划过），按 id 找，找不到就丢弃结果
 * 并如实提示（照 StudyHub 带回 id 不带回对象的做法）。
 */
export interface PickSession {
  kind: PickTarget;
  /** 地图所属资料 id（写回哪棵树） */
  sourceId: string;
  /** 挑给哪一小节（写回哪一节的 tasks） */
  sectionId: string;
  /** 小节标题（横幅文案用；跳过去后树可能变了，仅展示用） */
  sectionTitle: string;
  /** 章标题（横幅用） */
  chapterTitle: string;
  /** 重复跳转也能重新触发目标页的接住逻辑 */
  token: number;
}

/** 会话 → 跳到哪一页（映射只写一次，别在各调用处各写各的） */
export function pickTargetPage(kind: PickTarget): 'flashcards' | 'decks' {
  return kind === 'flashcards' ? 'flashcards' : 'decks';
}

/**
 * 把新选的 id 并进已绑列表：已有的不动（保持原顺序），新的追加，去重。
 *
 * 去重是**必须**的：用户可以来回点同一张卡；没有它，重复绑定会
 * 让「这一节有几张卡」虚高 —— 那正是 11-22「0/26 与 0/78」那类
 * 重复计数错误的形状。
 */
export function mergePicks(
  current: readonly string[],
  added: readonly string[],
): string[] {
  const out = [...current];
  const seen = new Set(out);
  for (const a of added) {
    if (!seen.has(a)) {
      out.push(a);
      seen.add(a);
    }
  }
  return out;
}

/** 横幅上的一句话（纯函数，测试钉住措辞里的数字关系） */
export function pickBannerText(session: PickSession, boundCount: number): string {
  const what = session.kind === 'flashcards' ? '闪卡' : '题组';
  return (
    `正在为「${session.chapterTitle} · ${session.sectionTitle}」选${what}` +
    ` —— 点条目上的「选这个」即时绑上。已绑 ${boundCount} 个。`
  );
}

/**
 * 把一次「选这个」并进地图 —— 过期检查与合并在同一个纯函数里。
 *
 * ## 为什么返回整棵新树而不是布尔/局部数据（2026-11-23 自查改的）
 *
 * 第一版有个 `isSessionStale(布尔)`，结果 App 里为了拿当前绑定又自己
 * 遍历了一遍 —— 那个函数**只有测试在用、界面根本没调**，
 * 是硬约束 11 的"做了没接上"。改成查找+合并一体：App 调这一次就够，
 * "小节还在不在"与"并进哪个列表"不可能漂移成两套判断。
 *
 * ## 过期语义
 *
 * 小节可能在跳走期间被重规划掉。返回 `stale` 时 App 必须**丢弃这次
 * 点击并如实提示**，不许静默写进别的节。写回目标永远是**会话自带的
 * sourceId**（不是"当前打开的地图"）—— 会话期间用户理论上能切图，
 * 写到发起那张才诚实。
 */
export interface PickTreeSection {
  id: string;
  tasks: {
    boundFlashcardIds?: readonly string[];
    boundDeckIds?: readonly string[];
  };
}

/**
 * ⚠️ 泛型收**整棵树**的形状（sections 是数组、元素保留全部字段）——
 * 之前约束写成 `readonly { sections: readonly PickTreeSection[] }[]`，
 * `{ ...ch }` 展开后只剩约束里声明的键，title/segmentIds 会被 TS 抹掉。
 */
export interface PickTreeShape<S extends PickTreeSection = PickTreeSection> {
  chapters: readonly { sections: S[] }[];
}

export type ApplyPickResult<T> =
  | { ok: true; tree: T }
  | { ok: false; reason: 'no-tree' | 'no-section' };

export function applyPickToTree<T extends PickTreeShape>(
  session: PickSession,
  tree: T | undefined,
  id: string,
): ApplyPickResult<T> {
  if (!tree) return { ok: false, reason: 'no-tree' };

  let found: PickTreeSection | null = null;
  for (const ch of tree.chapters) {
    const sec = ch.sections.find((x) => x.id === session.sectionId);
    if (sec) {
      found = sec;
      break;
    }
  }
  if (!found) return { ok: false, reason: 'no-section' };

  const currentCards = found.tasks.boundFlashcardIds ?? [];
  const currentDecks = found.tasks.boundDeckIds ?? [];
  const nextCards = session.kind === 'flashcards' ? mergePicks(currentCards, [id]) : currentCards;
  const nextDecks = session.kind === 'decks' ? mergePicks(currentDecks, [id]) : currentDecks;

  const chapters = tree.chapters.map((ch) => ({
    ...ch,
    sections: ch.sections.map((x) =>
      x.id === session.sectionId
        ? {
            ...x,
            tasks: { ...x.tasks, boundFlashcardIds: nextCards, boundDeckIds: nextDecks },
          }
        : x,
    ),
  }));
  return { ok: true, tree: { ...tree, chapters } as T };
}

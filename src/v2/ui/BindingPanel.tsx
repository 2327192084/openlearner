/**
 * 闪卡/题组的手工绑定面板（2026-11-22；2026-11-23 选取改跳转）。
 *
 * ## 用户的原话
 *
 * > 这个绑定资源功能主要是自动的，可以调用后端 ai 自主审查已有资源进行绑定，
 * > 但要留个给用户手工绑定的入口
 *
 * 自动绑定在建图时跑（`autoBindTree`，逐章调用模型）。这个组件是**手工入口**：
 * 用户看到 AI 绑得不对，或者 AI 漏了，能自己改。
 *
 * ## 2026-11-23：「+ 加」从内嵌搜索列表改成跳转选取（用户待办第 1 项）
 *
 * 用户原话（2026-11-22 23:19）：
 * > 这个选闪卡的界面每个闪卡的边界都不明显，
 * > 我觉得这两个选取都改为跳转到对应的功能界面进行选取好一点。
 *
 * 原来这里内嵌一个搜索列表（`.bindp__picker`），卡片挤在小面板里边界不清。
 * 现在点「+ 加闪卡」→ 跳闪卡管理页（卡片大、信息全、本来就能搜），
 * 点条目上的「选这个」即时绑上，「返回地图」回来。题组同理跳「我的题组」。
 * 会话状态与合并规则在 `pick-context.ts`（纯逻辑，有单测）。
 *
 * ## 为什么已绑列表留在这里
 *
 * 用户改绑定时的第一动作是**看现在绑了啥、解除错的**。
 * 解除不需要跳页，就地 ✕ 最快。跳转只用于"从库里挑新的"。
 */

import { useState } from 'react';

export interface BindingPanelProps {
  /** 已绑的闪卡 id */
  cardIds: readonly string[];
  /** 已绑的题组 id */
  deckIds: readonly string[];
  /** 库里全部可选闪卡（只为把已绑 id 映射成可读文本；找不到的如实说被删了） */
  availableCards: readonly { id: string; front: string }[];
  /** 库里全部可选题组 */
  availableDecks: readonly { id: string; title: string; questionCount: number }[];
  onChange: (next: { cardIds: string[]; deckIds: string[] }) => void;
  /** 让 AI 帮我挑（可选） */
  onAskAi?: () => void;
  aiBusy?: boolean;
  /**
   * 用这一节的正文**生成**几张闪卡（2026-11-22 加）。
   *
   * 只在**这一节**没绑卡时显示。用户库实测闪卡 0 张 —— 那时面板只能
   * 显示"库里还没有闪卡"，等于告诉他一个没有出口的事实。
   */
  onGenerateCards?: () => void;
  generateBusy?: boolean;
  /**
   * 跳去闪卡管理页挑（2026-11-23）。不给就退回显示提示文案 ——
   * 不做点了没反应的假按钮（硬约束 11）。
   */
  onPickCards?: () => void;
  /** 跳去我的题组页挑（2026-11-23） */
  onPickDecks?: () => void;
}

export function BindingPanel(props: BindingPanelProps) {
  const {
    cardIds,
    deckIds,
    availableCards,
    availableDecks,
    onChange,
    onAskAi,
    aiBusy,
    onGenerateCards,
    generateBusy,
    onPickCards,
    onPickDecks,
  } = props;

  /**
   * 两块的展开/收起（2026-11-22 用户要求加倒三角形）。
   *
   * ## 为什么两块各自独立折叠，而不是一个总开关
   *
   * 用户可能只想看闪卡（题库那半他清楚），不想让题组那块占位置。
   * 一个总开关做不到这件事。
   *
   * ## 默认展开
   *
   * 折叠是为了"看完想收起来"，不是为了藏起来。
   * 默认收起会让用户以为这里没内容（尤其闪卡为 0 时）。
   */
  const [open, setOpen] = useState<{ cards: boolean; decks: boolean }>({
    cards: true,
    decks: true,
  });

  /* 已绑的闪卡/题组，映射成可显示的形状（找不到的说明被删了） */
  const cardById = new Map(availableCards.map((c) => [c.id, c]));
  const deckById = new Map(availableDecks.map((d) => [d.id, d]));

  const boundCards = cardIds.map((id) => ({ id, card: cardById.get(id) ?? null }));
  const boundDecks = deckIds.map((id) => ({ id, deck: deckById.get(id) ?? null }));

  const removeCard = (id: string) =>
    onChange({ cardIds: cardIds.filter((x) => x !== id), deckIds: [...deckIds] });
  const removeDeck = (id: string) =>
    onChange({ cardIds: [...cardIds], deckIds: deckIds.filter((x) => x !== id) });

  const nothingAvailable = availableCards.length === 0 && availableDecks.length === 0;

  return (
    <div className="bindp">
      {nothingAvailable ? (
        <p className="bindp__empty">
          库里还没有闪卡和题组。先去「知识库」把知识点做成闪卡，或在「我的题组」里出新题 ——
          做好之后回到这里就能绑上了。
        </p>
      ) : null}

      {/* ==================== 闪卡 ==================== */}
      <div className="bindp__sec">
        <div className="bindp__head">
          {/*
            * 标题本身就是折叠按钮（用户要求加倒三角形）。
            *
            * 用 button 而不是 span + 独立按钮：整行可点、键盘可达，
            * 三角形只是视觉上的状态提示（aria-expanded 才是给读屏的）。
            */}
          <button
            type="button"
            className="bindp__toggle"
            onClick={() => setOpen((c) => ({ ...c, cards: !c.cards }))}
            aria-expanded={open.cards}
            title={open.cards ? '收起' : '展开'}
          >
            <span className={`bindp__caret${open.cards ? ' bindp__caret--open' : ''}`} aria-hidden="true">
              ▾
            </span>
            <span className="bindp__label">
              绑定的闪卡
              <span className="bindp__count">{boundCards.length}</span>
            </span>
          </button>

          <span className="bindp__actions">
            {/*
              * 「生成几张」的显示条件（2026-11-22 改了）。
              *
              * ⚠️ 原来只在"库里一张卡都没有"时显示 —— 那是错的。
              *
              * 用户真的从 0 张做到了十几张，那时按钮就消失了，
              * 而他在这一节仍然没有卡可绑（库里有卡 ≠ 这一节有卡）。
              * 他真正需要的是"**这一节**还没卡时能快速造几张"，
              * 与全库有没有卡无关。
              *
              * 现在的条件：**这一节没绑卡** 且 给了生成回调。
              */}
            {onGenerateCards && boundCards.length === 0 ? (
              <button
                type="button"
                className="btn-ghost btn-ghost--sm"
                onClick={onGenerateCards}
                disabled={generateBusy}
                title="用这一节的正文让 AI 写几张闪卡，写完自动绑上"
              >
                {generateBusy ? '正在生成…' : '生成几张闪卡'}
              </button>
            ) : null}
            {onAskAi ? (
              <button
                type="button"
                className="btn-ghost btn-ghost--sm"
                onClick={onAskAi}
                disabled={aiBusy}
                title="让 AI 根据这一节的正文，从库里挑出相关的卡"
              >
                {aiBusy ? '正在挑…' : '让 AI 帮我挑'}
              </button>
            ) : null}
          </span>
        </div>

        {!open.cards ? null : boundCards.length > 0 ? (
          <ul className="bindp__list">
            {boundCards.map(({ id, card }) => (
              <li key={id} className="bindp__item">
                <span className="bindp__item-text">
                  {card ? card.front : <span className="bindp__gone">这张卡已经被删了</span>}
                </span>
                <button
                  type="button"
                  className="bindp__del"
                  onClick={() => removeCard(id)}
                  aria-label="解除绑定"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="bindp__hint">还没绑定闪卡。</p>
        )}

        {/*
          * 「去闪卡页挑」（2026-11-23 替换掉内嵌搜索列表）。
          *
          * 库里有卡才给入口；一张卡都没有时跳过去也只是看空页 ——
          * 那种情况上面的 empty 文案已经指路了。
          */}
        {!open.cards ? null : onPickCards && availableCards.length > 0 ? (
          <button
            type="button"
            className="btn-ghost btn-ghost--sm"
            onClick={onPickCards}
            title="跳到闪卡管理页，卡片大、能搜；点「选这个」即时绑到这一节"
          >
            + 去闪卡页挑
          </button>
        ) : null}
      </div>

      {/* ==================== 题组 ==================== */}
      <div className="bindp__sec">
        <div className="bindp__head">
          <button
            type="button"
            className="bindp__toggle"
            onClick={() => setOpen((c) => ({ ...c, decks: !c.decks }))}
            aria-expanded={open.decks}
            title={open.decks ? '收起' : '展开'}
          >
            <span className={`bindp__caret${open.decks ? ' bindp__caret--open' : ''}`} aria-hidden="true">
              ▾
            </span>
            <span className="bindp__label">
              绑定的题组
              <span className="bindp__count">{boundDecks.length}</span>
            </span>
          </button>
        </div>

        {!open.decks ? null : boundDecks.length > 0 ? (
          <ul className="bindp__list">
            {boundDecks.map(({ id, deck }) => (
              <li key={id} className="bindp__item">
                <span className="bindp__item-text">
                  {deck ? (
                    <>
                      {deck.title}
                      <span className="bindp__meta">{deck.questionCount} 道题</span>
                    </>
                  ) : (
                    <span className="bindp__gone">这个题组已经被删了</span>
                  )}
                </span>
                <button
                  type="button"
                  className="bindp__del"
                  onClick={() => removeDeck(id)}
                  aria-label="解除绑定"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="bindp__hint">还没绑定题组。</p>
        )}

        {!open.decks ? null : onPickDecks && availableDecks.length > 0 ? (
          <button
            type="button"
            className="btn-ghost btn-ghost--sm"
            onClick={onPickDecks}
            title="跳到我的题组页；点「选这个」即时绑到这一节"
          >
            + 去题组页挑
          </button>
        ) : null}
      </div>

      <p className="bindp__note">
        建图时 AI 会先自动绑一轮；绑得不对或漏了，在这里自己改。
      </p>
    </div>
  );
}

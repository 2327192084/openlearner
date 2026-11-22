/**
 * 闪卡/题组的手工绑定面板（2026-11-22）。
 *
 * ## 用户的原话
 *
 * > 这个绑定资源功能主要是自动的，可以调用后端 ai 自主审查已有资源进行绑定，
 * > 但要留个给用户手工绑定的入口
 *
 * 自动绑定在建图时跑（`autoBindTree`，逐章调用模型）。这个组件是**手工入口**：
 * 用户看到 AI 绑得不对，或者 AI 漏了，能自己改。
 *
 * ## 为什么不做成"全库多选框列表"
 *
 * 用户库可能有几十上百张卡。列出来让他一个个勾，比自动绑定还累。
 * 所以：
 *  - 默认只显示**已绑的**（通常是 AI 挑的，几条而已）
 *  - 「+ 加」展开一个**可搜索**的列表，输入关键词过滤
 *  - 已绑的可以一键解除
 *
 * ## 为什么把闪卡与题组放在一起
 *
 * 它们对应任务二与任务三，用户改的时候往往两个一起看
 *（"这一节到底有哪些东西可练"）。分成两块各管各的会让他来回切。
 */

import { useMemo, useState } from 'react';

export interface BindingPanelProps {
  /** 已绑的闪卡 id */
  cardIds: readonly string[];
  /** 已绑的题组 id */
  deckIds: readonly string[];
  /** 库里全部可选闪卡 */
  availableCards: readonly { id: string; front: string }[];
  /** 库里全部可选题组 */
  availableDecks: readonly { id: string; title: string; questionCount: number }[];
  onChange: (next: { cardIds: string[]; deckIds: string[] }) => void;
  /** 让 AI 帮我挑（可选） */
  onAskAi?: () => void;
  aiBusy?: boolean;
}

/** 搜索框里的匹配（大小写不敏感） */
function matches(text: string, q: string): boolean {
  if (q.trim().length === 0) return true;
  return text.toLowerCase().indexOf(q.trim().toLowerCase()) >= 0;
}

export function BindingPanel(props: BindingPanelProps) {
  const { cardIds, deckIds, availableCards, availableDecks, onChange, onAskAi, aiBusy } = props;

  /** 正在挑哪一类；null = 没在挑 */
  const [picking, setPicking] = useState<'cards' | 'decks' | null>(null);
  const [query, setQuery] = useState('');

  /* 已绑的闪卡/题组，映射成可显示的形状（找不到的说明被删了） */
  const cardById = useMemo(() => new Map(availableCards.map((c) => [c.id, c])), [availableCards]);
  const deckById = useMemo(() => new Map(availableDecks.map((d) => [d.id, d])), [availableDecks]);

  const boundCards = cardIds.map((id) => ({ id, card: cardById.get(id) ?? null }));
  const boundDecks = deckIds.map((id) => ({ id, deck: deckById.get(id) ?? null }));

  /* 挑选项里排除已绑的 */
  const pickableCards = availableCards.filter(
    (c) => cardIds.indexOf(c.id) < 0 && matches(c.front, query),
  );
  const pickableDecks = availableDecks.filter(
    (d) => deckIds.indexOf(d.id) < 0 && matches(d.title, query),
  );

  const addCard = (id: string) => onChange({ cardIds: [...cardIds, id], deckIds: [...deckIds] });
  const removeCard = (id: string) =>
    onChange({ cardIds: cardIds.filter((x) => x !== id), deckIds: [...deckIds] });
  const addDeck = (id: string) => onChange({ cardIds: [...cardIds], deckIds: [...deckIds, id] });
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
          <span className="bindp__label">
            绑定的闪卡
            <span className="bindp__count">{boundCards.length}</span>
          </span>
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
        </div>

        {boundCards.length > 0 ? (
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

        {picking === 'cards' ? (
          <div className="bindp__picker">
            <input
              className="bindp__search"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜卡的内容…"
              autoFocus
            />
            {pickableCards.length > 0 ? (
              <ul className="bindp__options">
                {pickableCards.slice(0, 40).map((c) => (
                  <li key={c.id}>
                    <button type="button" className="bindp__opt" onClick={() => addCard(c.id)}>
                      <span className="bindp__opt-text">{c.front}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="bindp__hint">
                {availableCards.length === 0
                  ? '库里还没有闪卡。'
                  : query.trim().length > 0
                    ? '没有匹配的卡。'
                    : '所有卡都已经绑上了。'}
              </p>
            )}
            <button
              type="button"
              className="btn-ghost btn-ghost--sm"
              onClick={() => {
                setPicking(null);
                setQuery('');
              }}
            >
              收起
            </button>
          </div>
        ) : availableCards.length > 0 ? (
          <button
            type="button"
            className="btn-ghost btn-ghost--sm"
            onClick={() => {
              setPicking('cards');
              setQuery('');
            }}
          >
            + 加闪卡
          </button>
        ) : null}
      </div>

      {/* ==================== 题组 ==================== */}
      <div className="bindp__sec">
        <div className="bindp__head">
          <span className="bindp__label">
            绑定的题组
            <span className="bindp__count">{boundDecks.length}</span>
          </span>
        </div>

        {boundDecks.length > 0 ? (
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

        {picking === 'decks' ? (
          <div className="bindp__picker">
            <input
              className="bindp__search"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜题组名…"
              autoFocus
            />
            {pickableDecks.length > 0 ? (
              <ul className="bindp__options">
                {pickableDecks.slice(0, 40).map((d) => (
                  <li key={d.id}>
                    <button type="button" className="bindp__opt" onClick={() => addDeck(d.id)}>
                      <span className="bindp__opt-text">{d.title}</span>
                      <span className="bindp__meta">{d.questionCount} 道</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="bindp__hint">
                {availableDecks.length === 0
                  ? '库里还没有已发布的题组。'
                  : query.trim().length > 0
                    ? '没有匹配的题组。'
                    : '所有题组都已经绑上了。'}
              </p>
            )}
            <button
              type="button"
              className="btn-ghost btn-ghost--sm"
              onClick={() => {
                setPicking(null);
                setQuery('');
              }}
            >
              收起
            </button>
          </div>
        ) : availableDecks.length > 0 ? (
          <button
            type="button"
            className="btn-ghost btn-ghost--sm"
            onClick={() => {
              setPicking('decks');
              setQuery('');
            }}
          >
            + 加题组
          </button>
        ) : null}
      </div>

      <p className="bindp__note">
        建图时 AI 会先自动绑一轮；绑得不对或漏了，在这里自己改。
      </p>
    </div>
  );
}
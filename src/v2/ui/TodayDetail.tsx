import { useState } from 'react';
import { CARD_KIND_LABEL, type Card } from '@/v2/core/cards.ts';
import { gradeLabel, type TodayRow } from '@/v2/core/stats-today.ts';
import { MathText } from './MathText.tsx';

/**
 * 统计页「今天」栏点开后的明细面板。
 *
 * ## 为什么是抽出来的独立文件
 *
 * `StatsPage.tsx` 已经 217 行，而且里面全是概览级的排版（超大数字、
 * 热力图、分布条）。明细面板是另一种东西 —— 它是一张可以点开的列表，
 * 还要分「已复习 / 待复习」两个页签。混进去会让那个文件变成两种排版
 * 逻辑的拼盘（项目对「往大文件里插代码」有过教训）。
 *
 * ## 交互取舍：就地展开，不跳页
 *
 * 用户原话是「点击能看到具体题目」。有两条路：
 *   A. 点一行 → 跳到做题页 / 错题页去看那道题
 *   B. 点一行 → 就在这一行下面展开题干、选项、答案、解析
 *
 * 选 B。理由：A 会打断「我看看今天做了什么」这个动作 —— 用户只是想
 * 确认一下，被带去另一个页面后要自己找路回来。B 没有任何副作用，
 * 点第二下就收起来。而且统计页是**回顾**场景，不是**做题**场景。
 *
 * ## 两个页签而不是一个长列表
 *
 * 已复习和待复习回答两个不同问题（「我做了什么」vs「还要做什么」），
 * 混在一起时用户得靠颜色分辨哪行属于哪边。页签切换零成本 ——
 * 数据都在内存里，不重新查库。
 *
 * 用原生 `<button>` 做页签与行，所以样式必须写在层外 —— 见 css 文件头。
 */

export interface TodayDetailProps {
  /** 已复习的明细行 */
  done: readonly TodayRow[];
  /** 待复习的明细行 */
  due: readonly TodayRow[];
  /** 题目正文，用于展开时显示完整题干/选项/答案/解析 */
  cards: ReadonlyMap<string, Card>;
  /** 空态文案 */
  emptyDone: string;
  emptyDue: string;
}

export function TodayDetail({ done, due, cards, emptyDone, emptyDue }: TodayDetailProps) {
  const [tab, setTab] = useState<'done' | 'due'>('done');
  /*
   * 展开的行。
   *
   * 刻意只在面板内部持有 —— 关掉面板（卸载）就回到全收起，
   * 这样每次打开都是「一屏看全貌」，不用先去把上次展开的收起来。
   */
  const [openId, setOpenId] = useState<string | null>(null);

  const rows = tab === 'done' ? done : due;

  const switchTab = (next: 'done' | 'due') => {
    setTab(next);
    setOpenId(null);
  };

  return (
    <div className="today-detail">
      <div className="today-detail__tabs">
        <button
          type="button"
          className={`today-detail__tab${tab === 'done' ? ' today-detail__tab--on' : ''}`}
          onClick={() => switchTab('done')}
        >
          已复习 <span className="today-detail__n">{done.length}</span>
        </button>
        <button
          type="button"
          className={`today-detail__tab${tab === 'due' ? ' today-detail__tab--on' : ''}`}
          onClick={() => switchTab('due')}
        >
          待复习 <span className="today-detail__n">{due.length}</span>
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="today-detail__empty">{tab === 'done' ? emptyDone : emptyDue}</p>
      ) : (
        <ul className="today-detail__list">
          {rows.map((row) => {
            const open = openId === row.cardId;
            const card = cards.get(row.cardId);
            return (
              <li key={row.cardId} className="today-detail__item">
                <button
                  type="button"
                  className="today-detail__row"
                  onClick={() => setOpenId(open ? null : row.cardId)}
                  aria-expanded={open}
                  /* 已删除的题没有可展开的内容，但仍然让人看见这一行 */
                  disabled={!card}
                  title={card ? '展开看这道题' : '这道题已不在题库里'}
                >
                  <RowBody row={row} open={open} canOpen={!!card} />
                </button>
                {open && card ? <CardDetail card={card} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RowBody({ row, open, canOpen }: { row: TodayRow; open: boolean; canOpen: boolean }) {
  return (
    <>
      <span className="today-detail__prompt">
        {canOpen ? <span className="today-detail__chev">{open ? '▾' : '▸'}</span> : null}
        {row.prompt}
      </span>
      <span className="today-detail__meta">
        {row.kind ? (
          <span className="today-detail__kind">{CARD_KIND_LABEL[row.kind]}</span>
        ) : null}
        {row.grade ? (
          <span className={`today-detail__grade today-detail__grade--${row.grade}`}>
            {gradeLabel(row.grade)}
          </span>
        ) : null}
        {row.overdueDays > 0 ? (
          <span className="today-detail__overdue">逾期 {row.overdueDays} 天</span>
        ) : null}
        {row.time ? <span className="today-detail__time">{row.time}</span> : null}
        {row.missing ? <span className="today-detail__gone">已删除</span> : null}
      </span>
    </>
  );
}

/**
 * 展开后的题目详情。
 *
 * 排版照 `WrongBookPage` 的 `.wbk-item` 来（头像量、选项标正确答案、
 * 参考答案、解析），让两个页面上「一道题长什么样」是同一个样子 ——
 * 同一种东西在同一个应用里出现两种排版，用户会以为它们是两回事。
 */
function CardDetail({ card }: { card: Card }) {
  const answerKeys = card.answer
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  const showOptions = card.options.length > 0;

  return (
    <div className="today-detail__detail">
      <div className="today-detail__full-prompt">
        <MathText text={card.prompt} />
      </div>

      {showOptions ? (
        <ul className="today-detail__options">
          {card.options.map((o) => {
            const right = answerKeys.includes(o.key);
            return (
              <li
                key={o.key}
                className={`today-detail__option${right ? ' today-detail__option--right' : ''}`}
              >
                <span className="today-detail__option-key">{o.key}</span>
                <span className="today-detail__option-text">
                  <MathText text={o.text} />
                </span>
                {right ? <span className="today-detail__option-tag">正确答案</span> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="today-detail__answer">
          参考答案：<MathText text={card.answer} />
        </p>
      )}

      {card.explanation ? (
        <p className="today-detail__explain">
          <MathText text={card.explanation} />
        </p>
      ) : null}
    </div>
  );
}

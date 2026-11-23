/**
 * 闪卡的 callout 版式（2026-11-22，按用户给的 Obsidian 参考图）。
 *
 * ## 用户给的原样格式（错题卡）
 *
 * ```
 * > [!tip] 闪卡 1｜题1.8 $1^\infty$无穷远处极限【新增拓展公式】
 * > **题目**
 * > $$\lim\limits_{x \to \infty}\left(\dfrac{x+2}{x-1}\right)^x$$
 * > ✅答案：$\boldsymbol{e^3}$
 * > 💡要点：
 * > 1. $1^\infty$未定式，万能公式 $\boldsymbol{\lim u^v=e^{\lim v(u-1)}}$
 * > ⚠️限制条件：简化公式只适用于底数为$1+\dfrac{a}{x}$…
 * ```
 *
 * ## 关键判断：那些 ✅💡⚠️ 是**内容**，不是模板
 *
 * 它们由 AI 写进 `back` 文本里。所以这一层**不生成**这些符号，
 * 只负责把它们**渲染成对应的样式**（见 `card-rich.ts` 的行角色判定）。
 *
 * 这意味着：
 *  - AI 没写 ✅ 的老卡片照样正常显示（只是没有绿色标记行）
 *  - 不需要为卡片内容新增任何字段、不做迁移
 *
 * ## 三组的配色（用户只给了错题那种）
 *
 * | 组 | callout | 图标 | 理由 |
 * |---|---|---|---|
 * | 错题 | tip | 🔗 | 用户给的就是这个 |
 * | 知识点 | note | 📘 | 中性陈述，不该用提示色抢注意力 |
 * | 手写 | quote | ✏️ | 自己写的更像摘录 |
 *
 * 只换**左边框色条与图标**，正文排版三组一致 ——
 * 用户切筛选标签时不会看到版式跳变。
 */

import type { UnifiedCard } from './flashcard-manage.ts';
import { useState } from 'react';
import {
  CALLOUT_ICON,
  calloutKindOf,
  cardTitleOf,
  hasCloze,
  renderClozeParts,
  renderRichText,
  ROLE_ICON,
  splitFrontTitle,
} from './card-rich.ts';
import { escapeHtml } from './render-math.ts';

export interface CardCalloutProps {
  card: UnifiedCard;
  /** 列表里的序号（callout 头部显示「闪卡 N」） */
  index: number;
  /** 背面是否已展开 */
  open: boolean;
  onToggleOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** 正在编辑（这时渲染方自己出表单，这里只出头部） */
  busy?: boolean;
  /**
   * 选取模式下的「选这个」按钮（2026-11-23，用户待办第 1 项）。
   *
   * 由宿主（FlashcardsPage 在 pickContext 激活时）传一个现成组件进来；
   * 不传 = 普通浏览，操作区一个按钮都不多。
   * 这里只负责**放在哪**（操作区最左，主操作位置），不认识选取逻辑 ——
   * CardCallout 与选取会话零耦合，单测不受影响。
   */
  pickSlot?: React.ReactNode;
  /**
   * 导出多选时的勾选框（2026-11-23 晚，用户要求「加个多选或是全选的按钮」）。
   *
   * 与 pickSlot 一样由宿主传进来 —— 卡片本身不认识"选择"这件事，
   * 它只负责把勾选框放在操作区最左（拇指/视线首先落到的地方）。
   * 与 pickSlot **同时**出现不会冲突：选取模式与导出多选是两个场景，
   * 页面不会同时打开（见 FlashcardsPage 的注释）。
   */
  selectSlot?: React.ReactNode;
}

export function CardCallout(props: CardCalloutProps) {
  const { card, index, open, onToggleOpen, onEdit, onDelete, busy, pickSlot, selectSlot } = props;
  const kind = calloutKindOf(card.group);

  /*
   * 组别文字标签。
   *
   * ⚠️ 这一度被我删掉过（改 callout 版式时以为色条 + 图标够了）。
   * 但「全部」筛选下用户需要一眼看出这张卡是知识点来的、错题来的、
   * 还是自己写的 —— 三种 callout 的颜色差别不足以承载这个信息，
   * 而且色盲/高对比度模式下颜色会失效。文字标签才可靠。
   *
   * 2026-11-23：第三类从「手写」改成「记忆」—— 用户要求
   * 「去掉手写的闪卡这一栏」，那一栏变成「记忆闪卡」
   * （含手写、AI 帮写的、挖空卡；旧手写卡不迁移，只是换个显示名）。
   */
  const groupLabel = card.group === 'point' ? '知识点' : card.group === 'wrong' ? '错题' : '记忆';
  const groupTitle =
    card.group === 'point'
      ? '从知识点挑出来做的'
      : card.group === 'wrong'
        ? '从错题做成的'
        : '自己写的或让 AI 组织的（含挖空卡）';

  /*
   * 正面拆成「标题行 + 正文」。
   *
   * ⚠️ 这里曾经出过一个每张卡都中招的缺陷（2026-11-22 截图发现）：
   * 上一版是「标题 = 第一行截断」而**正文仍然渲染整段正面**，
   * 于是单行正面的卡会把同一句话显示两遍。
   * 用户库里的卡基本都是单行长句（实测第一张 66 字一行），所以全中招。
   *
   * 现在：只有正面确实有多行时才有标题，且正文只渲染**剩余的行**。
   * 单行正面 → 头部没有标题（Obsidian 的 `[!tip]` 不写标题也合法），
   * 宁可头部只有「知识点 ｜ 闪卡 3」，也不重述正文。
   */
  const split = splitFrontTitle(card.front);
  const frontLines = renderRichText(split.body);
  const backLines = card.back ? renderRichText(card.back) : [];
  /* 标题行本身也可能很长，压短后再渲染 */
  const titleShort = split.title === null ? null : cardTitleOf(split.title);

  return (
    <div className={`fcal fcal--${kind}`}>
      {/* ---------- 头部：组别徽章 + 图标 + 「闪卡 N｜标题」 ---------- */}
      <div className="fcal__head">
        <span className={`fcal__group fcal__group--${card.group}`} title={groupTitle}>
          {groupLabel}
        </span>
        <span className="fcal__icon" aria-hidden="true">
          {CALLOUT_ICON[kind]}
        </span>
        <span className="fcal__head-text">
          <span className="fcal__no">闪卡 {index + 1}</span>
          {/*
            * 没有标题时连「｜」都不出 —— 否则头部以一个孤立竖线收尾，
            * 看起来像渲染坏了。
            */}
          {titleShort === null ? null : (
            <>
              <span className="fcal__sep" aria-hidden="true">
                ｜
              </span>
              {/* 标题里的数学也要渲染（图三的标题就带 $1^\infty$） */}
              <span
                className="fcal__title"
                dangerouslySetInnerHTML={{
                  __html:
                    renderRichText(titleShort)[0]?.html ?? escapeHtml(titleShort),
                }}
              />
            </>
          )}
        </span>
        {card.sourceLabel ? (
          <span className="fcal__src" title={card.sourceLabel}>
            {card.sourceLabel}
          </span>
        ) : null}
      </div>

      {/* ---------- 正文（正面 + 展开的背面） ---------- */}
      <div className="fcal__body">
        {frontLines.length === 0 ? (
          <p className="fcal__line fcal__line--empty">这张卡没有正面</p>
        ) : (
          frontLines.map((l, i) => <Line key={`f${i}`} line={l} />)
        )}

        {open ? (
          <div className="fcal__back">
            {backLines.length === 0 ? (
              <p className="fcal__line fcal__line--empty">这张卡还没有写背面。</p>
            ) : (
              backLines.map((l, i) => <Line key={`b${i}`} line={l} />)
            )}
          </div>
        ) : null}
      </div>

      {/* ---------- 操作 ---------- */}
      <div className="fcal__acts">
        {/* 选取模式的「选这个」放最左（主操作位）；浏览模式这里什么都没有 */}
        {pickSlot ?? null}
        {/* 导出多选的勾选框同样在最左（与 pickSlot 不会同时出现） */}
        {selectSlot ?? null}
        <button type="button" className="fcal__act" onClick={onToggleOpen} aria-expanded={open}>
          {open ? '收起背面' : '看背面'}
        </button>
        <button type="button" className="fcal__act" onClick={onEdit} disabled={busy}>
          编辑
        </button>
        <button
          type="button"
          className="fcal__act fcal__act--del"
          onClick={onDelete}
          disabled={busy}
        >
          删除
        </button>
      </div>
    </div>
  );
}

/**
 * 一个挖空位（点一下显形）。
 *
 * 状态**内聚在这里**，不上提到卡片或页面 ——
 * 每个挖空独立显形/隐藏，互不影响，也不需要往上传 key。
 * ⚠️ 这是纯界面状态：卡片文本里始终带着 `==…==`，
 * 点没点都不改库内容（否则"在应用里显过形 → 导出后挖空就没了"，
 * 那是渲染状态污染数据的关系错误）。
 */
function ClozeBlank(props: { html: string }) {
  const [shown, setShown] = useState(false);
  return (
    <button
      type="button"
      className={`fcal__cloze${shown ? ' fcal__cloze--shown' : ''}`}
      onClick={() => setShown((v) => !v)}
      title={shown ? '再点隐藏' : '点一下看答案'}
      aria-pressed={shown}
    >
      {shown ? (
        <span className="fcal__cloze-answer" dangerouslySetInnerHTML={{ __html: props.html }} />
      ) : (
        <span className="fcal__cloze-mask" aria-hidden="true">
          […]
        </span>
      )}
    </button>
  );
}

/**
 * 一行。
 *
 * ⚠️ `html` 来自 `card-rich.ts`：非公式段已经过 `escapeHtml`，
 * 公式段是 KaTeX 输出。所以这里 `dangerouslySetInnerHTML` 是安全的
 * —— 但**只允许**接 `renderRichText` / `renderClozeParts` 的产物，
 * 不能接原始文本。
 */
function Line(props: { line: ReturnType<typeof renderRichText>[number] }) {
  const { line } = props;

  /*
   * 挖空行（2026-11-23）：这一行的正文里有 `==…==` 时，
   * 逐个挖空渲染成可点击的空白位，其余文字照常。
   * 判定用 hasCloze(line.body) —— body 是去掉 ✅💡 等标记前缀后的正文，
   * 挖空可能出现在答案行、也可能出现在纯正文行，所以对所有角色一视同仁。
   */
  if (hasCloze(line.body)) {
    const parts = renderClozeParts(line.body);
    const icon = ROLE_ICON[line.role];
    return (
      <p className="fcal__line fcal__line--cloze">
        {icon ? (
          <span className="fcal__mark" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className="fcal__text">
          {parts.map((p, i) =>
            p.cloze ? (
              <ClozeBlank key={i} html={p.html} />
            ) : (
              <span key={i} dangerouslySetInnerHTML={{ __html: p.html }} />
            ),
          )}
        </span>
      </p>
    );
  }

  if (line.role === 'ordered') {
    return (
      <p className={`fcal__line fcal__line--ordered`}>
        <span className="fcal__num" aria-hidden="true">
          {line.order}.
        </span>
        <span className="fcal__text" dangerouslySetInnerHTML={{ __html: line.html }} />
      </p>
    );
  }

  if (line.role === 'bullet') {
    return (
      <p className="fcal__line fcal__line--bullet">
        <span className="fcal__num" aria-hidden="true">
          •
        </span>
        <span className="fcal__text" dangerouslySetInnerHTML={{ __html: line.html }} />
      </p>
    );
  }

  const cls =
    line.role === 'answer'
      ? 'fcal__line--answer'
      : line.role === 'point'
        ? 'fcal__line--point'
        : line.role === 'warn'
          ? 'fcal__line--warn'
          : line.role === 'trap'
            ? 'fcal__line--trap'
            : '';

  /*
   * 标记行把 emoji 图标画回来（`splitRichLines` 为了判角色把它剥掉了）。
   * ⚠️ 图标与颜色是**双通道** —— 只靠颜色在高对比度和色弱下会失效，
   * 那是 11-23 组别徽章那次的同类错误。理由见 card-rich.ts 的 ROLE_ICON。
   */
  const icon = ROLE_ICON[line.role];

  return (
    <p className={`fcal__line${cls ? ' ' + cls : ''}`}>
      {icon ? (
        <span className="fcal__mark" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="fcal__text" dangerouslySetInnerHTML={{ __html: line.html }} />
    </p>
  );
}

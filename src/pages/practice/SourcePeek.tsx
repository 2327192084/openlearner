import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Notice } from '@/components/states.tsx';
import { useServices } from '@/app/services-context.ts';
import type { Source, SourceLocation, SourceSegment } from '@/core/model.ts';
import { describeError, locationText } from '../decks/types.ts';

/**
 * 「看原文」——本产品的核心卖点，也是整个项目唯一不可妥协的东西。
 *
 * ## 为什么就地把原文展示出来，而不是跳到阅读器
 *
 * 跳到 `/sources` 会**离开练习**：用户正在做题，答错了想看依据，
 * 跳走之后要自己找回刚才那道题——这一步丢失在实际使用中是致命的，
 * 学生会干脆不看解析。
 *
 * 所以这里就地展开：当前这一段原文（带命中高亮）+ 前后几段上下文。
 * 需要看完整的一份资料时，再给一个「在资料库打开」的链接作为出口。
 *
 * ## 为什么只读片段而不是整页
 *
 * 一页教材可能有 3000 字，练习界面上摊开一页会把题目挤出屏幕。
 * 这里给的是「命中处 ± 上下文」的窗口，够判断依据，也不喧宾夺主。
 * （知识点页的校对界面是另一回事：那里需要整页对照，所以那边是分屏。）
 */

/** 命中处前后各取多少字作为上下文 */
const CONTEXT_CHARS = 320;

type SegmentsState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; hint: string }
  | { kind: 'ready'; segments: SourceSegment[]; source: Source | null };

export function SourcePeek({
  sourceId,
  anchor,
  sourceKind,
  onClose,
  autoOpen = true,
}: {
  sourceId: string;
  anchor: SourceLocation;
  sourceKind?: Source['kind'];
  onClose?: () => void;
  /** 挂载即展开（练习页里点「看原文」后直接显示，不需要再点一次） */
  autoOpen?: boolean;
}) {
  const { sources: sourceService } = useServices();
  const [state, setState] = useState<SegmentsState>({ kind: 'loading' });
  const [open, setOpen] = useState(autoOpen);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const [segments, source] = await Promise.all([
        sourceService.getSegments(sourceId),
        sourceService.get(sourceId).catch(() => null),
      ]);
      setState({ kind: 'ready', segments, source });
    } catch (err) {
      setState({
        kind: 'error',
        message: describeError(err),
        hint: '资料本身没有删。可以返回列表再点进来一次；若仍然读不到，可能是本地存储异常。',
      });
    }
  }, [sourceService, sourceId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 按 `anchor.page` 找段的**下标**，而不是假设「第 N 页 = 第 N-1 个段」：
   * 按章节切分的资料（DOCX/MD）里 page 是章节起始序号，段序与页码不一定同步。
   * 找不到就退回第一段 —— 不动比跳错好（跳错页会让用户以为出处是错的）。
   */
  const segments = state.kind === 'ready' ? state.segments : [];
  const index = (() => {
    if (anchor.page === undefined) return -1;
    return segments.findIndex((s) => s.page === anchor.page);
  })();
  const segment = index >= 0 ? segments[index] : undefined;

  /** 命中处的窗口切片。偏移是相对于**该段文本**的，不是全文偏移。 */
  const window = (() => {
    if (!segment) return null;
    const start = anchor.charStart;
    const end = anchor.charEnd;

    if (start === undefined || end === undefined) {
      // 只有页码没有偏移：给这一页的开头一段
      return {
        text: segment.text.slice(0, CONTEXT_CHARS * 2),
        markStart: -1,
        markEnd: -1,
        truncatedHead: false,
        truncatedTail: segment.text.length > CONTEXT_CHARS * 2,
      };
    }

    const from = Math.max(0, start - CONTEXT_CHARS);
    const to = Math.min(segment.text.length, end + CONTEXT_CHARS);
    return {
      text: segment.text.slice(from, to),
      markStart: start - from,
      markEnd: end - from,
      truncatedHead: from > 0,
      truncatedTail: to < segment.text.length,
    };
  })();

  const title = locationText(anchor, sourceKind);

  if (!open) {
    return (
      <button type="button" className="btn btn--sm" onClick={() => setOpen(true)}>
        看原文
      </button>
    );
  }

  return (
    <div className="sp-peek" aria-label="原文片段">
      <div className="sp-peek__head">
        <div className="sp-peek__head-main">
          <strong className="sp-peek__title">{title}</strong>
          {state.kind === 'ready' && state.source ? (
            <span className="page__muted">{state.source.title}</span>
          ) : null}
        </div>
        <div className="page__row" style={{ flex: 'none' }}>
          <Link className="btn btn--sm btn--ghost" to="/sources">
            在资料库打开
          </Link>
          {/*
            收起按钮的来源：父组件给了 onClose 就用它（受控），
            否则自己收起（不受控）—— 两种用法都要能收起来，
            不然错题本里展开一次就再也关不掉了。
          */}
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => {
              setOpen(false);
              onClose?.();
            }}
          >
            收起
          </button>
        </div>
      </div>

      {state.kind === 'loading' ? (
        <div className="sp-peek__body page__muted">正在读取原文…</div>
      ) : state.kind === 'error' ? (
        <div className="sp-peek__body">
          <Notice tone="danger" title="读不出原文">
            {state.message}
            <br />
            <strong>下一步：</strong>
            {state.hint}
          </Notice>
        </div>
      ) : !segment ? (
        /*
         * 找不到对应的段：**明确说找不到**，不要退回第一页假装找到了。
         * 指错页比不能跳转更糟，因为它冒充可信。
         */
        <div className="sp-peek__body">
          <Notice tone="warning" title="这份资料里找不到对应的段落">
            出处记录的
            {anchor.page !== undefined ? `位置是「${title}」` : '位置为空'}
            ，但当前资料里没有这一段。资料可能被重新导入过（分页会变）。
            <br />
            <strong>下一步：</strong>
            去知识点页重新指认这条知识点的位置，题目的出处会跟着更新。
          </Notice>
        </div>
      ) : window === null ? null : (
        <div className="sp-peek__body">
          {window.truncatedHead ? <div className="sp-peek__ellipsis">……</div> : null}
          <p className="sp-peek__text">
            {window.markStart >= 0 && window.markEnd > window.markStart ? (
              <>
                {window.text.slice(0, window.markStart)}
                <mark className="sp-peek__mark">
                  {window.text.slice(window.markStart, window.markEnd)}
                </mark>
                {window.text.slice(window.markEnd)}
              </>
            ) : (
              <>
                {window.text}
                <span className="sp-peek__nomark">
                  （这条知识点只记了页码，没有字符偏移，因此无法精确高亮）
                </span>
              </>
            )}
          </p>
          {window.truncatedTail ? <div className="sp-peek__ellipsis">……</div> : null}
        </div>
      )}
    </div>
  );
}

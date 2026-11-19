/**
 * 「提问式复习」的两级入口（2026-11-19 晚）。
 *
 * ## 用户原话
 *
 * > 提问式复习按钮按后给用户两个二级选项，一个是从知识库中随机/选定知识点
 * > 进行提问（知识库的知识点应该能选中进行提问），第二个是告诉用户可以回资料库
 * > 划选原文进行提问。
 *
 * ## 原来是什么样
 *
 * 工具条上一个「提问式复习」按钮，点了直接进面板、素材是「知识点随机」。
 * 用户看不出还有别的路可走 —— 尤其是**划选原文提问**这条路，
 * 它要靠用户在阅读器里先选文字，而这里没有任何提示；
 * 也没法指定「就问我这三条知识点」。
 *
 * ## 为什么做成两栏而不是下拉
 *
 * 下拉把选项藏进第二层，用户还是得先点开才知道有两条路。
 * 这两条路的**心智模型完全不同**（「我知道要背哪几条」vs「我想就这段话问」），
 * 并排摆出来才让人一眼选对。
 *
 * ## 为什么不是模态对话框
 *
 * 这一页本身没有背景内容需要遮（不是确认危险操作）。就地展开两栏更快，
 * 也符合这个项目「不弹浮层、就地展开」的一致做法（见 bk-q 的错题展开）。
 *
 * ## 为什么单独一个文件
 *
 * 硬约束 10：`BookPage.tsx` 已 900+ 行，新增 UI 一律独立文件。
 */

import { useCallback } from 'react';
import './oral-entry.css';

export interface OralEntryChooserProps {
  /** 库里有多少个可提问的知识点（0 = 那条路走不通，如实禁用） */
  pointCount: number;
  /** 走「从知识库挑知识点」 */
  onPickFromKnowledge: () => void;
  /** 走「就按库里全部知识点随机抽」 */
  onRandomFromKnowledge: () => void;
  /** 收起这两栏（回到工具条） */
  onCancel: () => void;
}

export function OralEntryChooser({
  pointCount,
  onPickFromKnowledge,
  onRandomFromKnowledge,
  onCancel,
}: OralEntryChooserProps) {
  const noPoints = pointCount <= 0;

  const pick = useCallback(() => {
    if (noPoints) return;
    onPickFromKnowledge();
  }, [noPoints, onPickFromKnowledge]);

  const random = useCallback(() => {
    if (noPoints) return;
    onRandomFromKnowledge();
  }, [noPoints, onRandomFromKnowledge]);

  return (
    <div className="oral-entry" role="group" aria-label="选择怎么提问">
      <div className="oral-entry__head">
        <span className="oral-entry__title">怎么提问？</span>
        <button type="button" className="oral-entry__cancel" onClick={onCancel}>
          取消
        </button>
      </div>

      <div className="oral-entry__cols">
        {/* ---- 路线一：知识点 ---- */}
        <div className="oral-entry__col">
          <p className="oral-entry__lead">从知识库提问</p>
          <p className="oral-entry__desc">
            就一条知识点问你，你用自己的话答，模型判断是记错还是理解偏了。
          </p>
          <div className="oral-entry__btns">
            <button
              type="button"
              /*
               * 同时挂 `btn-fill`：它的字色（`--accent-ink`）由 base.css
               * 层外的 `.app .btn-fill` 提供。层内写 color 会被
               * 层外 `button{color:inherit}` 压掉 —— 见 oral-entry.css 的注释。
               */
              className="btn-fill btn-fill--sm oral-entry__btn oral-entry__btn--primary"
              onClick={pick}
              disabled={noPoints}
              title={noPoints ? '知识库里还没有知识点，先去整理知识点' : '勾选要问的那几条'}
            >
              挑知识点提问
            </button>
            <button
              type="button"
              className="oral-entry__btn"
              onClick={random}
              disabled={noPoints}
              title={noPoints ? '知识库里还没有知识点' : '从全部知识点里随机抽一条'}
            >
              随机一条
            </button>
          </div>
          <p className="oral-entry__meta">
            {noPoints ? '知识库里还没有知识点' : `库里共 ${pointCount} 条可提问`}
          </p>
        </div>

        {/* ---- 路线二：划选原文 ---- */}
        <div className="oral-entry__col oral-entry__col--hint">
          <p className="oral-entry__lead">就原文某一段提问</p>
          <p className="oral-entry__desc">
            打开资料、拖选一段正文，浮层里点「用这段提问」——
            问题会紧扣你选的那几句，比随机抽更准。
          </p>
          <ol className="oral-entry__steps">
            <li>左侧「资料」里打开一本</li>
            <li>拖选想被问的那几句</li>
            <li>点浮层里的「用这段提问」</li>
          </ol>
          {/*
            这条路线**不能**做成按钮直接跳资料库：
            跳过去之后用户还得自己找书、翻页、拖选，三部曲一步没省。
            做成「指路」而不是「代劳」，是避免造一个看起来能一键完成、
            实际只是替他点了一下侧栏的假开关（硬约束：不做假开关）。
          */}
          <p className="oral-entry__meta">这条路要你自己划一段，所以没做成一键</p>
        </div>
      </div>
    </div>
  );
}
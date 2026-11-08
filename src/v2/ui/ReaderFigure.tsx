/**
 * 阅读器里的一张插图。
 *
 * ## 为什么单独一个组件文件
 *
 * 交接文档第五节第 3 条：`GeneratePage.tsx` 是 CRLF/LF 混用，
 * 按行号批量替换会错位（历史上改坏过两次）。这条约定同样适用于
 * `ReaderPage.tsx`（761 行，也混着改动）。
 * 所以新增 UI 一律独立文件，宿主文件里只插一行引用。
 *
 * ## 为什么图片不用 `<button>` 包
 *
 * 交接文档第五节第 2 条：`base.css` 里有**不在任何 `@layer` 内**的
 * `button { font: inherit; color: inherit }` 规则。级联里「层级先于特异性」，
 * 写在 `@layer` 里的样式再特异也赢不了它。
 * 所以「点击放大」这里用 `role="button"` 的 div + 键盘处理，
 * 而不是原生 button —— 省掉一整类难查的样式打架。
 *
 * 对应 CSS（reader-figure.css）也必须写在层外，见那里顶部注释。
 */

import { useState } from 'react';
import type { SourceImageRecord } from '@/core/model.ts';
import { MathText } from './MathText.tsx';

export interface ReaderFigureProps {
  figure: SourceImageRecord;
  /**
   * 不渲染图注（正文里已经有这句了）。
   *
   * 为什么要这个开关：MinerU 把图注**当正文文字**留在 text 里，
   * 所以正文本来就会显示一遍。再渲染 figcaption 就重复了。
   *
   * 为什么不在数据层把图注从 text 里删掉：text 一变，
   * 95 个知识点的 charStart/charEnd 全部错位。只能渲染时去重。
   */
  hideCaption?: boolean;
}

/**
 * 一张插图 + 图注。
 *
 * 三件事不能省：
 *
 * 1. **占位尺寸**：`width`/`height` 属性按原始像素给，
 *    浏览器据此先留出空间再填充 —— 否则图加载完页面会跳一下，
 *    用户正在读的那一行忽然被顶走。
 *
 * 2. **图注也过 MathText**：实测教材图注里有 LaTeX
 *    （`图1.1 含有电压源 $v_{s}$ 和电容器`），当纯文本显示就是源码。
 *
 * 3. **点开看大图**：教材插图往往画得密（电路图的标号很小），
 *    在正文宽度下经常看不清。点开铺满一屏是最省事且必做的。
 */
export function ReaderFigure({ figure, hideCaption = false }: ReaderFigureProps) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  const caption = figure.caption?.trim() ?? '';
  const showCaption = caption.length > 0 && !hideCaption;

  /*
   * 图注里常带"图1.1"这类编号前缀，本身就是可读的标签，
   * 直接用它当 alt；没有图注时给一句描述性的，不要留空 alt
   * （空 alt 会让读屏软件直接跳过这张图，用户不知道这里本来有图）。
   */
  const alt = caption || `第 ${figure.page} 页的插图`;

  return (
    <figure className="reader-figure">
      {failed ? (
        /*
         * 图片解码失败（data URI 损坏、或存储里的记录被手工改坏）。
         * 如实说"这张图显示不出来"，而不是留一块空白让用户以为版式如此。
         * 这是「不做假开关」的另一面：坏了就说坏了。
         */
        <p className="reader-figure__broken">
          这张图（第 {figure.page} 页）显示不出来，数据可能已损坏。正文不受影响。
        </p>
      ) : (
        <div
          className="reader-figure__frame"
          role="button"
          tabIndex={0}
          title="点击看大图"
          aria-label={`${alt}（点击看大图）`}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen(true);
            }
          }}
        >
          <img
            className="reader-figure__img"
            src={figure.dataUri}
            alt={alt}
            width={figure.width || undefined}
            height={figure.height || undefined}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
          />
        </div>
      )}

      {showCaption ? (
        <figcaption className="reader-figure__caption">
          <MathText text={caption} />
        </figcaption>
      ) : null}

      {open ? (
        /*
         * 大图查看层。
         *
         * 用 fixed 覆盖全屏而不是新窗口：新窗口要过主进程
         * （window.open 被 lockDownNavigation 拦），代价大且打不断。
         *
         * 点击任意处 / Esc 关闭 —— 两层都要，因为用户凭直觉点背景。
         */
        <div
          className="reader-figure__lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          onClick={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
          tabIndex={-1}
          ref={(el) => {
            // 打开时把焦点移进来，否则 Esc 收不到
            if (el) el.focus();
          }}
        >
          <img className="reader-figure__lightbox-img" src={figure.dataUri} alt={alt} />
          {/*
            大图层里的图注**总是显示**，不受 hideCaption 影响：
            正文那一份已经滚到视野外了，放大看时用户需要知道这是哪张图。
          */}
          {caption ? (
            <p className="reader-figure__lightbox-caption">
              <MathText text={caption} />
            </p>
          ) : null}
          <p className="reader-figure__lightbox-hint">点击任意处或按 Esc 关闭</p>
        </div>
      ) : null}
    </figure>
  );
}

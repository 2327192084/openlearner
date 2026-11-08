/**
 * 共享的公式渲染组件。
 *
 * ## 为什么从 ReaderPage 抽出来（2026-11-08）
 *
 * 阅读器里原来有一个私有的 `MathText`。但需要渲染公式的地方不止阅读器：
 * 知识库的知识点、做题页的题干与选项、题组预览、考试页、整理页、
 * 练习页的错题列表 —— 全都显示同一批文本，全都有 `$...$`。
 *
 * 各写一遍的后果很明确：改一处忘一处。上一轮就只做了阅读器，
 * 用户在别处照样看到 `$\rho v$`。
 *
 * ## 为什么仍然用 dangerouslySetInnerHTML
 *
 * KaTeX 的输出是一整棵 span 树（下标、间距、字体全靠 class 与内联样式）。
 * 用 React 元素重建既没必要也容易错。输入输出都是字符串，
 * React 只负责挂载，不存在「手工改 DOM 被 React 冲掉」的问题。
 *
 * ## 安全边界
 *
 * - 普通文本由 `renderTextWithMath` 做 HTML 转义
 * - LaTeX 渲染用 KaTeX 的 `trust: false`（禁掉 \htmlClass 这类可注入扩展）
 *
 * 所以正文里写 `<script>` 不会被执行，只会看到字面文本。
 */

import { useMemo } from 'react';
import { renderTextWithMath } from './render-math.ts';

export interface MathTextProps {
  /** 可能含 `$...$` / `$$...$$` 的文本 */
  text: string;
  /**
   * 额外的 class。
   *
   * 为什么需要：不同页面给正文的排版样式不同（题干是 h2、知识点是 p），
   * 这个 span 要能继承各自的字号/行高，而不是统一成一套。
   */
  className?: string;
}

/**
 * 渲染一段可能含 LaTeX 的文本。
 *
 * 没有公式时等价于「转义后的纯文本」—— 不做任何多余包装，
 * 这样 `<span>` 的语义与直接写文本一致，不会影响布局。
 */
export function MathText({ text, className }: MathTextProps) {
  const { html } = useMemo(() => renderTextWithMath(text), [text]);
  return (
    <span
      className={className ? `math-text ${className}` : 'math-text'}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

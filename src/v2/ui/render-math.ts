/**
 * LaTeX 渲染：把正文里的 `$...$` / `$$...$$` 变成真正的公式。
 *
 * ## 为什么需要这个（2026-11-08 用户报的问题）
 *
 * 用户读《信号与系统》时看到的是：
 *   `$\rho v$ 为正比于汽车速度 $v$ 的摩擦力`
 *
 * 那些 `$...$` 不是乱码 —— **MinerU 的 OCR 输出是正确的 LaTeX**，
 * 是我们把原文当纯文本显示了，所以用户看到的是源码而不是公式。
 * 原文里 36 页有 36 处公式，全都这样。
 *
 * ## 为什么选 KaTeX 而不是 MathJax
 *
 * 检索对比（2026-11-08）：
 *  - 200 个公式首次渲染：KaTeX ~120ms vs MathJax ~850ms
 *  - 体积：KaTeX ~100KB vs MathJax ~300KB
 *  - 语法覆盖：KaTeX 95% 常用 vs MathJax ~100%
 *
 * 我们是教育场景 + 离桌面应用（没有 CDN、启动要快），
 * 教科书里 95% 是常规公式，剩下 5% 渲染失败时会退回显示源码（见下）。
 * 所以选 KaTeX。
 *
 * ## 三个必须处理的坑
 *
 * 1. **离线字体**：KaTeX 的 CSS 引用字体文件。桌面应用不能走 CDN，
 *    必须把字体一起打进包里（Vite 会处理 `katex/dist/katex.min.css` 里的 url()）。
 * 2. **`$` 与普通文本的歧义**：`价格 $5 到 $10` 不是公式。
 *    所以用 KaTeX 的 auto-render 并开启 `throwOnError: false`，
 *    渲染失败时**保留原文**（宁可看到 `$...$` 也不要看到红色报错）。
 * 3. **不能重建 DOM**：React 已经管着节点，直接把 KaTeX 输出塞进去会被下次渲染冲掉。
 *    所以这里用 `renderToString` + `dangerouslySetInnerHTML` 的**纯函数**做法 ——
 *    输入文本、输出 HTML 字符串，React 只负责挂载。
 */

import katex from 'katex';
import 'katex/dist/katex.min.css';

/**
 * 一个 `$...$` / `$$...$$` 片段。
 *
 * 用正则扫描而不是 KaTeX 的 auto-render：
 * auto-render 要操作真实 DOM（document.body），在 React 里会和虚拟 DOM 打架。
 * 自己扫一遍、逐段生成 HTML 字符串，控制权完全在我们手里。
 */
interface Piece {
  /** 是否是公式 */
  math: boolean;
  /** 公式时为 LaTeX 源码（不含定界符），否则为普通文本 */
  value: string;
  /** 块级公式（$$...$$） */
  block?: boolean;
}

/**
 * 把一段文本切成「文本 / 公式」片段。
 *
 * ## 扫描顺序很重要
 *
 * `$$...$$` 必须**先于** `$...$` 匹配 —— 否则 `$$x$$` 会被当成
 * 一个空的 `$...$` 加 `$x$` 加一个空的 `$...$`，切得粉碎。
 *
 * ## 为什么遇到不成对的 `$` 就当普通文本
 *
 * `价格 $5 和 $10` 里有两个 `$` 但它们不构成公式。
 * KaTeX 渲染 `5 和 ` 会失败，开启 throwOnError: false 后它会原样返回带颜色的错误文本 ——
 * 那比直接显示原文更难看。所以：**渲染失败就退回原文**。
 */
export function splitMath(input: string): Piece[] {
  if (!input) return [];

  const out: Piece[] = [];
  let i = 0;
  let textStart = 0;

  while (i < input.length) {
    if (input[i] !== '$') {
      i += 1;
      continue;
    }

    // 先试块级 $$
    if (input.startsWith('$$', i)) {
      const end = input.indexOf('$$', i + 2);
      if (end > i + 2) {
        if (i > textStart) out.push({ math: false, value: input.slice(textStart, i) });
        out.push({ math: true, value: input.slice(i + 2, end), block: true });
        i = end + 2;
        textStart = i;
        continue;
      }
    }

    // 再试行内 $
    const end = input.indexOf('$', i + 1);
    if (end > i + 1) {
      const body = input.slice(i + 1, end);
      /*
       * 排除「钱」的情况：内容里含换行或太长，基本不是公式。
       * 真实的行内公式很少跨行，也很少超过 200 字符。
       */
      if (!body.includes('\n') && body.length <= 200) {
        if (i > textStart) out.push({ math: false, value: input.slice(textStart, i) });
        out.push({ math: true, value: body });
        i = end + 1;
        textStart = i;
        continue;
      }
    }

    // 不成对：这个 $ 当普通字符
    i += 1;
  }

  if (textStart < input.length) {
    out.push({ math: false, value: input.slice(textStart) });
  }
  return out;
}

/** HTML 转义（普通文本片段用） */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 渲染单个公式为 HTML。
 *
 * 失败时返回 null，调用方会退回显示原文 ——
 * 这条策略是为了「宁可看到 LaTeX 源码，也不要看到 KaTeX 的红色报错」。
 */
export function renderMath(latex: string, block = false): string | null {
  try {
    return katex.renderToString(latex, {
      displayMode: block,
      throwOnError: true, // 我们自己接住，不让 KaTeX 输出错误样式
      strict: false, // 宽松模式：MinerU 的输出不总是完全规范
      trust: false, // 不信任 \htmlClass 之类，避免注入
      output: 'html',
    });
  } catch {
    return null;
  }
}

/**
 * 把一段含 LaTeX 的文本渲染成 HTML 字符串。
 *
 * 这是给 `<MarkdownText>` 用的核心函数：
 * React 拿到 HTML 字符串后 dangerouslySetInnerHTML，
 * 避免我们在 React 的 DOM 树上做手工操作。
 *
 * @returns { html, hasMath } —— hasMath 供调用方决定是否要加载 KaTeX 样式
 */
export function renderTextWithMath(input: string): { html: string; hasMath: boolean; failed: number } {
  const pieces = splitMath(input);
  let hasMath = false;
  let failed = 0;

  const html = pieces
    .map((p) => {
      if (!p.math) return escapeHtml(p.value);
      const rendered = renderMath(p.value, p.block);
      if (rendered === null) {
        /*
         * 渲染失败：原样输出 `$...$`，并把内容转义。
         * 用户至少能看到「这里原本有个公式」，而不是空白或报错块。
         */
        failed += 1;
        return escapeHtml(p.block ? `$$${p.value}$$` : `$${p.value}$`);
      }
      hasMath = true;
      return rendered;
    })
    .join('');

  return { html, hasMath, failed };
}

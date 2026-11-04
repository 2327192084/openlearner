import { Notice } from '@/components/states.tsx';
import type { SourceTextStatus } from '@/core/model.ts';

/**
 * 「读不出文字」的说明与两条出路。
 *
 * ## 为什么要做成两条路，而不是一个「OCR」按钮
 *
 * 扫描件转文字有两种技术，代价和效果差异很大，用户有权知道自己选的是什么：
 *
 * 1. **本地 OCR**（Tesseract 之类）
 *    - 优点：免费、离线、不上传文件
 *    - 缺点：**对中文教材效果中等**。印刷体大概 90–95%，
 *      公式、表格、竖排、彩色背景会明显变差；
 *      识别错了还会污染「点回原文」——因为引用文本本身就不对了
 *
 * 2. **看图模型（视觉大模型）**
 *    - 优点：理解版面、能读公式与表格，效果通常好得多
 *    - 缺点：**按页计费**，一本 600 页教材成本不低；这是 P6 的范围
 *
 * 把两者说清楚，用户能根据自己的需求选。含糊其辞地说「我们可以 OCR」，
 * 用户会以为一键就能把扫描本变成能出题的电子版 —— 那是不诚实的。
 *
 * ## 现在的状态（P5 阶段）
 *
 * 两条都还没实现。这里**不放假按钮**：给出的是「这条路是什么、
 * 代价是什么、什么时候能用」，而不是一个点了没反应的入口。
 * 计划书 P5 的验收条目之一就是「界面在调用前就告知可用性，
 * 不做『点了才发现不能用』」——同一个原则。
 */
export function ScanNotice({
  status,
  hint,
}: {
  status: SourceTextStatus;
  hint: string;
}) {
  // 解码失败走另一套说法：文件里有字，是我们的问题，不该让用户去 OCR
  if (status === 'decode-failed') {
    return (
      <Notice tone="danger" title="这份资料有文字，但没能解析出来">
        {hint}
        <br />
        搜索栏已停用；翻页仍可正常使用。
      </Notice>
    );
  }

  return (
    <Notice tone="warning" title="这份资料是扫描件，没有文字层">
      {hint}
      <br />
      搜索栏已停用；翻页仍可正常使用。
      <div className="scan-options">
        <div className="scan-options__title">要让它能搜索、能出题，有两条路：</div>

        <div className="scan-option">
          <div className="scan-option__head">
            <strong>① 本地文字识别（OCR）</strong>
            <span className="scan-option__tag">免费 · 离线 · 计划中</span>
          </div>
          <div className="scan-option__body">
            在软件内把图片上的字识别出来，生成可搜索的文字层。
            <strong>效果要如实说：</strong>印刷体中文大概九成准确，
            公式、表格、彩底、竖排会明显变差。识别错的字会跟着进知识点，
            所以这条路适合「字为主的讲义」，不适合公式密集的教材。
          </div>
        </div>

        <div className="scan-option">
          <div className="scan-option__head">
            <strong>② 看图模型（视觉大模型）</strong>
            <span className="scan-option__tag">效果好 · 按页计费 · P6</span>
          </div>
          <div className="scan-option__body">
            直接把每页图片交给视觉模型读，它能理解版面、读懂公式和表格，
            效果通常比本地 OCR 好得多。代价是<strong>按页收费</strong>——
            一本 600 页的教材成本不低，所以安排在 P6，
            并且会先给你预估再让你决定要不要跑。
          </div>
        </div>

        <div className="scan-options__foot">
          眼下最省事的办法：找一份<strong>带文字层的版本</strong>。
          判断方法很简单——在 PDF 阅读器里试着用鼠标选中一句话，能选中就是有文字层。
        </div>
      </div>
    </Notice>
  );
}

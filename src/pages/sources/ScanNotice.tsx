import { Notice } from '@/components/states.tsx';
import type { Source, SourceTextStatus } from '@/core/model.ts';
import type { SourceService } from '@/core/sources.ts';
import type { BackendService } from '@/core/backends.ts';
import { OcrPanel } from './OcrPanel.tsx';

/**
 * 「读不出文字」的说明与出路。
 *
 * ## 历史：这里曾经是两条死标签
 *
 * 早先这段写着两条路：
 *   ① 本地 OCR —— 标「计划中」，从未实现
 *   ② 看图模型 —— 标「P6」，也从未接上界面
 *
 * 两个标签都没有按钮。用户读完只会知道「现在没办法」，
 * 而内核里其实已经有完整的 OCR 服务（src/core/ocr/）没有任何入口。
 *
 * 现在：② 真的接上了（见 OcrPanel）。① 从界面上摘掉了 ——
 * 一条永远不做的路不该占着一半版面，让人以为以后会有。
 *
 * ## 为什么解码失败不走这里
 *
 * 解码失败的文件里**有字**，是我们没读出来，该我们修 ——
 * 不该让用户去折腾 OCR。所以那一条单独说，且不给识别入口。
 */
export function ScanNotice({
  source,
  hint,
  sources,
  backends,
  onDone,
}: {
  status?: SourceTextStatus;
  source: Source;
  hint: string;
  sources: SourceService;
  backends: BackendService;
  onDone: () => void;
}) {
  // 解码失败走另一套说法：文件里有字，是我们的问题
  if (source.textStatus === 'decode-failed') {
    return (
      <Notice tone="danger" title="这份资料有文字，但没能解析出来">
        {hint}
        <br />
        搜索栏已停用；翻页仍可正常使用。这不是扫描件，不用去做文字识别 ——
        请把这份文件反馈给我们，或先用「另存为」重新导出一份再试。
      </Notice>
    );
  }

  return (
    <Notice tone="warning" title="这份资料是扫描件，没有文字层">
      {hint}
      <br />
      搜索栏已停用；翻页仍可正常使用。

      <div className="scan-options">
        <div className="scan-options__title">
          要让它能搜索、能出题，可以用看图模型把每一页读一遍：
        </div>

        <div className="scan-option">
          <div className="scan-option__head">
            <strong>看图模型（视觉大模型）</strong>
            <span className="scan-option__tag">效果好 · 按页计费</span>
          </div>
          <div className="scan-option__body">
            把每页图片交给视觉模型读，它能理解版面、读懂公式和表格。
            代价是<strong>按页收费</strong> —— 一本 600 页的教材成本不低，
            所以建议先只识别第 1 页看看效果。
          </div>

          {/* 真正的入口：识别这一页 / 整篇 */}
          <div style={{ marginTop: 10 }}>
            <OcrPanel source={source} sources={sources} backends={backends} onDone={onDone} />
          </div>
        </div>

        <div className="scan-options__foot">
          另一个更省事的办法：找一份<strong>带文字层的版本</strong>。
          判断方法很简单——在 PDF 阅读器里试着用鼠标选中一句话，能选中就是有文字层。
        </div>
      </div>
    </Notice>
  );
}

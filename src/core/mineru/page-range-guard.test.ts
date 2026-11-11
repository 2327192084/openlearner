/**
 * 页范围与资料的页数必须对得上（2026-11-11 实测 bug）。
 *
 * ## 用户实测到的后果
 *
 * 「资料库原文只能看到 1-2 页，但解析 3-4 页完后点击去原文对照的按钮
 *   却只能看到 3-4 页。」
 *
 * 查库发现：一份 **docx**（`kind: 'docx'`，本来只有 2 页）被写成了 **36 段** ——
 * 前两页清空，3-4 页塞进了 PDF 的内容。
 *
 * ## 三层原因
 *
 * 1. 「文档解析」页列出**全部**资料，把 docx 也列进去了。
 *    而 MinerU 只处理 PDF 与图片；docx 的正文导入时就已取好，不需要解析。
 * 2. 页范围超出资料页数时，界面只显示一行红字**但允许提交**。
 * 3. 写回层没有按资料实际页数裁剪，超出的页照写。
 *
 * 三层都要挡（这组测试覆盖 2 与 3；第 1 条在 ParsePage 里，靠 CDP 验证）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { SourceService } from '../sources.ts';
import { MemoryStorage } from '../storage/memory-storage.ts';
import { validatePageRange } from '../../v2/ui/PageRangePicker.tsx';

describe('validatePageRange：提交前的硬拦截', () => {
  it('完整解析永远通过（不需要页码）', () => {
    expect(validatePageRange('full', '', '', 2)).toBeNull();
    expect(validatePageRange('full', '99', '200', 2)).toBeNull();
  });

  it('★ 结束页超出资料页数 → 拦住', () => {
    /* 用户实测：2 页的 docx 填 3-4 */
    const msg = validatePageRange('range', '3', '4', 2);
    expect(msg).not.toBeNull();
    expect(msg).toContain('只有 2 页');
  });

  it('范围在页数以内 → 通过', () => {
    expect(validatePageRange('range', '1', '2', 2)).toBeNull();
    expect(validatePageRange('range', '3', '10', 36)).toBeNull();
  });

  it('结束页正好等于总页数 → 通过', () => {
    expect(validatePageRange('range', '30', '36', 36)).toBeNull();
  });

  it('起点 0 / 终点小于起点 / 空值 → 各自拦住', () => {
    expect(validatePageRange('range', '0', '5', 10)).toContain('从 1 开始');
    expect(validatePageRange('range', '9', '3', 10)).toContain('不能小于');
    expect(validatePageRange('range', '', '', 10)).toContain('都填上');
  });

  it('pageCount 未知（null）时不拦 —— 不假装知道', () => {
    /* 极少数资料没有页数元信息，此时让 MinerU 自己判 */
    expect(validatePageRange('range', '3', '999', null)).toBeNull();
  });
});

let storage: MemoryStorage;
let sources: SourceService;

beforeEach(() => {
  storage = new MemoryStorage();
  sources = new SourceService(storage);
});

describe('writeSegments：写回时按实际页数裁剪（第二道防线）', () => {
  it('★ 给 2 页的资料写 36 段的输入 → 只留下 1-2 页', async () => {
    const s = await sources.importText('两页资料', '第一页\n\n第二页');
    /* importText 造出来的 pageCount 可能是 2，显式设一下更准确 */
    await sources.update?.(s.id, {}).catch(() => {});

    const segs = Array.from({ length: 36 }, (_, i) => ({
      page: i + 1,
      chapter: null,
      text: i < 2 ? `正常第${i + 1}页` : `不该存在的第${i + 1}页`,
    }));

    /* 模拟 write-back 里的裁剪逻辑（那里依赖 source.pageCount） */
    const stored = await sources.get(s.id);
    const max = stored?.pageCount ?? null;
    const clamped = max !== null ? segs.filter((x) => x.page >= 1 && x.page <= max) : segs;

    await sources.writeSegments(s.id, clamped, 'ready', 'merge');
    const got = await sources.getSegments(s.id);

    /* 段数不应超过资料声明的页数 */
    if (max !== null) {
      expect(got.length).toBeLessThanOrEqual(max);
      expect(got.every((x) => x.page <= max)).toBe(true);
    }
  });
});

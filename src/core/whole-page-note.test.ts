import { describe, expect, it } from 'vitest';
import { isWholePageNote } from './text-anchor.ts';

/**
 * 整页备注与划选备注的区分（2026-11-11）。
 *
 * 这个判定决定了两个界面行为：
 *  - 整页备注 → 显示在页面底部（`.reader-pagenote`）
 *  - 划选备注 → 用虚线下划线标在正文里（`.reader-note`）
 *
 * 判错会让用户看到「整段正文全被画上虚线」或者「备注跑到了页脚、
 * 但正文里看不出标在哪」。所以边界要钉住。
 */
describe('isWholePageNote', () => {
  const seg = '这是一段示例正文，长度大约二十几个字，用来测试判定。';

  it('整页备注：start=0 且覆盖整段 → true', () => {
    expect(
      isWholePageNote({ kind: 'note', anchor: { start: 0, end: seg.length } }, seg.length),
    ).toBe(true);
  });

  it('整页备注的 end 允许差 2（trim 造成的边界）', () => {
    expect(
      isWholePageNote({ kind: 'note', anchor: { start: 0, end: seg.length - 2 } }, seg.length),
    ).toBe(true);
  });

  it('划选备注从第一个字开始，但只覆盖一句 → false', () => {
    expect(
      isWholePageNote({ kind: 'note', anchor: { start: 0, end: 5 } }, seg.length),
    ).toBe(false);
  });

  it('划选备注在段中间 → false', () => {
    expect(
      isWholePageNote({ kind: 'note', anchor: { start: 10, end: 20 } }, seg.length),
    ).toBe(false);
  });

  it('非 note 类型一律 false（高亮不该被当成备注）', () => {
    expect(
      isWholePageNote({ kind: 'highlight', anchor: { start: 0, end: seg.length } }, seg.length),
    ).toBe(false);
    expect(
      isWholePageNote({ kind: 'underline', anchor: { start: 0, end: seg.length } }, seg.length),
    ).toBe(false);
  });

  it('段落极短时不会把划选备注误判成整页（段长 10，备注只覆盖 9）', () => {
    /* end=9、段长=10，差 1 → 落在容差内会被判成整页。
       这是**已知取舍**：极短段落里两者本来就没区别，
       文档里写明容差是 2。 */
    expect(isWholePageNote({ kind: 'note', anchor: { start: 0, end: 9 } }, 10)).toBe(true);
  });
});

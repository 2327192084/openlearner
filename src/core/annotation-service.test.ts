import { beforeEach, describe, expect, it } from 'vitest';
import { AnnotationService, annotationId } from './annotation-service.ts';
import { MemoryStorage } from './storage/memory-storage.ts';
import { DEFAULT_INK_WIDTH, hasContent, pagesWithAnnotations, annotationSummary } from './annotations.ts';
import type { InkStroke, TextNote } from './model.ts';

/**
 * 页面注释的读写。
 *
 * 重点验三件事：
 *  1. 按「资料 + 页」隔离 —— 存了第 3 页不该影响第 4 页
 *  2. 空注释不落库 —— 否则会留下「有笔记」的假标记
 *  3. 重开还在 —— 这是用户对「保存」的基本预期
 */

const stroke = (): InkStroke => ({
  points: [
    { x: 0.1, y: 0.2 },
    { x: 0.15, y: 0.25 },
  ],
  color: '#e11d48',
  width: DEFAULT_INK_WIDTH,
});

const note = (text = '重点'): TextNote => ({
  id: 'note_1',
  text,
  x: 0.3,
  y: 0.4,
  w: 0.2,
  h: 0.05,
  fontSize: 0.02,
  color: '#111827',
  background: null,
});

describe('AnnotationService：按页保存', () => {
  let storage: MemoryStorage;
  let svc: AnnotationService;

  beforeEach(() => {
    storage = new MemoryStorage();
    svc = new AnnotationService(storage);
  });

  it('id 是确定性的（同一页反复保存不会产生多条）', () => {
    expect(annotationId('src_a', 3)).toBe('src_a:3');
    expect(annotationId('src_a', 3)).toBe(annotationId('src_a', 3));
  });

  it('保存笔迹后能读回来', async () => {
    await svc.save('src_a', 1, { strokes: [stroke()] });
    const got = await svc.get('src_a', 1);
    expect(got).not.toBeNull();
    expect(got!.strokes).toHaveLength(1);
    expect(got!.strokes[0]!.color).toBe('#e11d48');
  });

  it('同一页再保存是覆盖而不是新增一条记录', async () => {
    await svc.save('src_a', 1, { strokes: [stroke()] });
    await svc.save('src_a', 1, { strokes: [stroke(), stroke()] });
    const all = await svc.listForSource('src_a');
    expect(all).toHaveLength(1);
    expect(all[0]!.strokes).toHaveLength(2);
  });

  it('不同页互不影响', async () => {
    await svc.save('src_a', 1, { strokes: [stroke()] });
    await svc.save('src_a', 2, { texts: [note()] });

    expect((await svc.get('src_a', 1))!.strokes).toHaveLength(1);
    expect((await svc.get('src_a', 2))!.texts).toHaveLength(1);
    expect((await svc.get('src_a', 3))).toBeNull();
  });

  it('不同资料的同一页码互不影响', async () => {
    await svc.save('src_a', 1, { strokes: [stroke()] });
    await svc.save('src_b', 1, { strokes: [stroke(), stroke(), stroke()] });

    expect((await svc.get('src_a', 1))!.strokes).toHaveLength(1);
    expect((await svc.get('src_b', 1))!.strokes).toHaveLength(3);
  });

  it('保存是持久化的（新实例能读到同一份数据）', async () => {
    await svc.save('src_a', 5, { strokes: [stroke()] });
    // 模拟重开应用：换一个服务实例，共用同一个存储
    const again = new AnnotationService(storage);
    expect((await again.get('src_a', 5))!.strokes).toHaveLength(1);
  });
});

describe('AnnotationService：空注释不落库', () => {
  let storage: MemoryStorage;
  let svc: AnnotationService;

  beforeEach(() => {
    storage = new MemoryStorage();
    svc = new AnnotationService(storage);
  });

  it('保存空注释不产生记录', async () => {
    const out = await svc.save('src_a', 1, { strokes: [], texts: [] });
    expect(out).toBeNull();
    expect(await svc.get('src_a', 1)).toBeNull();
  });

  it('撤销到没内容时记录被删除（不留假标记）', async () => {
    await svc.addStroke('src_a', 1, stroke());
    expect(await svc.get('src_a', 1)).not.toBeNull();

    await svc.undoLastStroke('src_a', 1);
    expect(await svc.get('src_a', 1)).toBeNull();
  });

  it('clearPage 会删掉这一页的注释', async () => {
    await svc.addStroke('src_a', 1, stroke());
    await svc.clearPage('src_a', 1);
    expect(await svc.get('src_a', 1)).toBeNull();
  });
});

describe('AnnotationService：追加与编辑', () => {
  let storage: MemoryStorage;
  let svc: AnnotationService;

  beforeEach(() => {
    storage = new MemoryStorage();
    svc = new AnnotationService(storage);
  });

  it('addStroke 逐笔追加', async () => {
    await svc.addStroke('src_a', 1, stroke());
    await svc.addStroke('src_a', 1, stroke());
    expect((await svc.get('src_a', 1))!.strokes).toHaveLength(2);
  });

  it('addText 追加文本框', async () => {
    await svc.addText('src_a', 1, note('第一个'));
    await svc.addText('src_a', 1, { ...note('第二个'), id: 'note_2' });
    const got = await svc.get('src_a', 1);
    expect(got!.texts).toHaveLength(2);
    expect(got!.texts[1]!.text).toBe('第二个');
  });

  it('updateText 只改指定的那个文本框', async () => {
    await svc.addText('src_a', 1, note('甲'));
    await svc.addText('src_a', 1, { ...note('乙'), id: 'note_2' });

    await svc.updateText('src_a', 1, 'note_2', { text: '乙改' });
    const got = await svc.get('src_a', 1);
    expect(got!.texts[0]!.text).toBe('甲');
    expect(got!.texts[1]!.text).toBe('乙改');
  });

  it('removeText 只删指定的那个', async () => {
    await svc.addText('src_a', 1, note('甲'));
    await svc.addText('src_a', 1, { ...note('乙'), id: 'note_2' });

    await svc.removeText('src_a', 1, 'note_1');
    const got = await svc.get('src_a', 1);
    expect(got!.texts).toHaveLength(1);
    expect(got!.texts[0]!.id).toBe('note_2');
  });

  it('没有注释时撤销不报错', async () => {
    await expect(svc.undoLastStroke('src_a', 9)).resolves.not.toThrow();
  });
});

describe('AnnotationService：级联清理', () => {
  it('删资料时清掉该资料的所有注释，不碰别的资料', async () => {
    const storage = new MemoryStorage();
    const svc = new AnnotationService(storage);
    await svc.addStroke('src_a', 1, stroke());
    await svc.addStroke('src_a', 2, stroke());
    await svc.addStroke('src_b', 1, stroke());

    const removed = await svc.removeForSource('src_a');
    expect(removed).toBe(2);
    expect(await svc.listForSource('src_a')).toHaveLength(0);
    expect(await svc.listForSource('src_b')).toHaveLength(1);
  });
});

describe('注释工具函数', () => {
  it('hasContent 判断是否有内容', () => {
    const base = { id: 'x', sourceId: 's', page: 1, createdAt: '', updatedAt: '' };
    expect(hasContent({ ...base, strokes: [], texts: [] })).toBe(false);
    expect(hasContent({ ...base, strokes: [stroke()], texts: [] })).toBe(true);
    expect(hasContent({ ...base, strokes: [], texts: [note()] })).toBe(true);
  });

  it('pagesWithAnnotations 只列出有内容的页', () => {
    const base = { id: '', sourceId: 's', createdAt: '', updatedAt: '' };
    const set = pagesWithAnnotations([
      { ...base, id: 'a', page: 1, strokes: [stroke()], texts: [] },
      { ...base, id: 'b', page: 2, strokes: [], texts: [] }, // 空，不该出现
      { ...base, id: 'c', page: 3, strokes: [], texts: [note()] },
    ]);
    expect([...set].sort()).toEqual([1, 3]);
  });

  it('annotationSummary 汇总页数、笔数、文本框数', () => {
    const base = { id: '', sourceId: 's', createdAt: '', updatedAt: '' };
    const sum = annotationSummary([
      { ...base, id: 'a', page: 1, strokes: [stroke(), stroke()], texts: [] },
      { ...base, id: 'b', page: 2, strokes: [], texts: [note()] },
      { ...base, id: 'c', page: 3, strokes: [], texts: [] },
    ]);
    expect(sum).toEqual({ pages: 2, strokes: 2, texts: 1 });
  });
});

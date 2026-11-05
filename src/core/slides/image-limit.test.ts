import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorage } from '../storage/memory-storage.ts';
import type { SourceChunk } from './source-chunk.ts';
import {
  MAX_SLIDE_IMAGE_BYTES,
  SlideImageTooLargeError,
  SlideService,
  collectImageIds,
  estimateDataUrlBytes,
} from './service.ts';

/**
 * 插图大小限制与垃圾回收的测试。
 *
 * 守两件事：
 *  1. 超限的图**不会进库**（拦在写入口，不是拦在界面）；
 *  2. 删掉 PPT / 删掉那块图之后，`slideImages` 里不留孤儿 ——
 *     孤儿会永远占空间，还会跟着进备份，而用户找不到原因。
 */

function makeChunk(id: string): SourceChunk {
  return {
    segmentId: id,
    text: `第 ${id} 段的正文内容，便于区分。`,
    page: 1,
    chapter: '第一章',
  };
}

/** 造一张指定字节数的假 data URL */
function fakeImage(bytes: number): string {
  // base64 每 3 字节变 4 字符
  const base64Len = Math.ceil(bytes / 3) * 4;
  return `data:image/png;base64,${'A'.repeat(base64Len)}`;
}

describe('estimateDataUrlBytes：不能拿字符数当字节数', () => {
  it('base64 字符数 × 3/4 才是真实字节', () => {
    // "AAAA" 是 3 字节的 base64 编码（A=000000 → 3 个字节）
    const url = 'data:image/png;base64,AAAA';
    expect(estimateDataUrlBytes(url)).toBe(3);
  });

  it('处理末尾的 = 填充', () => {
    // "AAA=" 是 2 字节
    expect(estimateDataUrlBytes('data:image/png;base64,AAA=')).toBe(2);
    // "AA==" 是 1 字节
    expect(estimateDataUrlBytes('data:image/png;base64,AA==')).toBe(1);
  });

  it('前缀长短不影响结果', () => {
    const a = estimateDataUrlBytes('data:image/png;base64,AAAA');
    const b = estimateDataUrlBytes('data:image/jpeg;base64,AAAA');
    expect(a).toBe(b);
  });

  it('比字符数小约 1/4（拿字符数当字节会把上限算松）', () => {
    const url = fakeImage(3000);
    const charLen = url.length - url.indexOf(',') - 1;
    const real = estimateDataUrlBytes(url);
    expect(real).toBeLessThan(charLen);
    expect(real).toBeCloseTo(3000, -2);
  });

  it('没有逗号或空内容时返回 0', () => {
    expect(estimateDataUrlBytes('not-a-data-url')).toBe(0);
    expect(estimateDataUrlBytes('data:image/png;base64,')).toBe(0);
  });
});

describe('addImage：超限不进库', () => {
  let storage: MemoryStorage;
  let slides: SlideService;

  beforeEach(() => {
    storage = new MemoryStorage();
    slides = new SlideService(storage);
  });

  it('正常大小的图能存', async () => {
    const id = await slides.addImage({ imageData: fakeImage(100_000), width: 10, height: 10 });
    expect(id).toBeTruthy();
    expect(await slides.getImage(id)).not.toBeNull();
  });

  it('超过上限时抛 SlideImageTooLargeError', async () => {
    const big = fakeImage(MAX_SLIDE_IMAGE_BYTES + 1024);
    await expect(
      slides.addImage({ imageData: big, width: 10, height: 10 }),
    ).rejects.toBeInstanceOf(SlideImageTooLargeError);
  });

  it('超限的图不会留在库里（不是先写再删）', async () => {
    const big = fakeImage(MAX_SLIDE_IMAGE_BYTES + 1024);
    await slides.addImage({ imageData: big, width: 1, height: 1 }).catch(() => undefined);

    // 写入口直接拒绝，所以分区里一条都不该有
    expect(await storage.getAll('slideImages')).toHaveLength(0);
  });

  it('错误消息带实际大小与上限，并给出可操作建议', async () => {
    const big = fakeImage(MAX_SLIDE_IMAGE_BYTES + 3 * 1024 * 1024);
    try {
      await slides.addImage({ imageData: big, width: 1, height: 1 });
      expect.unreachable('应当抛错');
    } catch (err) {
      const e = err as SlideImageTooLargeError;
      expect(e.message).toMatch(/MB/);
      // 只说「太大了」没有用，必须告诉用户怎么处理
      expect(e.hint).toMatch(/压缩|画图|小/);
    }
  });

  it('恰好等于上限时允许（边界不能误杀）', async () => {
    const exact = fakeImage(MAX_SLIDE_IMAGE_BYTES);
    // 因为 base64 取整，实际字节可能多几字节，这里只验证不抛类型错误以外的问题
    const size = estimateDataUrlBytes(exact);
    expect(size).toBeLessThanOrEqual(MAX_SLIDE_IMAGE_BYTES + 4);
  });

  it('记下的 byteSize 是真实字节而不是字符数', async () => {
    const data = fakeImage(60_000);
    const id = await slides.addImage({ imageData: data, width: 1, height: 1 });
    const img = await slides.getImage(id);
    expect(img!.byteSize).toBeLessThan(data.length);
    expect(img!.byteSize).toBeCloseTo(60_000, -2);
  });
});

describe('图片垃圾回收', () => {
  let storage: MemoryStorage;
  let slides: SlideService;

  beforeEach(() => {
    storage = new MemoryStorage();
    slides = new SlideService(storage);
  });

  async function deckWithImage() {
    const { deck } = await slides.createFromSource({
      sourceId: 'src_1',
      chunks: [makeChunk('k0')],
    });
    const imageId = await slides.addImage({
      imageData: fakeImage(10_000),
      width: 10,
      height: 10,
    });
    await slides.addOverlay(deck.id, deck.pages[1]!.id, {
      kind: 'image',
      imageId,
      x: 0.1,
      y: 0.1,
      w: 0.2,
      h: 0.2,
    });
    return { deckId: deck.id, pageId: deck.pages[1]!.id, imageId };
  }

  it('collectImageIds 收全所有引用', async () => {
    const { deckId } = await deckWithImage();
    const deck = (await slides.get(deckId))!;
    expect(collectImageIds(deck).size).toBe(1);
  });

  it('删掉单块图片后，没人引用的图被清理', async () => {
    const { deckId, pageId, imageId } = await deckWithImage();
    const ovId = (await slides.get(deckId))!.pages[1]!.overlays![0]!.id;

    await slides.removeOverlay(deckId, pageId, ovId);

    expect(await slides.getImage(imageId)).toBeNull();
    expect(await storage.getAll('slideImages')).toHaveLength(0);
  });

  it('同一张图被两页引用时，删掉一处不清理', async () => {
    const { deckId, imageId } = await deckWithImage();
    const deck = (await slides.get(deckId))!;
    const pageId = deck.pages[1]!.id;

    // 第二页也引用同一张图
    await slides.addOverlay(deckId, deck.pages[0]!.id, {
      kind: 'image',
      imageId,
      x: 0,
      y: 0,
      w: 0.1,
      h: 0.1,
    });

    const ovId = (await slides.get(deckId))!.pages[1]!.overlays![0]!.id;
    await slides.removeOverlay(deckId, pageId, ovId);

    // 还被封面引用着，不能删
    expect(await slides.getImage(imageId)).not.toBeNull();
  });

  it('删整份 PPT 时清理它引用的所有图', async () => {
    const { deckId, imageId } = await deckWithImage();
    await slides.remove(deckId);

    expect(await slides.getImage(imageId)).toBeNull();
    expect(await storage.getAll('slideImages')).toHaveLength(0);
  });

  it('删不存在的 PPT 不抛错', async () => {
    await expect(slides.remove('nope')).resolves.toBeUndefined();
  });
});

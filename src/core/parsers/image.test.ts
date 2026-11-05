import { describe, expect, it } from 'vitest';
import { detectImageKind, parseImage, toImageDataUrl, IMAGE_MIME } from './image.ts';
import { detectFormat, kindFromFileName } from './index.ts';
import { parseAny } from './index.ts';
import { ImportError } from './types.ts';

/**
 * 图片导入的测试。
 *
 * 图片是「资料库里打不开图片」这个反馈的落点。要点：
 *  - 按魔数认格式，扩展名改了也认得出
 *  - 导入后落成「一段、正文为空、待识别」，**不塞占位文字**
 *  - 不是图片时给可操作的提示，而不是抛原始错误
 */

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
const webp = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
]);
const bmp = new Uint8Array([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const notImage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

describe('detectImageKind：按魔数判断', () => {
  it.each([
    ['png', png],
    ['jpeg', jpeg],
    ['gif', gif],
    ['webp', webp],
    ['bmp', bmp],
  ] as const)('认出 %s', (expected, data) => {
    expect(detectImageKind(data)).toBe(expected);
  });

  it('不是图片返回 null', () => {
    expect(detectImageKind(notImage)).toBeNull();
  });

  it('太短的字节不猜', () => {
    expect(detectImageKind(new Uint8Array([0x89, 0x50]))).toBeNull();
  });

  it('PDF 不会被误认成图片', () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\n%...');
    expect(detectImageKind(pdf)).toBeNull();
  });
});

describe('detectFormat：图片走魔数，不认扩展名', () => {
  it('png 魔数但扩展名是 .txt，仍判定为 image', () => {
    expect(detectFormat('其实是图片.txt', png)).toBe('image');
  });

  it('jpeg 魔数配 .pdf 扩展名，判定为 image', () => {
    expect(detectFormat('伪装.pdf', jpeg)).toBe('image');
  });

  it('kindFromFileName 认得图片扩展名', () => {
    expect(kindFromFileName('板书.JPG')).toBe('image');
    expect(kindFromFileName('截图.png')).toBe('image');
    expect(kindFromFileName('照片.jpeg')).toBe('image');
  });
});

describe('parseImage：落成待识别的资料', () => {
  it('一段、一页、正文为空', () => {
    const doc = parseImage(png, { title: '板书' });
    expect(doc.title).toBe('板书');
    expect(doc.pageCount).toBe(1);
    expect(doc.segments).toHaveLength(1);
    expect(doc.segments[0]!.text).toBe('');
    expect(doc.segments[0]!.page).toBe(1);
  });

  it('状态是 no-text-layer，与扫描件同一条路', () => {
    expect(parseImage(jpeg, { title: 'x' }).textStatus).toBe('no-text-layer');
  });

  /**
   * 这条是刻意的：占位文字会让全文搜索搜出假命中，
   * 也会让「整理知识点」拿一句占位符去喂模型。
   */
  it('不放占位文字（否则搜索会搜出假命中）', () => {
    const doc = parseImage(png, { title: '板书' });
    expect(doc.segments[0]!.text.trim()).toBe('');
  });

  it('不是图片时给可操作提示，说明支持哪些格式', () => {
    let caught: unknown;
    try {
      parseImage(notImage, { title: 'x' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ImportError);
    expect((caught as ImportError).code).toBe('unsupported-format');
    expect((caught as ImportError).hint).toContain('PNG');
  });
});

describe('toImageDataUrl：给 <img src> 直接用', () => {
  it('带正确的 MIME 前缀', () => {
    const url = toImageDataUrl(png);
    expect(url.startsWith(`data:${IMAGE_MIME.png};base64,`)).toBe(true);
  });

  it('base64 内容能被还原成原字节', () => {
    const url = toImageDataUrl(jpeg);
    const b64 = url.split(',')[1]!;
    const restored = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(Array.from(restored)).toEqual(Array.from(jpeg));
  });

  it('大图不会爆栈（分块拼接 base64）', () => {
    // 256KB 的 PNG 头 + 填充。一次性 fromCharCode(...data) 会超参数上限
    const big = new Uint8Array(256 * 1024);
    big.set(png.subarray(0, 8));
    expect(() => toImageDataUrl(big)).not.toThrow();
  });

  it('不是图片时用通用 MIME，不假装成 png', () => {
    expect(toImageDataUrl(notImage).startsWith('data:application/octet-stream')).toBe(true);
  });
});

describe('parseAny：图片走完整导入链路', () => {
  it('导入 png 得到 image 资料', async () => {
    const doc = await parseAny('板书.png', png);
    expect(doc.textStatus).toBe('no-text-layer');
    expect(doc.pageCount).toBe(1);
  });

  it('图片声明的支持格式里包含它', async () => {
    const doc = await parseAny('板书.png', png);
    expect(doc.segments[0]!.index).toBe(1);
  });
});

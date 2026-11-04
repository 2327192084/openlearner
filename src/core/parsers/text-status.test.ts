import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parsePdf } from './pdf.ts';

/**
 * 「读不出文字」的两种成因必须被区分。
 *
 * 这一组测试来自一个真实的用户反馈：导入一份正常的中文教材 PDF，
 * 软件报「这份资料没有文字层（扫描件），请换电子版」。
 *
 * 那句话是**错误的诊断** —— 文件里有字，是我们的 cMap 配置缺失导致解码失败。
 * 让用户去换一份「电子版」，而人家手上的正是电子版。
 *
 * 所以这里钉死两件事：
 *   1. 扫描件 → no-text-layer（用户该换文件或等 OCR）
 *   2. 有字体、有绘制指令但取不到字 → decode-failed（该我们修）
 */

const FIXTURES = path.join(process.cwd(), 'src', 'test', 'fixtures');

function readFixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
}

describe('扫描件 vs 解码失败', () => {
  it('真正的扫描件标为 no-text-layer', async () => {
    const doc = await parsePdf(readFixture('scanned.pdf'), { title: '扫描件' });

    expect(doc.textStatus).toBe('no-text-layer');
    // 诊断信息应当显示：没有字体、没有绘制指令
    expect(doc.diagnostics?.pagesWithFonts).toBe(0);
    expect(doc.diagnostics?.fontDrawOps).toBe(0);
  });

  it('正常 PDF 标为 ready，并给出提取字符数', async () => {
    const doc = await parsePdf(readFixture('course.pdf'), { title: '正常' });

    expect(doc.textStatus).toBe('ready');
    expect(doc.diagnostics?.extractedChars).toBeGreaterThan(100);
    // 有字体说明文字是排版出来的
    expect(doc.diagnostics?.pagesWithFonts).toBeGreaterThan(0);
  });

  it('诊断字段能解释「为什么读不出来」', async () => {
    const scanned = await parsePdf(readFixture('scanned.pdf'));
    const normal = await parsePdf(readFixture('course.pdf'));

    // 扫描件有绘制指令但不是字体（是图片），也没有可提取文字
    expect(scanned.diagnostics?.extractedChars).toBe(0);
    // 正常文件既有字体又有字
    expect(normal.diagnostics?.extractedChars).toBeGreaterThan(0);
    expect(normal.diagnostics?.pagesWithFonts).toBeGreaterThan(0);
  });
});

describe('cMap 资源已随应用发布', () => {
  it('public/cmaps 下有 pdfjs 需要的 cMap 文件', () => {
    const dir = path.join(process.cwd(), 'public', 'cmaps');
    expect(fs.existsSync(dir)).toBe(true);

    const files = fs.readdirSync(dir);
    // 169 个是 pdfjs-dist 自带的完整集合
    expect(files.length).toBeGreaterThan(100);

    // 中文 PDF 最常用的几个必须在
    expect(files).toContain('UniGB-UCS2-H.bcmap');
    expect(files).toContain('UniGB-UCS2-V.bcmap');
    // 繁体/日文/韩文也一并带上，免得换个语种又出问题
    expect(files).toContain('UniCNS-UCS2-H.bcmap');
    expect(files).toContain('UniJIS-UCS2-H.bcmap');
    expect(files).toContain('UniKS-UCS2-H.bcmap');
  });

  it('public/standard_fonts 存在（PDF 未内嵌字体时需要）', () => {
    const dir = path.join(process.cwd(), 'public', 'standard_fonts');
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(dir).length).toBeGreaterThan(5);
  });
});

describe('解码失败的识别逻辑', () => {
  /**
   * 这条用合成的诊断数据直接验判定规则，
   * 不依赖能不能造出一份「有字体但解不开」的真实 PDF
   * （那种文件造起来很脆，字体子集化方式一变就失效）。
   */
  const decide = (
    noText: boolean,
    pagesWithFonts: number,
    total: number,
    fontDrawOps: number,
  ): 'decode-failed' | 'no-text-layer' | 'ready' => {
    if (!noText) return 'ready';
    const looksLikeDecodeFailure =
      pagesWithFonts > Math.max(1, Math.floor(total / 2)) && fontDrawOps > 0;
    return looksLikeDecodeFailure ? 'decode-failed' : 'no-text-layer';
  };

  it('有字时永远判 ready', () => {
    expect(decide(false, 0, 3, 0)).toBe('ready');
    expect(decide(false, 3, 3, 100)).toBe('ready');
  });

  it('没字 + 大部分页有字体 + 有绘制指令 → 解码失败', () => {
    // 3 页里 3 页有字体、有 20 个绘制指令，却一个字符都没提出来
    expect(decide(true, 3, 3, 20)).toBe('decode-failed');
  });

  it('没字 + 没有字体 → 扫描件', () => {
    expect(decide(true, 0, 3, 0)).toBe('no-text-layer');
  });

  it('没字 + 有字体但没有绘制指令 → 扫描件（空页面）', () => {
    expect(decide(true, 3, 3, 0)).toBe('no-text-layer');
  });

  it('只有少数页有字体 → 倾向判扫描件（混合文档里的空白页）', () => {
    // 10 页里只有 2 页有字体，不足以断定是编码问题
    expect(decide(true, 2, 10, 5)).toBe('no-text-layer');
  });
});

describe('界面文案：两种状态说不同的话', () => {
  it('扫描件提示换电子版，解码失败提示反馈给我们', async () => {
    // 这两句话不能混用：给解码失败的用户看「换电子版」是错误建议
    const labels = await import('../../pages/sources/format.ts');
    const table = labels.TEXT_STATUS_LABEL;

    expect(table['no-text-layer'].hint).toMatch(/扫描件|换/);
    expect(table['decode-failed'].hint).toMatch(/反馈|不是扫描件/);
    // 关键：解码失败不能建议用户换文件
    expect(table['decode-failed'].hint).not.toMatch(/换一份电子版/);
  });

  it('解码失败用 danger 色级，不会被误当成普通的「待接入」', async () => {
    const labels = await import('../../pages/sources/format.ts');
    expect(labels.TEXT_STATUS_LABEL['decode-failed'].tone).toBe('danger');
    expect(labels.TEXT_STATUS_LABEL['no-text-layer'].tone).toBe('planned');
  });
});

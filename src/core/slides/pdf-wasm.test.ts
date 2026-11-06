import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * PDF 渲染必须提供 wasm 解码器。
 *
 * ## 锁的是一个「静默白板」缺陷
 *
 * 用户报告「628 页的教材只能看前两页」，实际第 1 页之后全是纯白图。
 * 控制台只有一行不起眼的警告：
 *
 *   "Ensure that the `wasmUrl` API parameter is provided."
 *   "getOperatorList - ignoring XObject: JBig2 failed to initialize"
 *
 * pdfjs 6 把 JBIG2 / JPX / ICC 的解码器移到了 wasm，
 * 不显式配置 `wasmUrl` 时图像被**静默跳过** —— 不抛错、界面无提示。
 *
 * 那份教材前两页是 DCTDecode（JPEG，纯 JS 可解），
 * 第 3 页起 597 页都是 JBIG2，于是全部渲染成白板。
 *
 * 这个缺陷特别难发现，因为所有常规检查都会「通过」：
 *   - <img> 元素存在 ✓
 *   - naturalWidth/Height = 1200×1749 ✓
 *   - PNG 数据有效、几十 KB ✓
 * 只有真的把图绘到 canvas 上采样像素，才会发现 nonWhiteRatio = 0。
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WASM_DIR = join(ROOT, 'public', 'wasm');
const SOURCE_PAGE = join(ROOT, 'src', 'core', 'slides', 'source-page.ts');

describe('PDF 渲染的 wasm 解码器', () => {
  it('源码里显式配置了 wasmUrl', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(SOURCE_PAGE, 'utf-8');
    expect(src).toContain('wasmUrl');
    // 必须有实际赋值，不能只有注释提到
    expect(/wasmUrl:\s*`/.test(src)).toBe(true);
  });

  it('public/wasm 下存在 JBIG2 解码器（扫描件最常见的格式）', () => {
    expect(existsSync(WASM_DIR)).toBe(true);
    expect(existsSync(join(WASM_DIR, 'jbig2.wasm'))).toBe(true);
  });

  it('同时提供纯 JS 回退版（老环境没有 wasm 时用）', () => {
    expect(existsSync(join(WASM_DIR, 'jbig2_nowasm_fallback.js'))).toBe(true);
  });

  it('JPX（JPEG2000）解码器也在', () => {
    expect(existsSync(join(WASM_DIR, 'openjpeg.wasm'))).toBe(true);
  });

  it('wasm 目录不为空且体积合理（不是占位文件）', () => {
    const files = readdirSync(WASM_DIR).filter((f) => f.endsWith('.wasm'));
    expect(files.length).toBeGreaterThan(0);
    const total = files.reduce((n, f) => n + statSync(join(WASM_DIR, f)).size, 0);
    // 全部 wasm 加起来应在几百 KB 到几 MB —— 太小说明是空文件
    expect(total).toBeGreaterThan(50_000);
    expect(total).toBeLessThan(20_000_000);
  });
});

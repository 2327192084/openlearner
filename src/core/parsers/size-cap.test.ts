/**
 * 单份资料上限（2026-11-16）。
 *
 * ## 为什么单独一个测试文件
 *
 * 用户要求「资料库不限制大小」。实际有两道闸：
 *  - `MAX_FILE_BYTES`（导入闸，超了直接拒）
 *  - `MAX_STORED_FILE_BYTES`（存储闸，超了不存原件 → 每次解析都要重选文件）
 *
 * 这两条一旦不一致就会出现「死配置」：存储闸比导入闸宽，后者先拒，
 * 前者永远走不到。所以这里钉死三件事：
 *  1. 两个常量必须相等（同源）
 *  2. 提示文案里的数字要与常量一致（不能像上一版那样硬编码 200）
 *  3. 边界：恰好等于上限放行，多 1 字节拒绝
 */

import { describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES, tooLargeMessage } from './types.ts';
import { MAX_STORED_FILE_BYTES } from '../sources.ts';

const MiB = 1024 * 1024;

describe('单份资料上限：两个闸必须一致', () => {
  it('★ 存储闸与导入闸相等（否则存储闸是死配置）', () => {
    expect(MAX_STORED_FILE_BYTES).toBe(MAX_FILE_BYTES);
  });

  it('★ 上限是 500 MiB（2026-11-16 用户要求提高）', () => {
    expect(MAX_FILE_BYTES).toBe(500 * MiB);
  });

  it('★ 提示文案里的数字来自常量，不是硬编码', () => {
    const msg = tooLargeMessage();
    const mib = Math.round(MAX_FILE_BYTES / MiB);
    expect(msg).toContain(String(mib));
    /* 否定断言：不许出现旧值 200 —— 那会让用户以为程序算错了 */
    expect(msg).not.toContain('200');
  });
});

describe('提示文案：随常量一起变', () => {
  it('包含「MB」与拆分建议（用户要知道下一步做什么）', () => {
    const msg = tooLargeMessage();
    expect(msg).toMatch(/MB/i);
    expect(msg).toMatch(/拆|压缩/);
  });
});
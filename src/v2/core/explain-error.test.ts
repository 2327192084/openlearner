import { describe, expect, it } from 'vitest';
import { explainError } from './explain-error.ts';

/**
 * 把 AI 错误说成人话。
 *
 * ## 这一层防的是什么
 *
 * 用户截图里报错显示的是：
 *   「网络请求失败：连不上该地址（fetch failed） (network)」
 *
 * 这句话对用户没有用 —— 他不知道下一步该干什么，也不知道
 * `fetch failed` 和 `network` 是不是两个不同的东西。
 *
 * 所以断言的重点不是「能返回一句文案」，而是**原始技术串不许出现在标题里**。
 */

describe('ApiError（带 code）', () => {
  it('**标题用白话，不用原始 message**', () => {
    const r = explainError(
      {
        code: 'network',
        message: '网络请求失败：连不上该地址（fetch failed） (network)',
        hint: '检查网络与接口地址',
      },
      '讲解生成失败',
    );
    expect(r.title).toBe('连不上 AI 服务');
    /* 原始技术串绝不能出现在标题里 */
    expect(r.title).not.toContain('fetch failed');
    expect(r.title).not.toContain('network');
  });

  it('带上服务商给的建议（那本来就是人话）', () => {
    const r = explainError({ code: 'network', message: 'x', hint: '检查三件事' }, 'fb');
    expect(r.hint).toBe('检查三件事');
  });

  it('hint 为空时不编一个', () => {
    const r = explainError({ code: 'network', message: 'x', hint: '   ' }, 'fb');
    expect(r.hint).toBeNull();
  });

  it('各种 code 都有白话标题（不会漏成 fallback）', () => {
    for (const code of [
      'network',
      'invalid-key',
      'forbidden',
      'rate-limited',
      'insufficient-balance',
      'server-error',
      'bad-request',
      'aborted',
      'unknown',
    ]) {
      const r = explainError({ code, message: 'raw', hint: 'h' }, '兜底');
      expect(r.title).not.toBe('兜底');
      expect(r.title.length).toBeGreaterThan(0);
    }
  });
});

describe('普通 Error（无 code）', () => {
  it('我们自己 throw 的人话 → 原样用', () => {
    const r = explainError(new Error('这道题已经不在了（可能被删了）'), '兜底');
    expect(r.title).toBe('这道题已经不在了（可能被删了）');
    expect(r.hint).toBeNull();
  });

  it('**浏览器原始 fetch 失败 → 换成「连不上 AI 服务」并给检查建议**', () => {
    for (const raw of [
      'TypeError: Failed to fetch',
      '网络请求失败（fetch failed）',
      'timeout of 60000ms exceeded',
      'connect ETIMEDOUT',
      'ECONNREFUSED',
      'SSL handshake failed',
    ]) {
      const r = explainError(new Error(raw), '兜底');
      expect(r.title).toBe('连不上 AI 服务');
      expect(r.hint).toContain('接口地址');
      /* 技术串不能漏出来 */
      expect(r.title).not.toMatch(/fetch|timeout|ETIMEDOUT|ECONNREFUSED|SSL/i);
    }
  });

  it('完全认不出 / 空错误 → 用兜底文案', () => {
    expect(explainError(null, '讲解生成失败').title).toBe('讲解生成失败');
    expect(explainError({}, '讲解生成失败').title).toBe('讲解生成失败');
    expect(explainError(new Error(''), '讲解生成失败').title).toBe('讲解生成失败');
  });
});
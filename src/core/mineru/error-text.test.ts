/**
 * MinerU 错误信息的可读化（2026-11-11）。
 *
 * ## 为什么有这份测试
 *
 * 用户实测看到的提示是一整段原始 JSON：
 *
 *   MinerU 退出码 1。最后的日志：{"error":{"type":"api_error",
 *   "code":"server_not_running","message":"本地 mineru 服务未运行。
 *   请先运行 'mineru server start'。","param":null}}
 *
 * 信息其实都在，但塞在一段 JSON 里，用户得自己从花括号里挑出来。
 *
 * ## 为什么同一组用例跑两份实现
 *
 * 实现有两处：
 *  - `src/core/mineru/error-text.ts`（纯函数，渲染层可用）
 *  - `electron/mineru.cjs` 里的同名函数（主进程实际调用的那份）
 *
 * 跨进程共享纯函数需要把 core 也编译给主进程，收益不抵成本。
 * 所以两边各留一份等价实现，**由这同一组用例同时校验** ——
 * 任何一边改了行为（哪怕只改一边）都会红。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { summarizeMineruError, isServerNotRunning } from './error-text.ts';

/**
 * 从 `electron/mineru.cjs` 里把同名函数取出来。
 *
 * 不直接 import：vite 的模块图不允许从 src 引 electron 下的文件
 * （试过，报「Failed to load url」）。
 * 但这份测试必须覆盖主进程那份实现 —— 那才是用户实际撞到的代码。
 * 所以用**读源码 + 求值**的方式取它：
 * 截取函数体，在沙箱里跑。这样两份实现都能被同一组断言钉住。
 */
function loadMainProcessImpl(): (raw: unknown) => string {
  const file = path.join(process.cwd(), 'electron', 'mineru.cjs');
  const src = readFileSync(file, 'utf8');

  const start = src.indexOf('function summarizeMineruError(');
  if (start < 0) throw new Error('electron/mineru.cjs 里找不到 summarizeMineruError');

  /*
   * 从 start 开始做花括号配对，截出完整函数体。
   *
   * ⚠️ 必须跳过字符串字面量与注释里的括号 —— 函数体里有
   * `text[i] === '{'` 这种字符字面量，朴素计数会把它们当成真括号，
   * 于是永远配不平（第一版就是这么失败的）。
   */
  let depth = 0;
  let end = -1;
  let seenBrace = false;
  let quote: string | null = null;

  for (let i = start; i < src.length; i += 1) {
    const ch = src[i]!;
    const prev = i > start ? src[i - 1] : '';

    if (quote) {
      /* 字符串内：处理转义与闭合 */
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    /* 行注释：跳到行尾 */
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    /* 块注释 */
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }

    if (ch === '{') {
      depth += 1;
      seenBrace = true;
    } else if (ch === '}') {
      depth -= 1;
      if (seenBrace && depth === 0) {
        end = i + 1;
        break;
      }
    }
    void prev;
  }
  if (end < 0) throw new Error('函数体不完整');

  const fnSrc = src.slice(start, end);
  /* eslint-disable no-new-func */
  return new Function(`${fnSrc}; return summarizeMineruError;`)() as (raw: unknown) => string;
}

const mainImpl = loadMainProcessImpl();

/** 用户实测那一例（原始 JSON） */
const REAL_ERROR =
  '{"error":{"type":"api_error","code":"server_not_running",' +
  '"message":"本地 mineru 服务未运行。请先运行 \'mineru server start\'。","param":null}}';

/* 两份实现跑同一组用例 */
for (const [label, fn] of [
  ['core 版', summarizeMineruError],
  ['主进程版', mainImpl],
] as const) {
  describe(`summarizeMineruError（${label}）`, () => {
    it('★ 从 api_error JSON 里剥出 message（用户实测那一例）', () => {
      const out = fn(REAL_ERROR);
      expect(out).toContain('本地 mineru 服务未运行');
      /* 不该把整个 JSON 原样吐回来 */
      expect(out).not.toContain('"type"');
      expect(out).not.toContain('{');
    });

    it('从 {"message":...} 里剥出 message', () => {
      expect(fn('{"message":"文件损坏"}')).toBe('文件损坏');
    });

    it('JSON 前后有别的日志行时也能找到它', () => {
      expect(fn('some log line\n{"error":{"message":"页数超出限制"}}\ntrailing')).toBe(
        '页数超出限制',
      );
    });

    it('不是 JSON 时取最后一行非空文本', () => {
      expect(fn('line one\nline two\n\n  final line  \n')).toBe('final line');
    });

    it('只有 code 没有 message 时退回 code', () => {
      expect(fn('{"error":{"code":"bad_output"}}')).toBe('bad_output');
    });

    it('空输入给一句如实的占位，不抛', () => {
      expect(fn('')).toBe('没有更多信息');
      expect(fn('   ')).toBe('没有更多信息');
    });

    it('超长非 JSON 文本会被截断，不把整段糊到界面上', () => {
      const out = fn('x'.repeat(500));
      expect(out.length).toBeLessThanOrEqual(161);
      expect(out.endsWith('…')).toBe(true);
    });

    it('括号不配对的残缺 JSON 不会卡死，也不抛', () => {
      const raw = '{"error":{"message":"没闭合';
      expect(() => fn(raw)).not.toThrow();
      expect(fn(raw).length).toBeGreaterThan(0);
    });
  });
}

describe('两份实现行为一致（防止只改一边）', () => {
  const samples = [
    REAL_ERROR,
    '{"message":"文件损坏"}',
    'plain text only',
    '',
    '{"error":{"code":"x"}}',
    'a\nb\nc',
  ];
  for (const s of samples) {
    it(`输入 ${JSON.stringify(s.slice(0, 24))} 两版结果相同`, () => {
      expect(mainImpl(s)).toBe(summarizeMineruError(s));
    });
  }
});

describe('isServerNotRunning', () => {
  it('★ 认出用户实测那条', () => {
    expect(isServerNotRunning(REAL_ERROR)).toBe(true);
  });

  it('认中文提示', () => {
    expect(isServerNotRunning('本地 mineru 服务未运行')).toBe(true);
  });

  it('不把无关错误误判成服务未启动', () => {
    expect(isServerNotRunning('{"error":{"message":"文件损坏"}}')).toBe(false);
    expect(isServerNotRunning('')).toBe(false);
  });
});

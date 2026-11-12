/**
 * 本地解析服务自动启用 + 提示完整性（2026-11-12）。
 *
 * ## 用户反馈
 *
 * 「没事，我可以手动敲命令，但是你要告诉用户怎么做，你这个命令给的不完整。」
 *
 * 原提示写的是「到 MinerU 的安装目录执行两条命令」——
 * 一个普通用户根本不知道：
 *  - 「安装目录」是哪个（绿色版 / D 盘 / StudyHub 里的那份）
 *  - 直接敲 `mineru ...` 会得到「不是内部或外部命令」（不在 PATH）
 *
 * 这些断言守的就是「提示必须能被一个不懂命令行的用户照做」。
 */
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error 这是 .cjs，没有类型声明；测试只为运行行为
import engine from '../../../electron/mineru.cjs';

const { tryEnableLocalParseServer, runMineru } = engine as {
  tryEnableLocalParseServer: (
    exePath: string,
    spawnImpl: unknown,
  ) => Promise<{ ok: boolean; error?: string; needsModels?: boolean }>;
  runMineru: (
    req: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<{ ok: boolean; message?: string; trouble?: string } | null>;
};

/** 造一个假的 spawn：按调用顺序返回预设的退出码与输出 */
function fakeSpawn(results: Array<{ code: number; out?: string }>) {
  let i = 0;
  return vi.fn(() => {
    const r = results[i++] ?? { code: 0 };
    const handlers: Record<string, ((a?: unknown) => void)[]> = {};
    const child = {
      stdout: {
        /* 把预设的输出吐给监听者 —— 不带这一层，tryEnableLocalParseServer
           拿到的 out 是空串，错误信息就只剩「退出码 1」 */
        on: (_ev: string, fn: (a?: unknown) => void) => {
          (handlers.stdout_ev ||= []).push(() => {
            if (r.out) fn(Buffer.from(r.out));
          });
        },
      },
      stderr: { on: () => {} },
      kill: () => {},
      on: (ev: string, fn: (a?: unknown) => void) => {
        (handlers[ev] ||= []).push(fn);
      },
    };
    /* 下一拍触发输出与 close，模拟子进程结束 */
    setTimeout(() => {
      for (const fn of handlers.stdout_ev ?? []) (fn as () => void)();
      for (const fn of handlers.close ?? []) fn(r.code);
    }, 0);
    return child;
  });
}

describe('tryEnableLocalParseServer：先自己修，不让用户动手', () => {
  it('★ 两条配置都成功 → ok', async () => {
    const spawn = fakeSpawn([{ code: 0 }, { code: 0 }]);
    const r = await tryEnableLocalParseServer('C:\\m\\mineru.exe', spawn);
    expect(r.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('★ 用的正是官方 config set 子命令（不是手写 yaml）', async () => {
    const calls: string[][] = [];
    const spawn = vi.fn((_exe: string, args: string[]) => {
      calls.push(args);
      const handlers: Record<string, ((a?: unknown) => void)[]> = {};
      const child = {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        kill: () => {},
        on: (ev: string, fn: (a?: unknown) => void) => {
          (handlers[ev] ||= []).push(fn);
        },
      };
      setTimeout(() => {
        for (const fn of handlers.close ?? []) fn(0);
      }, 0);
      return child;
    });
    await tryEnableLocalParseServer('C:\\m\\mineru.exe', spawn);
    expect(calls[0]).toEqual(['config', 'set', 'parse_server.local.mode', 'managed']);
    expect(calls[1]).toEqual(['config', 'set', 'parse_server.local.managed_tier', 'basic']);
  });

  it('第一条失败 → 返回 ok:false 并带出原因（让上层能告诉用户）', async () => {
    const spawn = fakeSpawn([{ code: 1, out: '权限不足' }]);
    const r = await tryEnableLocalParseServer('C:\\m\\mineru.exe', spawn);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('权限不足');
  });

  it('★ 第二条失败不阻断：mode 已 managed 就能跑', async () => {
    /*
     * 为什么要这样：tier 只决定速度/准确度，默认值也能工作。
     * 因为 tier 没设上就整体报失败，会让用户卡在一个其实能用的状态。
     */
    const spawn = fakeSpawn([{ code: 0 }, { code: 1, out: 'tier 写不进去' }]);
    const r = await tryEnableLocalParseServer('C:\\m\\mineru.exe', spawn);
    expect(r.ok).toBe(true);
    expect(r.error).toContain('tier');
  });

  it('启动就抛异常（比如 exe 不存在）→ ok:false，不炸', async () => {
    const spawn = vi.fn(() => {
      throw new Error('ENOENT');
    });
    const r = await tryEnableLocalParseServer('C:\\no\\mineru.exe', spawn);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('★ 模型不齐导致的失败要标 needsModels（否则用户照着 config 命令永远修不好）', async () => {
    /*
     * 实测（2026-11-12，真实 MinerU）：
     *   mineru config set parse_server.local.mode managed
     *   → MinerU-4_models_onnx missing: Table/unet.onnx ...
     *     Run: mineru-kit models download --tier standard
     *
     * 也就是说 config set 在写配置前会先校验模型完整性。
     * 不区分这一层，提示就只会叫用户敲 config 命令 —— 白敲。
     */
    const spawn = fakeSpawn([
      {
        code: 1,
        out: 'MinerU-4_models_onnx missing: Table/unet.onnx. Run: mineru-kit models download --tier standard',
      },
    ]);
    const r = await tryEnableLocalParseServer('C:\\m\\mineru.exe', spawn);
    expect(r.ok).toBe(false);
    expect(r.needsModels).toBe(true);
  });

  it('普通失败不误标 needsModels', async () => {
    const spawn = fakeSpawn([{ code: 1, out: '权限不足' }]);
    const r = await tryEnableLocalParseServer('C:\\m\\mineru.exe', spawn);
    expect(r.needsModels).toBeFalsy();
  });
});

describe('★ 自修失败时的提示：必须完整到能照做', () => {
  /**
   * 让 runMineru 走进 server-disabled 分支：
   *  - spawn 第一次是 config set（故意失败，强制走提示路径）
   *  - 第二次是 parse，返回非 0 且 stderr 含 disabled
   *
   * 这里只断言「提示文本」，不真的跑 MinerU。
   */
  async function getMessage(exePath: string): Promise<string> {
    /*
     * ⚠️ 必须按 **args 内容**判断是哪一次调用，不能只数次数。
     *
     * 我第一版用 call 计数，结果 5 个断言全挂在「拿到的不是这条消息」：
     * 因为 `config set` 内部本身也可能多次 spawn，
     * 计数与「第几次是 parse」对不上。
     * 按 args[0] 判断（'config' vs 'parse'）才稳。
     */
    const spawn = vi.fn((_exe: string, args: string[]) => {
      const isConfig = args && args[0] === 'config';
      const handlers: Record<string, ((a?: unknown) => void)[]> = {};
      const child = {
        stdout: { on: () => {} },
        stderr: {
          on: (ev: string, fn: (a?: unknown) => void) => {
            (handlers['stderr_' + ev] ||= []).push(fn);
          },
        },
        kill: () => {},
        on: (ev: string, fn: (a?: unknown) => void) => {
          (handlers[ev] ||= []).push(fn);
        },
      };
      setTimeout(() => {
        if (isConfig) {
          /* config set 全部失败，逼出「自修失败」的提示路径 */
          for (const fn of handlers.close ?? []) fn(1);
        } else {
          /*
           * parse：**必须先触发 stderr data 再 close**。
           * 顺序反了 stderrTail 还是空的，走不到 server-disabled 分支。
           */
          for (const fn of handlers.stderr_data ?? []) {
            fn(Buffer.from('Error: Local parse-server is disabled\n'));
          }
          for (const fn of handlers.close ?? []) fn(1);
        }
      }, 0);
      return child;
    });

    const r = await runMineru(
      { filePath: 'C:\\x.pdf', outDir: 'C:\\out', tier: 'standard', pages: 'all' },
      { exePath, spawnImpl: spawn, waitSec: 1 },
    );
    return r && r.message ? String(r.message) : '';
  }

  it('★ 命令带绝对路径与引号（用户直接复制就能跑）', async () => {
    const msg = await getMessage('E:\\StudyHub\\MinerU\\venv\\Scripts\\mineru.exe');
    expect(msg).toContain('"E:\\StudyHub\\MinerU\\venv\\Scripts\\mineru.exe" config set parse_server.local.mode managed');
    expect(msg).toContain('parse_server.local.managed_tier');
  });

  it('★ 说清「在哪敲」（Win+R → cmd）', async () => {
    const msg = await getMessage('C:\\any\\mineru.exe');
    expect(msg).toContain('Win+R');
    expect(msg).toContain('cmd');
  });

  it('★ 说清「敲完做什么」（重启软件）', async () => {
    const msg = await getMessage('C:\\any\\mineru.exe');
    expect(msg).toMatch(/重新打开|重启/);
  });

  it('★ 解释 tier 是什么，别让用户盲选', async () => {
    const msg = await getMessage('C:\\any\\mineru.exe');
    expect(msg).toContain('basic');
    expect(msg).toMatch(/standard|advanced/);
    expect(msg).toMatch(/快|准/);
  });
});

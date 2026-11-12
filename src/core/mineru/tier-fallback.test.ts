/**
 * 档位不被支持时自动降级（2026-11-12）。
 *
 * ## 用户报的错
 *
 *   MinerU 退出码 1，转换没有成功。
 *   大致原因：Tier 'standard' not supported by parse-server.
 *   Available: ['flash', 'basic']
 *
 * ## 为什么会有这个错
 *
 * 前端曾经写死 `tier: 'standard'`。但本地 parse-server 支持哪些档位，
 * 取决于它加载了哪些模型 —— 用户的机器上只支持 flash/basic。
 *
 * ## 修法两层
 *
 * 1. 不再写死：前端不传 tier，主进程默认 'basic'
 * 2. 真遇到不支持时**自动降级**：错误信息里已经给了可用列表，
 *    直接挑一个能跑的用 —— 用户根本不知道「档位」是什么，
 *    让他去改这个概念不合理
 *
 * 本测试钉住第 2 层。
 */
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error 这是 .cjs，没有类型声明；测试只为运行行为
import engine from '../../../electron/mineru.cjs';

const { runMineru } = engine as {
  runMineru: (
    req: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => Promise<{ ok: boolean; message?: string; result?: { markdown?: string } } | null>;
};

/**
 * 造一个假 spawn：指定档位失败，其它档位成功写出 markdown。
 *
 * @param available 服务声称支持的档位
 * @param failTier  哪个档位会失败（传 'ALL_FAIL' 表示全失败）
 * @param outDir    成功时把 converted.md 写到这里
 */
function fakeSpawn(available: string[], failTier: string, outDir: string) {
  const seenTiers: string[] = [];
  const path = require('node:path');
  const fs = require('node:fs');

  const spawn = vi.fn((_exe: string, args: string[]) => {
    const tierAt = args.indexOf('--tier');
    const tier = tierAt >= 0 ? args[tierAt + 1] : '';
    seenTiers.push(tier);

    const handlers: Record<string, ((a?: unknown) => void)[]> = {};
    const child = {
      stdout: { on: () => {} },
      stderr: {
        /*
         * ⚠️ `on` 的第一个参数是**事件名**（'data'），不是数据。
         * 我第一版把 fn 收进 handlers.err 却没区分事件名，
         * 结果 stderrTail 一直是空的，降级分支永不进入。
         */
        on: (ev: string, fn: (a?: unknown) => void) => {
          if (ev === 'data') (handlers.err ||= []).push(fn);
        },
      },
      kill: () => {},
      on: (ev: string, fn: (a?: unknown) => void) => {
        (handlers[ev] ||= []).push(fn);
      },
    };

    setTimeout(() => {
      if (failTier === 'ALL_FAIL' || tier === failTier) {
        for (const fn of handlers.err ?? []) {
          fn(
            Buffer.from(
              `Error: Tier '${tier}' not supported by parse-server. ` +
                `Available: [${available.map((t) => `'${t}'`).join(', ')}]\n`,
            ),
          );
        }
        for (const fn of handlers.close ?? []) fn(1);
        return;
      }
      /*
       * 成功：**这时才写文件**。
       *
       * 主进程的判定是「输出文件里有内容就算成功（不看退出码）」——
       * 所以不能在测试开始时预先写，否则第一次 spawn 就判成功，
       * 根本走不到降级分支。
       */
      fs.writeFileSync(path.join(outDir, 'converted.md'), '<!-- page 1 of 1 -->\n\n内容\n');
      for (const fn of handlers.close ?? []) fn(0);
    }, 0);
    return child;
  });
  return { spawn, seenTiers };
}

describe('★ 档位不被支持时自动降级', () => {
  it('standard 不支持、basic 支持 → 自动改用 basic 重试', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-'));

    /*
     * ⚠️ 不要预先写 converted.md。
     *
     * 主进程的判定是「输出文件里有内容就算成功（不看退出码）」——
     * 这是有意的（实测 mineru 有时报错但退出码 0）。
     * 但我第一版在测试里先写了这个文件，于是第一次 spawn 后就判成功、
     * 根本走不到降级分支，把自己测成了「降级没生效」。
     *
     * 正确做法：让假 spawn 在**降级之后**才写出文件。
     */
    const { spawn, seenTiers } = fakeSpawn(['flash', 'basic'], 'standard', dir);

    const r = await runMineru(
      { filePath: 'C:\\x.pdf', outDir: dir, tier: 'standard', pages: 'all' },
      { exePath: 'C:\\m\\mineru.exe', spawnImpl: spawn, waitSec: 1 },
    );

    /* 第一次用 standard 失败，第二次改成 basic */
    expect(seenTiers[0]).toBe('standard');
    expect(seenTiers[1]).toBe('basic');
    expect(r?.ok).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('★ 优先选 basic，而不是列表第一个（flash 质量最差）', async () => {
    /*
     * 服务给的是 ['flash', 'basic']。若按列表顺序取，会选 flash ——
     * 那是「极快但最糙」的一档，用户没要求时不该默认给最低质量。
     */
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-'));

    const { spawn, seenTiers } = fakeSpawn(['flash', 'basic'], 'standard', dir);
    await runMineru(
      { filePath: 'C:\\x.pdf', outDir: dir, tier: 'standard', pages: 'all' },
      { exePath: 'C:\\m\\mineru.exe', spawnImpl: spawn, waitSec: 1 },
    );

    expect(seenTiers[1]).toBe('basic');
    expect(seenTiers).not.toContain('flash');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('★ 只降级一次，不会无限重试', async () => {
    /*
     * 若服务对每个档位都报不支持，无限重试会让界面一直转。
     * 这里让**所有**档位都失败，确认调用次数有界。
     */
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-'));

    const { spawn, seenTiers } = fakeSpawn(['flash', 'basic'], 'ALL_FAIL', dir);

    const r = await runMineru(
      { filePath: 'C:\\x.pdf', outDir: dir, tier: 'advanced', pages: 'all' },
      { exePath: 'C:\\m\\mineru.exe', spawnImpl: spawn, waitSec: 1 },
    );

    expect(seenTiers.length).toBeLessThanOrEqual(2);
    expect(r?.ok).toBe(false);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

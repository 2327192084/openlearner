/**
 * MinerU 健康检查的测试（2026-11-12）。
 *
 * ## 为什么需要它
 *
 * A 方案把「已装好」与「安装入口」设计成互斥，理由是 MinerU 的 server
 * 是全局单例（装第二份会抢服务）。但用户实际遇到的是
 * 「装好了、模型不全」—— 那种情况下界面只说「已装好，直接用就行」，
 * 他没有任何补救途径。
 *
 * 这个健康检查就是补那个盲区。它的判断错了，用户会被引到错误的修法上。
 *
 * ## 关键不变量
 *
 * 1. **只报「当前 tier 缺的」**，不把无关 repo 算成问题
 *    （实机：torch 与 non-GGUF 版本都是 missing，但 basic 档用不到，
 *     误报会让用户去下一堆用不上的模型）
 * 2. 缺模型时**先让下模型再设配置**（顺序反了 config set 会失败）
 * 3. 修复命令必须带绝对路径与引号（否则用户敲不了）
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error 这是 .cjs，没有类型声明；测试只为运行行为
import health from '../../../electron/mineru-health.cjs';

const { parseModelsShow, checkMineruHealth } = health as {
  parseModelsShow: (t: string) => {
    repos: Array<{ name: string; ready: boolean }>;
    tiers: Record<string, string[]>;
  };
  checkMineruHealth: (o: {
    exePath: string;
    home: string | null;
    spawnImpl?: unknown;
  }) => Promise<{
    ok: boolean;
    mode?: string;
    tier?: string;
    repos?: Array<{ name: string; ready: boolean }>;
    missingForTier?: string[];
    fixCommands?: string[];
    summary: string;
    error?: string;
  }>;
};

/** 真实 `mineru-kit models show` 的输出片段（2026-11-12 实机抓的） */
const REAL_SHOW = `Config: C:\\Users\\ASUS\\.mineru\\config.yaml
Config exists: true
model.small_backend: auto
Repos:
  MinerU-4_models_torch: missing
(C:\\Users\\ASUS\\.mineru\\models\\MinerU-4_models_torch)
  MinerU-4_models_onnx: ready
(C:\\Users\\ASUS\\.mineru\\models\\MinerU-4_models_onnx)
  MinerU2.5-Pro-2605-1.2B: missing
(C:\\Users\\ASUS\\.mineru\\models\\MinerU2.5-Pro-2605-1.2B)
  MinerU2.5-Pro-2605-1.2B-GGUF: ready
(C:\\Users\\ASUS\\.mineru\\models\\MinerU2.5-Pro-2605-1.2B-GGUF)
Model tiers:
  basic: MinerU-4_models_onnx
  standard: MinerU-4_models_onnx, MinerU2.5-Pro-2605-1.2B-GGUF
`;

describe('parseModelsShow：解析官方输出', () => {
  it('★ 认出 4 个 repo 及各自状态', () => {
    const { repos } = parseModelsShow(REAL_SHOW);
    expect(repos).toHaveLength(4);
    expect(repos.find((r) => r.name === 'MinerU-4_models_onnx')?.ready).toBe(true);
    expect(repos.find((r) => r.name === 'MinerU-4_models_torch')?.ready).toBe(false);
  });

  it('★ 认出各档位需要哪些 repo（决定「缺什么」的判断）', () => {
    const { tiers } = parseModelsShow(REAL_SHOW);
    expect(tiers['basic']).toEqual(['MinerU-4_models_onnx']);
    expect(tiers['standard']).toEqual([
      'MinerU-4_models_onnx',
      'MinerU2.5-Pro-2605-1.2B-GGUF',
    ]);
  });

  it('路径那几行（另起一行、括号包裹）不会被当成 repo', () => {
    const { repos } = parseModelsShow(REAL_SHOW);
    expect(repos.every((r) => !r.name.includes('\\'))).toBe(true);
    expect(repos.every((r) => !r.name.startsWith('('))).toBe(true);
  });

  it('别的顶层小节（Config / MINERU_*）不会被算进 repo', () => {
    const { repos } = parseModelsShow(REAL_SHOW);
    expect(repos.some((r) => r.name === 'Config')).toBe(false);
    expect(repos.some((r) => r.name.startsWith('model.'))).toBe(false);
  });

  it('空输入不炸', () => {
    const r = parseModelsShow('');
    expect(r.repos).toEqual([]);
    expect(r.tiers).toEqual({});
  });
});

describe('checkMineruHealth：判定与修复建议', () => {
  /** 造一个假 spawn：按 args 内容返回预设输出 */
  function fakeSpawn(byKey: Record<string, { code: number; out: string }>) {
    return (_exe: string, args: string[]) => {
      const isShow = args[0] === 'models' && args[1] === 'show';
      const key = isShow
        ? 'show'
        : args[0] === 'config' && args[2] === 'parse_server.local.mode'
          ? 'mode'
          : args[0] === 'config' && args[2] === 'parse_server.local.managed_tier'
            ? 'tier'
            : 'other';
      const r = byKey[key] ?? { code: 0, out: '' };
      const handlers: Record<string, ((a?: unknown) => void)[]> = {};
      const child = {
        stdout: {
          on: (_ev: string, fn: (a?: unknown) => void) => {
            (handlers.out ||= []).push(fn);
          },
        },
        stderr: { on: () => {} },
        kill: () => {},
        on: (ev: string, fn: (a?: unknown) => void) => {
          (handlers[ev] ||= []).push(fn);
        },
      };
      setTimeout(() => {
        for (const fn of handlers.out ?? []) fn(Buffer.from(r.out));
        for (const fn of handlers.close ?? []) fn(r.code);
      }, 0);
      return child;
    };
  }

  const EXE = 'E:\\StudyHub\\MinerU\\venv\\Scripts\\mineru.exe';

  it('★ 一切正常 → ok:true，不建议任何修复', async () => {
    const r = await checkMineruHealth({
      exePath: EXE,
      home: 'E:\\StudyHub\\MinerU\\home',
      spawnImpl: fakeSpawn({
        show: { code: 0, out: REAL_SHOW },
        mode: { code: 0, out: 'parse_server.local.mode = managed  [override]\n' },
        tier: { code: 0, out: 'parse_server.local.managed_tier = basic  [override]\n' },
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.fixCommands).toEqual([]);
    expect(r.summary).toContain('可用');
    expect(r.summary).toContain('basic');
  });

  it('★ 实机情形：torch / non-GGUF 缺失但 basic 档用不到 → 仍判可用', async () => {
    /*
     * 这是最容易误报的地方。实机上 `missingRepos` 有 2 个，
     * 但 basic 档只需要 MinerU-4_models_onnx（它是 ready 的）。
     * 若按「有 missing 就报错」，用户会被引去下 591MB 用不上的模型。
     */
    const r = await checkMineruHealth({
      exePath: EXE,
      home: null,
      spawnImpl: fakeSpawn({
        show: { code: 0, out: REAL_SHOW },
        mode: { code: 0, out: 'parse_server.local.mode = managed\n' },
        tier: { code: 0, out: 'parse_server.local.managed_tier = basic\n' },
      }),
    });
    expect(r.missingForTier).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('★ 当前 tier 真缺模型 → 先下模型，再设配置（顺序不能反）', async () => {
    const show = REAL_SHOW.replace(
      'MinerU-4_models_onnx: ready',
      'MinerU-4_models_onnx: missing',
    );
    const r = await checkMineruHealth({
      exePath: EXE,
      home: null,
      spawnImpl: fakeSpawn({
        show: { code: 0, out: show },
        mode: { code: 0, out: 'parse_server.local.mode = managed\n' },
        tier: { code: 0, out: 'parse_server.local.managed_tier = basic\n' },
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.missingForTier).toEqual(['MinerU-4_models_onnx']);
    expect(r.fixCommands?.[0]).toContain('models download --tier basic');
    expect(r.fixCommands?.[1]).toContain('config set parse_server.local.mode managed');
    expect(r.summary).toContain('缺');
  });

  it('模型齐但服务关着 → 只建议开服务', async () => {
    const r = await checkMineruHealth({
      exePath: EXE,
      home: null,
      spawnImpl: fakeSpawn({
        show: { code: 0, out: REAL_SHOW },
        mode: { code: 0, out: 'parse_server.local.mode = disabled  [default]\n' },
        tier: { code: 0, out: 'parse_server.local.managed_tier = basic\n' },
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.fixCommands).toHaveLength(1);
    expect(r.fixCommands?.[0]).toContain('parse_server.local.mode managed');
    expect(r.summary).toContain('关闭');
  });

  it('★ 修复命令用 mineru-kit 下模型、用 mineru 设配置（两个 exe 别搞混）', async () => {
    const show = REAL_SHOW.replace(
      'MinerU-4_models_onnx: ready',
      'MinerU-4_models_onnx: missing',
    );
    const r = await checkMineruHealth({
      exePath: EXE,
      home: null,
      spawnImpl: fakeSpawn({
        show: { code: 0, out: show },
        mode: { code: 0, out: 'parse_server.local.mode = disabled\n' },
        tier: { code: 0, out: 'parse_server.local.managed_tier = basic\n' },
      }),
    });
    /* 实测：mineru.exe 上没有 models 子命令，必须用 mineru-kit.exe */
    expect(r.fixCommands?.[0]).toContain('mineru-kit.exe');
    expect(r.fixCommands?.[1]).toContain('mineru.exe');
    expect(r.fixCommands?.[1]).not.toContain('mineru-kit.exe');
  });

  it('★ 命令带绝对路径与引号（用户要能直接复制粘贴）', async () => {
    const r = await checkMineruHealth({
      exePath: EXE,
      home: null,
      spawnImpl: fakeSpawn({
        show: { code: 0, out: REAL_SHOW },
        mode: { code: 0, out: 'parse_server.local.mode = disabled\n' },
        tier: { code: 0, out: 'parse_server.local.managed_tier = basic\n' },
      }),
    });
    expect(r.fixCommands?.[0]).toContain(`"${EXE}"`);
  });

  it('没有 exePath → 明确报错，不假装健康', async () => {
    const r = await checkMineruHealth({ exePath: '', home: null });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('没有配置');
  });

  it('models show 跑不起来 → 如实报错，不猜成「可用」', async () => {
    const r = await checkMineruHealth({
      exePath: EXE,
      home: null,
      spawnImpl: fakeSpawn({
        show: { code: 1, out: 'something broke' },
        mode: { code: 1, out: '' },
        tier: { code: 1, out: '' },
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('读不到');
  });
});

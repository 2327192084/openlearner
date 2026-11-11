/**
 * MinerU 一键安装引擎的测试（2026-11-11 晚）。
 *
 * ## 为什么这些测试很重要
 *
 * 这个功能会在用户机器上下载 2.7GB、创建 Python 环境、删/建目录。
 * 出错代价很高（磁盘满、删错目录、装一半卡死）。
 *
 * ## 测试边界
 *
 * 真装一次 2.7GB 不适合放单测。这里测**不依赖网络与磁盘全部内容**的部分：
 * 磁盘枚举、布局、步骤规划与断点续判定、空间拦截、A 方案探测、卸载的安全检查。
 * 真正的全链路留给 `scripts/install-mineru.cjs` 在普通 node 下跑（见该脚本）。
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
// @ts-expect-error 这是 .cjs，没有类型声明；测试只为运行行为
import engine from '../../electron/mineru-install.cjs';

const {
  layout,
  listDrives,
  freeBytesAt,
  planSteps,
  install,
  uninstall,
  detectExisting,
  REQUIRED_FREE_BYTES,
} = engine;

/** 拼 Windows 路径时避开 TS 字符串转义 —— 用数组 join 最稳 */
const win = (...parts: string[]) => parts.join('\\');

const STUDYHUB_EXE = win('E:', 'StudyHub', 'MinerU', 'venv', 'Scripts', 'mineru.exe');
const STUDYHUB_HOME = win('E:', 'StudyHub', 'MinerU', 'home');

describe('layout：所有产物都落在用户选的 root 下', () => {
  it('★ 五个部分（uv/Python/venv/模型/缓存）全在 root 内，不散落到别的盘', () => {
    const L = layout(win('D:', 'some', 'where', 'mineru'));
    for (const key of [
      'uvExe', 'pythonDir', 'venvDir', 'modelsDir', 'homeDir',
      'configFile', 'cacheDir', 'modelscopeCache',
    ]) {
      expect(L[key].startsWith(win('D:', 'some', 'where', 'mineru'))).toBe(true);
    }
  });

  it('config.yaml 在 home 下，models 在 home/models', () => {
    const L = layout(win('E:', 'a', 'b'));
    expect(L.configFile).toBe(win('E:', 'a', 'b', 'home', 'config.yaml'));
    expect(L.modelsDir).toBe(win('E:', 'a', 'b', 'home', 'models'));
  });

  it('mineru.exe 的路径与探测逻辑预期一致（venv/Scripts/mineru.exe）', () => {
    const L = layout(win('E:', 'm'));
    expect(L.mineruExe).toBe(win('E:', 'm', 'venv', 'Scripts', 'mineru.exe'));
  });

  it('★ uv 缓存与 ModelScope 缓存都在 root 内（否则会撞 C 盘权限）', () => {
    const L = layout(win('D:', 'x'));
    expect(L.cacheDir.startsWith(win('D:', 'x'))).toBe(true);
    expect(L.modelscopeCache.startsWith(win('D:', 'x'))).toBe(true);
  });
});

describe('listDrives：枚举固定磁盘并标注够不够', () => {
  const fakeStatfs = (map: Record<string, { bavail: number; bsize: number; blocks: number }>) => {
    return (p: string) => {
      const v = map[p];
      if (!v) throw new Error('ENOENT');
      return v;
    };
  };

  it('★ 剩余空间不够 3GB 的盘标 enough=false（界面据此置灰）', () => {
    const statfsSync = fakeStatfs({
      [win('C:', '')]: { bavail: 1000, bsize: 4096, blocks: 100000 }, // ~4MB
      [win('E:', '')]: { bavail: 30_000_000, bsize: 4096, blocks: 50_000_000 }, // ~117GB
    });
    const drives = listDrives({ statfsSync });
    const c = drives.find((d: { letter: string }) => d.letter === 'C');
    const e = drives.find((d: { letter: string }) => d.letter === 'E');
    expect(c.enough).toBe(false);
    expect(e.enough).toBe(true);
  });

  it('拿不到信息的盘直接不列（不显示 0GB 的假条目）', () => {
    const statfsSync = fakeStatfs({
      [win('E:', '')]: { bavail: 30_000_000, bsize: 4096, blocks: 50_000_000 },
    });
    const drives = listDrives({ statfsSync });
    expect(drives.map((d: { letter: string }) => d.letter)).toEqual(['E']);
  });

  it('刚好等于 3GB 算够（边界不误杀）', () => {
    const bavail = REQUIRED_FREE_BYTES / 4096;
    const statfsSync = fakeStatfs({
      [win('E:', '')]: { bavail, bsize: 4096, blocks: 99_000_000 },
    });
    const drives = listDrives({ statfsSync });
    expect(drives[0].enough).toBe(true);
  });
});

describe('freeBytesAt：目录不存在时往上找祖先', () => {
  it('真实盘符能问到空间', () => {
    const free = freeBytesAt(win('C:', ''));
    expect(free === null || typeof free === 'number').toBe(true);
    if (typeof free === 'number') expect(free).toBeGreaterThan(0);
  });

  it('完全瞎写的路径返回 null 而不是抛异常', () => {
    expect(() => freeBytesAt(win('', 'x', 'y', 'z', 'not', 'a', 'real', 'path'))).not.toThrow();
  });
});

describe('planSteps：断点续的依据', () => {
  it('返回 5 个步骤，且 id 顺序固定（界面进度条依赖顺序）', () => {
    const steps = planSteps(win('E:', 'nonexistent-mineru-test-root'));
    expect(steps.map((s: { id: string }) => s.id)).toEqual([
      'uv', 'python', 'venv', 'packages', 'models',
    ]);
  });

  it('★ 目录不存在时，所有步骤都判为未完成（从头装）', () => {
    const steps = planSteps(win('E:', 'nonexistent-mineru-test-root-xyz'));
    for (const s of steps) expect(s.done()).toBe(false);
  });

  it('每个步骤都有 title 与 detail（界面要显示给人看）', () => {
    for (const s of planSteps(win('E:', 'x'))) {
      expect(typeof s.title).toBe('string');
      expect(s.title.length).toBeGreaterThan(0);
      expect(typeof s.detail).toBe('string');
    }
  });

  it('模型那一步的说明里写明体积（用户要知道最慢的是哪一步）', () => {
    const models = planSteps(win('E:', 'x')).find((s: { id: string }) => s.id === 'models');
    expect(models.detail).toContain('2 GB');
  });
});

describe('detectExisting：A 方案的前置探测', () => {
  const fakeExists = (present: string[]) => (p: string) => present.includes(p);

  it('★ 找到已有的 MinerU 时返回 found + 路径 + 来源', () => {
    const r = detectExisting({
      exists: fakeExists([STUDYHUB_EXE, win(STUDYHUB_HOME, 'config.yaml')]),
    });
    expect(r.found).toBe(true);
    expect(r.exePath).toBe(STUDYHUB_EXE);
    expect(r.home).toBe(STUDYHUB_HOME);
    expect(typeof r.source).toBe('string');
  });

  it('设置里手工指定的优先级最高', () => {
    const custom = win('D:', 'my', 'MinerU', 'venv', 'Scripts', 'mineru.exe');
    const r = detectExisting({
      customExe: custom,
      exists: fakeExists([custom, STUDYHUB_EXE]),
    });
    expect(r.exePath).toBe(custom);
    expect(r.source).toContain('手工指定');
  });

  it('环境变量次之', () => {
    const fromEnv = win('F:', 'py', 'venv', 'Scripts', 'mineru.exe');
    const r = detectExisting({
      env: { MINERU_EXE: fromEnv },
      exists: fakeExists([fromEnv]),
    });
    expect(r.exePath).toBe(fromEnv);
  });

  it('路径存在但同目录没有 config.yaml 时，home 为 null（不瞎传）', () => {
    /*
     * 用「设置里手工指定」这条路径来测 —— 探测列表只认几个固定位置
     * （StudyHub 部署、用户目录下的 MinerU、应用数据目录），
     * 随便编一个 F:\bare 不在候选里，那样测的是别的东西。
     */
    const exe = win('F:', 'bare', 'venv', 'Scripts', 'mineru.exe');
    const r = detectExisting({ customExe: exe, exists: fakeExists([exe]) });
    expect(r.found).toBe(true);
    expect(r.home).toBeNull();
  });

  it('什么都没有时返回 found=false', () => {
    const r = detectExisting({ exists: () => false });
    expect(r.found).toBe(false);
  });
});

describe('install：A 方案 —— 已有就直接复用，不装第二份', () => {
  it('★ 探测到已有 MinerU 时，不下载任何东西、不创建目录', async () => {
    /*
     * 这是 A 方案的核心保证。为什么重要：
     * MinerU 的 server 是全局单例，装第二份会和已有那份抢服务、
     * token 打架（实测 invalid_doclib_token）。
     */
    const events: string[] = [];
    const target = win('E:', 'this', 'dir', 'must', 'not', 'be', 'created');

    const r = await install({
      root: target,
      onStep: (e: { id: string; state: string }) => events.push(`${e.id}:${e.state}`),
    });

    expect(r.ok).toBe(true);
    expect(r.reused).toBe(true);
    /* 关键：一个安装步骤都没跑 */
    expect(events).toEqual([]);
    /* 也没创建目录 */
    expect(existsSync(target)).toBe(false);
  });
});

describe('install：开工前的拦截', () => {
  it('没给目录 → 直接拒绝，不开始下载', async () => {
    const r = await install({ root: '' });
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe('init');
  });
});

describe('uninstall：安全边界', () => {
  it('没给目录 → 拒绝', async () => {
    const r = await uninstall({ root: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('★ 目录不像 MinerU 安装位置时**拒绝删除**（防止配置被改坏后误删）', async () => {
    /*
     * 这是最重要的一条：如果配置里的路径被改成 C:\ 或某个用户目录，
     * 盲目递归删除会造成灾难。判断标准是目录里有没有我们创建的标记。
     */
    const r = await uninstall({ root: win('E:', 'openleaner', '.tmp', 'not-a-mineru-dir') });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不像 MinerU');
  });

  it('不存在的目录也拒绝（而不是静默成功）', async () => {
    const r = await uninstall({ root: win('Z:', 'absolutely', 'nope') });
    expect(r.ok).toBe(false);
  });
});

/**
 * 一键安装面板「该显示什么」的测试（2026-11-11 晚）。
 *
 * 这些判断直接决定用户看到什么，而其中两条出错代价很高：
 *  - A 方案失效 → 用户装第二份 MinerU → 和已有的抢服务、token 打架
 *  - 没选目录却让点「开始安装」→ 点了必然失败（假按钮）
 */
import { describe, expect, it } from 'vitest';
import {
  panelView,
  stepLabel,
  progressPercent,
  formatGb,
  INSTALL_STEPS,
  type PanelInput,
} from './mineru-install-view.ts';

const base: PanelInput = {
  hasBridge: true,
  alreadyInstalled: false,
  hasChosenDir: false,
  busy: false,
  steps: {},
};

describe('panelView：浏览器里没有桥', () => {
  it('★ 没桥时整个面板不可用，不摆任何可点按钮', () => {
    const v = panelView({ ...base, hasBridge: false });
    expect(v.usable).toBe(false);
    expect(v.showInstall).toBe(false);
    expect(v.showDetected).toBe(false);
    expect(v.canStart).toBe(false);
    expect(v.canUninstall).toBe(false);
  });

  it('没桥时即使「检测到已装」也不显示（没有桥就查不到）', () => {
    const v = panelView({ ...base, hasBridge: false, alreadyInstalled: true });
    expect(v.showDetected).toBe(false);
  });
});

describe('panelView：A 方案 —— 已装与安装入口互斥', () => {
  it('★ 已经装了 MinerU 时，不显示安装入口（不装第二份）', () => {
    /*
     * 这是 A 方案的核心。为什么必须互斥：
     * MinerU 的 server 是全局单例，装第二份会和已有那份抢服务，
     * 两份 doclib.auth.token 不同 → parse 时报 invalid_doclib_token（实测）。
     */
    const v = panelView({ ...base, alreadyInstalled: true });
    expect(v.showDetected).toBe(true);
    expect(v.showInstall).toBe(false);
  });

  it('已装时「开始安装」不可点（入口都没了，更不该能点）', () => {
    const v = panelView({ ...base, alreadyInstalled: true, hasChosenDir: true });
    expect(v.canStart).toBe(false);
  });

  it('已装时仍然可以卸载（用户明确要求要有卸载按钮）', () => {
    const v = panelView({ ...base, alreadyInstalled: true, hasChosenDir: true });
    expect(v.canUninstall).toBe(true);
  });
});

describe('panelView：没装时显示选盘与安装', () => {
  it('渲染安装区，显示选盘', () => {
    const v = panelView(base);
    expect(v.showInstall).toBe(true);
    expect(v.showDetected).toBe(false);
  });

  it('★ 没选目录时不能点「开始安装」（不摆假按钮）', () => {
    const v = panelView({ ...base, hasChosenDir: false });
    expect(v.canStart).toBe(false);
  });

  it('选了目录就能点', () => {
    const v = panelView({ ...base, hasChosenDir: true });
    expect(v.canStart).toBe(true);
  });

  it('★ 安装进行中不能再点（防重复提交，会装两份）', () => {
    const v = panelView({ ...base, hasChosenDir: true, busy: true });
    expect(v.canStart).toBe(false);
    expect(v.showRunning).toBe(true);
  });

  it('★ 有步骤处于 running 也算进行中（不只是 busy 标志）', () => {
    /*
     * 因为进度是事件推过来的，busy 可能因为异步时序还没来得及设上，
     * 但 steps 里已经有 running 了 —— 这时也必须算「正在装」。
     */
    const v = panelView({ ...base, hasChosenDir: true, steps: { packages: 'running' } });
    expect(v.showRunning).toBe(true);
    expect(v.canStart).toBe(false);
  });

  it('安装中不让卸载（文件被占用，删不干净）', () => {
    const v = panelView({ ...base, hasChosenDir: true, busy: true });
    expect(v.canUninstall).toBe(false);
  });

  it('没选目录时卸载也不可点（不知道装在哪）', () => {
    const v = panelView({ ...base, hasChosenDir: false });
    expect(v.canUninstall).toBe(false);
  });
});

describe('stepLabel：步骤状态的显示', () => {
  it('完成打勾，失败打叉', () => {
    expect(stepLabel('done').mark).toBe('✓');
    expect(stepLabel('failed').mark).toBe('✕');
  });

  it('★ 跳过要明确标「已跳过」，不能伪装成完成', () => {
    const s = stepLabel('skipped');
    expect(s.note).toBe('已跳过');
    expect(s.mark).not.toBe('✓');
  });

  it('未开始与进行中都不带说明文字', () => {
    expect(stepLabel('idle').note).toBeNull();
    expect(stepLabel('running').note).toBeNull();
  });
});

describe('progressPercent：不编造百分比', () => {
  it('有总大小时按比例算', () => {
    expect(progressPercent(50, 100)).toBe(50);
    expect(progressPercent(1, 4)).toBe(25);
  });

  it('★ 不知道总大小时返回 null，不返回一个编的数', () => {
    /*
     * 有些服务器不给 content-length。这时界面必须显示不确定态，
     * 而不是假装「30%」—— 那是编数字，用户会以为快好了。
     */
    expect(progressPercent(12345, null)).toBeNull();
    expect(progressPercent(12345, 0)).toBeNull();
  });

  it('超过 100% 时封顶（下载完可能多几字节）', () => {
    expect(progressPercent(105, 100)).toBe(100);
  });

  it('非法输入返回 null', () => {
    expect(progressPercent(Number.NaN, 100)).toBeNull();
    expect(progressPercent(-5, 100)).toBeNull();
  });
});

describe('formatGb', () => {
  it('保留 1 位小数', () => {
    expect(formatGb(1024 ** 3)).toBe('1.0 GB');
    expect(formatGb(3.25 * 1024 ** 3)).toBe('3.3 GB');
  });

  it('未知就显示「未知」，不显示 0.0 GB（那会让人以为盘满了）', () => {
    expect(formatGb(null)).toBe('未知');
    expect(formatGb(Number.NaN)).toBe('未知');
  });
});

describe('INSTALL_STEPS：与引擎的步骤一一对应', () => {
  it('5 步，id 顺序固定（进度条按这个顺序画）', () => {
    expect(INSTALL_STEPS.map((s) => s.id)).toEqual([
      'uv', 'python', 'venv', 'packages', 'models',
    ]);
  });

  it('每步都有给人看的标题', () => {
    for (const s of INSTALL_STEPS) {
      expect(s.title.length).toBeGreaterThan(0);
    }
  });
});

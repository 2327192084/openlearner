/**
 * 解析引擎选择的单测（2026-11-15）。
 *
 * 用户要求「把 OCR 识别作为除了本地模型解析 PDF 的另一方式」，
 * 并选了「并列两条路，用户自己选」。
 *
 * 这里钉三条规则：默认本地、云端要有 Key、云端不可用时不留在那个选项上。
 */

import { describe, expect, it } from 'vitest';
import { defaultEngine, engineLabel, reconcileEngine, type EngineAvailability } from './engine-choice.ts';

const av = (over: Partial<EngineAvailability> = {}): EngineAvailability => ({
  localOk: true,
  cloudOk: true,
  ...over,
});

describe('默认选哪个', () => {
  it('★ 两边都可用时默认本地 MinerU（原有行为，且免费）', () => {
    expect(defaultEngine(av())).toBe('local');
  });

  it('本地不可用、云端可用 → 云端', () => {
    expect(defaultEngine(av({ localOk: false }))).toBe('deepseek');
  });

  it('★ 本地可用、云端不可用 → 本地（不能因为云挂了就解析不了）', () => {
    expect(defaultEngine(av({ cloudOk: false }))).toBe('local');
  });

  it('两边都不可用 → 仍返回本地（由界面显示原因，不返回 null）', () => {
    expect(defaultEngine(av({ localOk: false, cloudOk: false }))).toBe('local');
  });
});

describe('纠正一个已经失效的选择', () => {
  it('★ 选了云端但云端没 Key 了 → 切回本地', () => {
    const r = reconcileEngine('deepseek', av({ cloudOk: false }));
    expect(r.engine).toBe('local');
    expect(r.changed).toBe(true);
  });

  it('★ 选了本地但本地不可用、云端可用 → 切到云端', () => {
    /*
     * 这一条与上一条方向相反，但理由不同：
     * 本地挂了是「用不了」，切到云端是**帮用户把活干完**（要花钱，
     * 但至少不是死路）。而云端挂了切回本地不花钱 —— 两边都是
     * 「切到能用的那一个」，方向由可用性决定，不由偏好决定。
     */
    const r = reconcileEngine('local', av({ localOk: false, cloudOk: true }));
    expect(r.engine).toBe('deepseek');
    expect(r.changed).toBe(true);
  });

  it('选了本地且本地可用 → 不动', () => {
    const r = reconcileEngine('local', av());
    expect(r.engine).toBe('local');
    expect(r.changed).toBe(false);
  });

  it('选了云端且云端可用 → 不动', () => {
    const r = reconcileEngine('deepseek', av());
    expect(r.engine).toBe('deepseek');
    expect(r.changed).toBe(false);
  });

  it('两边都不可用时保持原选择（不来回弹）', () => {
    expect(reconcileEngine('local', av({ localOk: false, cloudOk: false }))).toEqual({
      engine: 'local',
      changed: false,
    });
    expect(reconcileEngine('deepseek', av({ localOk: false, cloudOk: false }))).toEqual({
      engine: 'deepseek',
      changed: false,
    });
  });

  it('纠正结果一定是一个「能用」的引擎（若存在能用的）', () => {
    const cases: EngineAvailability[] = [
      av(),
      av({ localOk: false }),
      av({ cloudOk: false }),
      av({ localOk: false, cloudOk: false }),
    ];
    for (const a of cases) {
      for (const cur of ['local', 'deepseek'] as const) {
        const r = reconcileEngine(cur, a);
        if (a.localOk || a.cloudOk) {
          const ok = r.engine === 'local' ? a.localOk : a.cloudOk;
          expect(ok, `${cur} in ${JSON.stringify(a)} → ${r.engine}`).toBe(true);
        }
      }
    }
  });
});

describe('显示名', () => {
  it('两种引擎的名字固定（日志与界面用同一份措辞）', () => {
    expect(engineLabel('local')).toBe('本地 MinerU');
    expect(engineLabel('deepseek')).toBe('DeepSeek 云 OCR');
  });
});

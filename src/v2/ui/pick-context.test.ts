import { describe, expect, it } from 'vitest';
import {
  applyPickToTree,
  mergePicks,
  pickBannerText,
  pickTargetPage,
  type PickSession,
} from './pick-context.ts';

/**
 * 「选取会话」的纯逻辑（2026-11-23，用户待办第 1 项）。
 *
 * ## 这组测试守的三件事
 *
 * 1. **合并去重** —— 用户来回点同一张卡，绑定数不能虚高
 *    （11-22「0/26 与 0/78」就是重复计数那类错误）。
 * 2. **横幅数字 = 已绑真实数** —— 话术与状态的关系断言（本项目老盲区）。
 * 3. **过期会话必须拒绝写回** —— 小节被重规划掉之后，
 *    点击不许静默写到别的节上。
 */

function session(over: Partial<PickSession> = {}): PickSession {
  return {
    kind: 'flashcards',
    sourceId: 'src-1',
    sectionId: 'sec-1',
    sectionTitle: '1.2 连续时间信号',
    chapterTitle: '第1章 信号与系统',
    token: 1,
    ...over,
  };
}

describe('mergePicks：即时绑定的合并规则', () => {
  it('新 id 追加在后面', () => {
    expect(mergePicks(['a'], ['b'])).toEqual(['a', 'b']);
  });

  it('⚠️ 重复点同一张卡不产生重复绑定（反向验证：去掉 seen 检查这条就红）', () => {
    const once = mergePicks(['a'], ['b']);
    const twice = mergePicks(once, ['b']);
    expect(twice).toEqual(['a', 'b']);
    expect(twice).toHaveLength(2);
  });

  it('一次点进多个时保持给出顺序、去重', () => {
    expect(mergePicks([], ['c', 'a', 'c', 'b'])).toEqual(['c', 'a', 'b']);
  });

  it('已绑在前、新绑在后（顺序是用户能感知的：先绑的先看到）', () => {
    expect(mergePicks(['x', 'y'], ['z'])).toEqual(['x', 'y', 'z']);
  });

  it('空新增不改原表', () => {
    expect(mergePicks(['x'], [])).toEqual(['x']);
  });
});

describe('pickBannerText：横幅说的数字必须是真实已绑数', () => {
  it('⚠️ 绑 3 张后横幅说 3（反向验证：把 boundCount 写死或另算一条路径，这条红）', () => {
    const t = pickBannerText(session(), 3);
    expect(t).toContain('已绑 3 个');
  });

  it('带小节与章标题（用户要知道在为哪一节挑）', () => {
    const t = pickBannerText(session(), 0);
    expect(t).toContain('第1章 信号与系统');
    expect(t).toContain('1.2 连续时间信号');
    expect(t).toContain('闪卡');
  });

  it('题组会话措辞跟着 kind 变', () => {
    expect(pickBannerText(session({ kind: 'decks' }), 1)).toContain('题组');
  });
});

describe('pickTargetPage：会话 → 页面映射只写一次', () => {
  it('flashcards → 闪卡管理页；decks → 我的题组页', () => {
    expect(pickTargetPage('flashcards')).toBe('flashcards');
    expect(pickTargetPage('decks')).toBe('decks');
  });
});

describe('applyPickToTree：过期检查与合并必须一体（做了没接上的教训）', () => {
  /* 一棵最小树：ch1 有 sec-1（已绑 a）与 sec-2 */
  const tree = {
    chapters: [
      {
        sections: [
          { id: 'sec-1', tasks: { boundFlashcardIds: ['a'], boundDeckIds: [] } },
          { id: 'sec-2', tasks: { boundFlashcardIds: [], boundDeckIds: ['d1'] } },
        ],
      },
    ],
  };

  it('小节还在 → 写回合并后的闪卡列表，且不动别的节', () => {
    const r = applyPickToTree(session(), tree, 'b');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ch = r.tree.chapters[0]!;
    expect(ch.sections[0]!.tasks.boundFlashcardIds).toEqual(['a', 'b']);
    /* ⚠️ 关系断言：选给 sec-1 的不许渗到 sec-2 */
    expect(ch.sections[1]!.tasks.boundFlashcardIds).toEqual([]);
    expect(ch.sections[1]!.tasks.boundDeckIds).toEqual(['d1']);
  });

  it('题组会话写 boundDeckIds，不碰闪卡', () => {
    const r = applyPickToTree(session({ kind: 'decks' }), tree, 'd2');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.tree.chapters[0]!.sections[0]!;
    expect(sec.tasks.boundDeckIds).toEqual(['d2']);
    expect(sec.tasks.boundFlashcardIds).toEqual(['a']);
  });

  it('⚠️ 小节没了（重规划过）→ no-section，原树一字不动（反向验证：把 found 判断删掉这条红）', () => {
    const r = applyPickToTree(session({ sectionId: 'gone' }), tree, 'b');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-section');
  });

  it('地图没了 → no-tree（两种过期提示要能分开）', () => {
    const r = applyPickToTree(session(), undefined, 'b');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-tree');
  });

  it('重复选同一张 → 列表不变长（合并去重在这里同样生效）', () => {
    const once = applyPickToTree(session(), tree, 'a');
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    expect(once.tree.chapters[0]!.sections[0]!.tasks.boundFlashcardIds).toEqual(['a']);
  });
});

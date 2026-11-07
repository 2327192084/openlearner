import { describe, expect, it } from 'vitest';
import { suggestionsOf, type SuggestionInput } from './study-suggestions.ts';
import type { Todo } from '@/core/model.ts';

const base = (over: Partial<SuggestionInput> = {}): SuggestionInput => ({
  decks: [],
  sourcesWithoutQuestions: 0,
  wrongTotal: 0,
  todos: [],
  ...over,
});

const todo = (title: string, done = false): Todo => ({
  id: `t_${title}`,
  title,
  note: '',
  dueAt: null,
  done,
  doneAt: done ? '2026-11-08' : null,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  order: 0,
});

describe('suggestionsOf：学习建议', () => {
  it('什么都没有 → 不给建议（不编内容）', () => {
    expect(suggestionsOf(base())).toEqual([]);
  });

  it('有错题 → 建议巩固，且排在很前', () => {
    const out = suggestionsOf(base({ wrongTotal: 9 }));
    expect(out[0]!.kind).toBe('review-wrong');
    expect(out[0]!.title).toContain('9');
  });

  it('没练完的题组 → 建议继续练', () => {
    const out = suggestionsOf(
      base({ decks: [{ id: 'd1', title: '第一章', total: 8, done: 2, wrong: 1 }] }),
    );
    const s = out.find((x) => x.kind === 'practice-deck');
    expect(s).toBeDefined();
    expect(s!.title).toContain('第一章');
    expect(s!.reason).toContain('8');
    expect(s!.reason).toContain('2');
  });

  it('练过的比例越高越靠前（快做完的先收尾）', () => {
    const out = suggestionsOf(
      base({
        decks: [
          { id: 'a', title: '刚开始', total: 10, done: 1, wrong: 0 },
          { id: 'b', title: '快完了', total: 10, done: 9, wrong: 0 },
        ],
      }),
    );
    const decks = out.filter((x) => x.kind === 'practice-deck');
    expect(decks[0]!.title).toContain('快完了');
  });

  it('从没练过的题组 → 建议开始练，但排在「继续练」后面', () => {
    const out = suggestionsOf(
      base({
        decks: [
          { id: 'new', title: '没碰过', total: 8, done: 0, wrong: 0 },
          { id: 'mid', title: '练到一半', total: 8, done: 4, wrong: 0 },
        ],
      }),
    );
    const decks = out.filter((x) => x.kind === 'practice-deck');
    expect(decks[0]!.title).toContain('练到一半');
    expect(decks[1]!.title).toContain('没碰过');
  });

  it('全练完的题组 → 不建议', () => {
    const out = suggestionsOf(
      base({ decks: [{ id: 'd1', title: '做完了', total: 8, done: 8, wrong: 0 }] }),
    );
    expect(out).toEqual([]);
  });

  it('空题组 → 不建议', () => {
    expect(suggestionsOf(base({ decks: [{ id: 'd1', title: '空的', total: 0, done: 0, wrong: 0 }] }))).toEqual([]);
  });

  it('有资料没出题 → 建议出题', () => {
    const out = suggestionsOf(base({ sourcesWithoutQuestions: 2 }));
    const s = out.find((x) => x.kind === 'make-questions');
    expect(s).toBeDefined();
    expect(s!.title).toContain('2');
  });

  it('单份资料时文案用「这份」', () => {
    const out = suggestionsOf(base({ sourcesWithoutQuestions: 1 }));
    expect(out[0]!.title).toBe('给这份资料出题');
  });

  /*
   * 去重：用户已经自己记了「复习第一章」，就不该再建议「继续练第一章」。
   * 同一条建议出现在两个地方，会让人以为要重复做一次。
   */
  it('待办里已经提到题组名 → 不再建议同一个题组', () => {
    const out = suggestionsOf(
      base({
        decks: [{ id: 'd1', title: '第一章', total: 8, done: 2, wrong: 0 }],
        todos: [todo('复习第一章')],
      }),
    );
    expect(out.filter((x) => x.kind === 'practice-deck')).toEqual([]);
  });

  it('待办里提到的是别的题组 → 照常建议', () => {
    const out = suggestionsOf(
      base({
        decks: [{ id: 'd1', title: '第一章', total: 8, done: 2, wrong: 0 }],
        todos: [todo('复习第三章')],
      }),
    );
    expect(out.filter((x) => x.kind === 'practice-deck')).toHaveLength(1);
  });

  it('已完成待办不参与去重', () => {
    const out = suggestionsOf(
      base({
        decks: [{ id: 'd1', title: '第一章', total: 8, done: 2, wrong: 0 }],
        todos: [todo('复习第一章', true)],
      }),
    );
    expect(out.filter((x) => x.kind === 'practice-deck')).toHaveLength(1);
  });

  it('错题与出题建议不受去重影响', () => {
    const out = suggestionsOf(
      base({ wrongTotal: 3, sourcesWithoutQuestions: 1, todos: [todo('巩固错题'), todo('给资料出题')] }),
    );
    expect(out.some((x) => x.kind === 'review-wrong')).toBe(true);
    expect(out.some((x) => x.kind === 'make-questions')).toBe(true);
  });

  it('「继续练」最多给 2 条，避免一屏全是建议', () => {
    const out = suggestionsOf(
      base({
        decks: [
          { id: 'a', title: 'A组', total: 10, done: 9, wrong: 0 },
          { id: 'b', title: 'B组', total: 10, done: 8, wrong: 0 },
          { id: 'c', title: 'C组', total: 10, done: 7, wrong: 0 },
        ],
      }),
    );
    const cont = out.filter((x) => x.title.startsWith('继续练'));
    expect(cont).toHaveLength(2);
  });
});

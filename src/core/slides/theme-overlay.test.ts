import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorage } from '../storage/memory-storage.ts';
import type { SlideDeck } from '../model.ts';
import type { SourceChunk } from './source-chunk.ts';
import { SlideService } from './service.ts';
import {
  DEFAULT_THEME_ID,
  MIN_ACCENT_CONTRAST,
  THEMES,
  applyAccent,
  checkAccent,
  contrastRatio,
  cssColor,
  normalizeHex,
  resolveDeckTheme,
  resolveTheme,
} from './theme.ts';
import { buildRenderPlan } from './render-plan.ts';

/**
 * 批次 A 的测试：主题、叠加内容、图片分区。
 *
 * 三组各自守一件容易出错的事：
 *  - 主题：未知 id 不能抛错，否则旧备份打不开；
 *  - 叠加：坐标必须是比例，换算成英寸只在一处发生；
 *  - 图片：取不到的图要跳过，不能画出空白框。
 */

function makeChunk(id: string): SourceChunk {
  return {
    segmentId: id,
    text: `第 ${id} 段的正文内容，便于区分。`,
    page: 1,
    chapter: '第一章',
  };
}

describe('theme：预设与解析', () => {
  it('默认主题存在且是第一个', () => {
    expect(resolveTheme(null).id).toBe(DEFAULT_THEME_ID);
    expect(THEMES[0]!.id).toBe(DEFAULT_THEME_ID);
  });

  it('未知 id 退回默认而不是抛错（旧备份要能打开）', () => {
    expect(resolveTheme('不存在的主题').id).toBe(DEFAULT_THEME_ID);
    expect(resolveTheme(undefined).id).toBe(DEFAULT_THEME_ID);
    expect(resolveTheme('').id).toBe(DEFAULT_THEME_ID);
  });

  it('每套主题都有完整色板（漏一个会导致某处渲染成 undefined）', () => {
    const keys = [
      'text',
      'muted',
      'accent',
      'citation',
      'rule',
      'bg',
      'titleBg',
      'titleText',
      'subtitle',
    ] as const;

    for (const theme of THEMES) {
      for (const key of keys) {
        expect(theme.colors[key], `${theme.id}.${key}`).toMatch(/^[0-9A-Fa-f]{6}$/);
      }
      expect(theme.font.length).toBeGreaterThan(0);
    }
  });

  it('正文与背景不能同色（同色等于看不见字）', () => {
    for (const theme of THEMES) {
      expect(theme.colors.text, theme.id).not.toBe(theme.colors.bg);
      expect(theme.colors.titleText, theme.id).not.toBe(theme.colors.titleBg);
    }
  });

  it('主题 id 不重复', () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cssColor 补 # 但不重复补', () => {
    expect(cssColor('FFFFFF')).toBe('#FFFFFF');
    expect(cssColor('#FFFFFF')).toBe('#FFFFFF');
  });
});

describe('SlideService：主题', () => {
  let storage: MemoryStorage;
  let slides: SlideService;

  beforeEach(() => {
    storage = new MemoryStorage();
    slides = new SlideService(storage);
  });

  async function makeDeck(): Promise<SlideDeck> {
    const { deck } = await slides.createFromSource({
      sourceId: 'src_1',
      chunks: [makeChunk('k0')],
    });
    return deck;
  }

  it('生成时能指定主题', async () => {
    const { deck } = await slides.createFromSource({
      sourceId: 'src_1',
      chunks: [makeChunk('k0')],
      theme: 'dark-slate',
    });
    expect(deck.theme).toBe('dark-slate');
  });

  it('不指定时用默认主题', async () => {
    const deck = await makeDeck();
    expect(deck.theme).toBe(DEFAULT_THEME_ID);
  });

  it('未知主题在生成时被归一到默认（不写进库）', async () => {
    const { deck } = await slides.createFromSource({
      sourceId: 'src_1',
      chunks: [makeChunk('k0')],
      theme: '瞎填的',
    });
    expect(deck.theme).toBe(DEFAULT_THEME_ID);
  });

  it('setTheme 只换配色，不动内容', async () => {
    const deck = await makeDeck();
    const before = JSON.stringify(deck.pages);

    const after = await slides.setTheme(deck.id, 'green-ink');
    expect(after.theme).toBe('green-ink');
    // 页面、要点、角标一个字节都不该变
    expect(JSON.stringify(after.pages)).toBe(before);
    expect(after.citations.length).toBe(deck.citations.length);
  });

  it('setTheme 遇到未知 id 也退回默认', async () => {
    const deck = await makeDeck();
    const after = await slides.setTheme(deck.id, 'nope');
    expect(after.theme).toBe(DEFAULT_THEME_ID);
  });
});

describe('SlideService：叠加内容', () => {
  let storage: MemoryStorage;
  let slides: SlideService;
  let deck: SlideDeck;

  beforeEach(async () => {
    storage = new MemoryStorage();
    slides = new SlideService(storage);
    const created = await slides.createFromSource({
      sourceId: 'src_1',
      chunks: [makeChunk('k0')],
    });
    deck = created.deck;
  });

  it('加文本框后能读回来', async () => {
    const pageId = deck.pages[1]!.id;
    await slides.addOverlay(deck.id, pageId, {
      kind: 'text',
      text: '这是批注',
      x: 0.1,
      y: 0.2,
      w: 0.5,
      h: 0.1,
    });

    const fresh = await slides.get(deck.id);
    const ov = fresh!.pages[1]!.overlays!;
    expect(ov).toHaveLength(1);
    expect(ov[0]!.text).toBe('这是批注');
    expect(ov[0]!.id).toBeTruthy();
  });

  it('新加的内容默认在最上层（z 递增）', async () => {
    const pageId = deck.pages[1]!.id;
    const base = { kind: 'text' as const, text: 'a', x: 0, y: 0, w: 0.2, h: 0.1 };
    await slides.addOverlay(deck.id, pageId, base);
    await slides.addOverlay(deck.id, pageId, { ...base, text: 'b' });

    const fresh = await slides.get(deck.id);
    const ovs = fresh!.pages[1]!.overlays!;
    expect(ovs[1]!.z).toBeGreaterThan(ovs[0]!.z);
  });

  it('能移动和缩放', async () => {
    const pageId = deck.pages[1]!.id;
    await slides.addOverlay(deck.id, pageId, {
      kind: 'text',
      text: 'x',
      x: 0,
      y: 0,
      w: 0.2,
      h: 0.1,
    });
    const ovId = (await slides.get(deck.id))!.pages[1]!.overlays![0]!.id;

    await slides.updateOverlay(deck.id, pageId, ovId, { x: 0.33, y: 0.44, w: 0.25 });
    const ov = (await slides.get(deck.id))!.pages[1]!.overlays![0]!;
    expect(ov.x).toBeCloseTo(0.33);
    expect(ov.y).toBeCloseTo(0.44);
    expect(ov.w).toBeCloseTo(0.25);
    // 没传的字段保持原值
    expect(ov.h).toBeCloseTo(0.1);
  });

  it('能删掉', async () => {
    const pageId = deck.pages[1]!.id;
    await slides.addOverlay(deck.id, pageId, {
      kind: 'text',
      text: 'x',
      x: 0,
      y: 0,
      w: 0.2,
      h: 0.1,
    });
    const ovId = (await slides.get(deck.id))!.pages[1]!.overlays![0]!.id;

    await slides.removeOverlay(deck.id, pageId, ovId);
    expect((await slides.get(deck.id))!.pages[1]!.overlays).toEqual([]);
  });
});

describe('SlideService：图片分区', () => {
  let storage: MemoryStorage;
  let slides: SlideService;

  beforeEach(() => {
    storage = new MemoryStorage();
    slides = new SlideService(storage);
  });

  const TINY = 'data:image/png;base64,iVBORw0KGgo=';

  it('存图返回 id，能按 id 取回', async () => {
    const id = await slides.addImage({ imageData: TINY, width: 100, height: 50 });
    const img = await slides.getImage(id);
    expect(img?.imageData).toBe(TINY);
    expect(img?.width).toBe(100);
  });

  it('图片存在独立分区，不进 deck 记录（避免 deck 膨胀）', async () => {
    const id = await slides.addImage({ imageData: TINY, width: 10, height: 10 });
    const { deck } = await slides.createFromSource({
      sourceId: 'src_1',
      chunks: [makeChunk('k0')],
    });
    await slides.addOverlay(deck.id, deck.pages[1]!.id, {
      kind: 'image',
      imageId: id,
      x: 0,
      y: 0,
      w: 0.3,
      h: 0.3,
    });

    const fresh = await slides.get(deck.id);
    // deck 里只有 id，没有 base64 本体
    expect(JSON.stringify(fresh)).not.toContain('iVBORw0KGgo');
    expect(fresh!.pages[1]!.overlays![0]!.imageId).toBe(id);
  });

  it('取不到的图不会画进渲染计划（不产生空白框）', async () => {
    const { deck } = await slides.createFromSource({
      sourceId: 'src_1',
      chunks: [makeChunk('k0')],
    });
    await slides.addOverlay(deck.id, deck.pages[1]!.id, {
      kind: 'image',
      imageId: '不存在的图片',
      x: 0,
      y: 0,
      w: 0.3,
      h: 0.3,
    });

    const plan = await slides.getPlan(deck.id);
    expect(plan[1]!.overlays).toHaveLength(0);
  });
});

describe('render-plan：比例 → 英寸', () => {
  it('0~1 的比例被换算成真实版面英寸', () => {
    const deck = {
      id: 'd',
      title: 'T',
      courseId: null,
      sourceId: null,
      theme: DEFAULT_THEME_ID,
      status: 'outline',
      pages: [
        {
          id: 'p1',
          layout: 'bullets',
          title: '页',
          subtitle: null,
          bullets: [],
          figure: null,
          overlays: [
            { id: 'o1', kind: 'text', text: 'hi', x: 0.5, y: 0.25, w: 0.2, h: 0.1, z: 0 },
          ],
        },
      ],
      citations: [],
      exports: [],
      createdAt: '',
      updatedAt: '',
    } as SlideDeck;

    const plan = buildRenderPlan(deck);
    const ov = plan[0]!.overlays[0]!;

    // 13.333 × 7.5 是版面尺寸
    expect(ov.x).toBeCloseTo(0.5 * 13.333, 2);
    expect(ov.y).toBeCloseTo(0.25 * 7.5, 2);
    expect(ov.w).toBeCloseTo(0.2 * 13.333, 2);
  });

  it('按 z 升序排列（底 → 顶）', () => {
    const deck = {
      id: 'd',
      title: 'T',
      courseId: null,
      sourceId: null,
      status: 'outline',
      pages: [
        {
          id: 'p1',
          layout: 'bullets',
          title: '页',
          subtitle: null,
          bullets: [],
          figure: null,
          overlays: [
            { id: 'top', kind: 'text', text: 'top', x: 0, y: 0, w: 1, h: 1, z: 9 },
            { id: 'bottom', kind: 'text', text: 'bottom', x: 0, y: 0, w: 1, h: 1, z: 1 },
          ],
        },
      ],
      citations: [],
      exports: [],
      createdAt: '',
      updatedAt: '',
    } as SlideDeck;

    const plan = buildRenderPlan(deck);
    expect(plan[0]!.overlays.map((o) => o.id)).toEqual(['bottom', 'top']);
  });

  it('空文字的叠加项被跳过', () => {
    const deck = {
      id: 'd',
      title: 'T',
      courseId: null,
      sourceId: null,
      status: 'outline',
      pages: [
        {
          id: 'p1',
          layout: 'bullets',
          title: '页',
          subtitle: null,
          bullets: [],
          figure: null,
          overlays: [{ id: 'o', kind: 'text', text: '   ', x: 0, y: 0, w: 1, h: 1, z: 0 }],
        },
      ],
      citations: [],
      exports: [],
      createdAt: '',
      updatedAt: '',
    } as SlideDeck;

    expect(buildRenderPlan(deck)[0]!.overlays).toHaveLength(0);
  });

  it('没有 overlays 字段的旧页等价于空数组', () => {
    const deck = {
      id: 'd',
      title: 'T',
      courseId: null,
      sourceId: null,
      status: 'outline',
      pages: [
        { id: 'p1', layout: 'bullets', title: '页', subtitle: null, bullets: [], figure: null },
      ],
      citations: [],
      exports: [],
      createdAt: '',
      updatedAt: '',
    } as unknown as SlideDeck;

    expect(buildRenderPlan(deck)[0]!.overlays).toEqual([]);
  });
});

describe('自定义主色：对比度保护', () => {
  const theme = resolveTheme(DEFAULT_THEME_ID);

  it('深色在浅底上对比度足够 → 通过', () => {
    // 深蓝配白底，一眼能看清
    const check = checkAccent('1E5FAA', theme);
    expect(check.ok).toBe(true);
    expect(check.ratio).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
  });

  it('浅色在浅底上对比度不足 → 警告但不算错', () => {
    // 淡黄配白底，投影上基本看不见
    const check = checkAccent('FFFACD', theme);
    expect(check.ok).toBe(false);
    expect(check.warning?.message).toContain(':1');
    // 必须给出「下一步」，不能只说「不行」
    expect(check.warning?.hint).toMatch(/建议|取舍/);
  });

  it('对比度是 1:1 到 21:1 之间的真实值（不是随便一个数）', () => {
    // 同色对比度必然是 1
    expect(contrastRatio('FFFFFF', 'FFFFFF')).toBeCloseTo(1, 1);
    // 黑白对比度是 21
    expect(contrastRatio('000000', 'FFFFFF')).toBeCloseTo(21, 0);
  });

  it('深浅反过来也算对（不是只认「深配浅」）', () => {
    // 深色主题上，亮色才对
    const dark = resolveTheme('dark-slate');
    const check = checkAccent('4FA3E3', dark);
    expect(check.ok).toBe(true);
  });
});

describe('applyAccent：只覆盖强调色', () => {
  const theme = resolveTheme(DEFAULT_THEME_ID);

  it('覆盖 accent，正文色不动', () => {
    const next = applyAccent(theme, 'AA3355');
    expect(next.colors.accent).toBe('AA3355');
    // 正文色必须原样保留：改坏正文整份课件就没法读了
    expect(next.colors.text).toBe(theme.colors.text);
    expect(next.colors.bg).toBe(theme.colors.bg);
  });

  it('传 null / 空时原样返回', () => {
    expect(applyAccent(theme, null)).toBe(theme);
    expect(applyAccent(theme, '')).toBe(theme);
    expect(applyAccent(theme, undefined)).toBe(theme);
  });

  it('不合法颜色被忽略（不会把 undefined 写进主题）', () => {
    expect(applyAccent(theme, 'ZZZZZZ').colors.accent).toBe(theme.colors.accent);
  });
});

describe('normalizeHex：颜色格式归一', () => {
  it('接受带 # 与不带 #', () => {
    expect(normalizeHex('1e5faa')).toBe('1E5FAA');
    expect(normalizeHex('#1e5faa')).toBe('1E5FAA');
  });

  it('三位简写展开成六位', () => {
    expect(normalizeHex('#abc')).toBe('AABBCC');
    expect(normalizeHex('f00')).toBe('FF0000');
  });

  it('不合法输入返回 null（调用方据此报错而不是静默忽略）', () => {
    expect(normalizeHex('GGGGGG')).toBeNull();
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('')).toBeNull();
    expect(normalizeHex(null)).toBeNull();
  });
});

describe('resolveDeckTheme：渲染层唯一入口', () => {
  it('只有预设时等于该预设', () => {
    const t = resolveDeckTheme('green-ink');
    expect(t.id).toBe('green-ink');
  });

  it('预设 + 主色覆盖一起生效', () => {
    const t = resolveDeckTheme('green-ink', 'AA3355');
    expect(t.id).toBe('green-ink');
    expect(t.colors.accent).toBe('AA3355');
  });

  it('预览与导出取同一份（都经过这个函数）', () => {
    // 直接比对两次调用结果：如果有任何随机性或状态残留，这条会挂
    const a = resolveDeckTheme('dark-slate', '123456');
    const b = resolveDeckTheme('dark-slate', '123456');
    expect(a.colors).toEqual(b.colors);
  });
});

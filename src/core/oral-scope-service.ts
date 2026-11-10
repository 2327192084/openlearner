/**
 * 从资料中提问（2026-11-10）。
 *
 * ## 它补的是哪几种范围
 *
 * `oral-review.ts` 的 `OralScope` 一开始就写了五种范围，但三期只接了
 * 「知识点随机」一条。划选提问补上了 `segment`（用户在原文里划一段）。
 * 本模块补剩下三种**按资料取**的范围：
 *
 *  - `source`  整份资料随机抽段落
 *  - `chapter` 某一份资料的某一章
 *  - `all`     整库随机（跨所有资料）
 *
 * ## 为什么单独一个文件
 *
 * 它要读库（段落表、资料表），而 `oral-review.ts` 是纯逻辑、
 * 明确声明「不发请求、不碰存储」。把存储访问塞进去会破坏那条边界，
 * 也会让它的 15 条单测需要造 StorageAdapter。
 *
 * ## 为什么不是「随机抽一段就完了」
 *
 * 用户说的是「整本书随机」——那意味着**每次换题要换一段**，而且要覆盖
 * 全书而不是总落在前几页。所以这里返回**整个候选池**（与知识点池同一
 * 形状），换题由 `pickMaterial()` 从池子里抽。池子一次读好，换题不再查库。
 *
 * 代价：一本 628 页的书全量转素材要一次读完段落表。但这与阅读器
 * 本来就读一份资料的段落是同一个量级（几十毫秒），且可接受 ——
 * 比每次换题重读一遍好得多。
 */

import type { OralMaterial } from './oral-review.ts';
import { segmentsToMaterials } from './oral-review.ts';
import type { SourceService } from './sources.ts';
import type { OralScope } from './oral-review.ts';

/** 一种可选范围（界面上的一个选项） */
export interface OralScopeOption {
  /** 稳定 id，用于 select 的 value */
  id: string;
  /** 显示文字 */
  label: string;
  /** 这个范围对应什么 */
  scope: OralScope;
  /** 能出多少条素材（界面如实显示，0 的就别给用户选） */
  count: number;
}

/**
 * 列出「从资料中提问」可选的范围。
 *
 * ## 为什么章节要单独列成选项
 *
 * 用户明确说过「某章节」。做成「先选资料、再选章节」两级下拉也行，
 * 但会把选项藏进第二层；而这个库里通常只有几份资料、每份几章，
 * 平铺成一级更省一次点击，也让「哪一章有料可问」一眼可见。
 *
 * ## 为什么 count 为 0 的范围不返回
 *
 * 硬约束第 7 条：不做假开关。选了一个没有素材的章节，
 * 进去只会看到「这一轮没问题可问」—— 不如一开始就不给选。
 *
 * ## 为什么章节名要按资料分组
 *
 * 不同资料可能有同名章节（「第一章 绪论」）。
 * 显示时带上资料名，否则用户不知道选的是哪一本的绪论。
 *
 * @param sources 要纳入的全部资料（调用方自己决定要不要按课程筛）
 */
export async function listOralScopes(
  sourceService: SourceService,
  sources: readonly { id: string; title: string }[],
): Promise<OralScopeOption[]> {
  const out: OralScopeOption[] = [];

  /*
   * 整库随机：跨资料的兜底选项，放最前面。
   *
   * count 要等读完所有段落才知道，先占位、最后回填 ——
   * 这样它永远排在第一位，不随资料数量变位置。
   */
  const allOption: OralScopeOption = {
    id: 'all',
    label: '整库随机（跨所有资料）',
    scope: { kind: 'all' },
    count: 0,
  };
  out.push(allOption);

  /* 逐份资料读段落。串行即可：通常只有个位数资料 */
  for (const src of sources) {
    const segments = await sourceService.getSegments(src.id);

    /* ---- 整份资料 ---- */
    const all = segmentsToMaterials(segments, src.title);
    if (all.length > 0) {
      out.push({
        id: `source:${src.id}`,
        label: `《${src.title}》整本`,
        scope: { kind: 'source', sourceId: src.id, title: src.title },
        count: all.length,
      });
    }
    allOption.count += all.length;

    /*
     * ---- 按章节 ----
     *
     * 用 Map 保序：章节在段落表里本来就是按顺序出现的，
     * 保序后下拉里的章序与书里的顺序一致（用户按书找章）。
     */
    const byChapter = new Map<string, typeof segments>();
    for (const s of segments) {
      const ch = s.chapter?.trim();
      if (!ch) continue;
      const arr = byChapter.get(ch) ?? [];
      arr.push(s);
      byChapter.set(ch, arr);
    }

    for (const [chapter, segs] of byChapter) {
      const mats = segmentsToMaterials(segs, src.title);
      /* 太短的章节（只剩页眉那种）跳过，不给用户一个空选项 */
      if (mats.length === 0) continue;
      out.push({
        id: `chapter:${src.id}:${chapter}`,
        label: `《${src.title}》· ${chapter}`,
        scope: { kind: 'chapter', sourceId: src.id, chapter, title: src.title },
        count: mats.length,
      });
    }
  }

  return out;
}

/**
 * 按范围取出提问素材池。
 *
 * 只做「范围 → 段落筛选」，转素材统一走 `segmentsToMaterials()`,
 * 保证与三期已有的口径一致（≥80 字、不截断、label 拼法相同）。
 */
export async function materialsForScope(
  sourceService: SourceService,
  scope: OralScope,
): Promise<OralMaterial[]> {
  switch (scope.kind) {
    case 'source': {
      const src = await sourceService.get(scope.sourceId);
      if (!src) return [];
      const segments = await sourceService.getSegments(scope.sourceId);
      return segmentsToMaterials(segments, scope.title || src.title);
    }

    case 'chapter': {
      const src = await sourceService.get(scope.sourceId);
      if (!src) return [];
      const segments = await sourceService.getSegments(scope.sourceId);
      const inChapter = segments.filter((s) => (s.chapter?.trim() ?? '') === scope.chapter.trim());
      return segmentsToMaterials(inChapter, scope.title || src.title);
    }

    case 'all': {
      /*
       * 整库随机：逐份资料读段落再拼起来。
       *
       * 不用 getAll('sourceSegments') 一次全取 —— 那样会拿到**所有**段落
       * 却没有资料标题，label 只能显示资料 id；而 `segmentsToMaterials`
       * 需要标题来拼「资料 · 章节 · 页码」。逐份读多几次库，换来正确的出处。
       */
      const sources = await sourceService.list();
      const out: OralMaterial[] = [];
      for (const src of sources) {
        const segments = await sourceService.getSegments(src.id);
        out.push(...segmentsToMaterials(segments, src.title));
      }
      return out;
    }

    /*
     * segment（划选）与 points（知识点）不走这里：
     * 前者由 ReaderPage 的选区直接产出单条，后者由 pointsToMaterials 处理。
     * 返回空数组而不是抛错 —— 调用方据此显示「这个范围没有素材」。
     */
    default:
      return [];
  }
}

/*
 * 没有 `scopeByOptionId` 这样的反查函数（2026-11-10 删掉了）。
 *
 * 第一版写过一个「按选项 id 找回 scope」的小工具，但接入时发现
 * 宿主（App）拿到选项后**同时需要 label**（要写进面板顶部的范围说明），
 * 所以本来就是 `options.find(...)` 取整个对象，反查函数纯属多余。
 * 留着它只会多一处「改了一边忘另一边」的地方。
 */

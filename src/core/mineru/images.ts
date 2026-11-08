/**
 * 把 MinerU 转换出的插图取回来、存进 sourceImages。
 *
 * ## 分工
 *
 * - `locator.ts`   —— 认定位符是什么
 * - `markdown.ts`  —— 把图在正文里的**位置**记下来
 * - `mineru-figure.cjs`（electron）—— 真的去把字节取回来
 * - **本文件**      —— 把它们串起来，决定存什么、失败怎么办
 *
 * ## 为什么失败不抛异常
 *
 * 一份书 88 张图，可能有一两张取不到（locator 指向的块被 MinerU 判成空、
 * 或解析缓存里那一页缺失）。**一张失败不该让整本书的插图功能挂掉**，
 * 更不该让「已转换好的正文」回滚 —— 正文才是主产物。
 *
 * 所以这里返回一份**如实的账**：成功几张、失败几张、各自为什么失败。
 * 界面据此说「88 张里取到 86 张」，而不是假装全成功或整个报错。
 *
 * ## 为什么不在这一层做并发
 *
 * 取图走的是 MinerU 的**单实例常驻服务**（一个 sqlite + 一个 http 服务），
 * 并发请求会增加它内部锁竞争的概率，而收益有限：
 * 实测 88 张走 HTTP 约 40 秒，串行完全可以接受，且排查问题时日志是线性的。
 * 真正的瓶颈是 Python 服务而不是网络往返，并发压不出多少。
 */

import type { SourceImageRecord } from '../model.ts';
import type { StorageAdapter } from '../storage/types.ts';
import { formatLocator, type ImageLocator } from './locator.ts';
import type { MinerUPage } from './markdown.ts';
import { nowIso } from '../id.ts';

/**
 * 本模块需要的存储能力，**只要三个方法**。
 *
 * 为什么不直接用 StorageAdapter：SourceService 的 storage 是 private，
 * 而这里不该逼它开一个后门（那等于把整库存储暴露给界面层）。
 * 声明一个最小结构，SourceService 提供一个只读的 figuresStorage 访问器即可，
 * 测试里 MemoryStorage 也天然满足。
 */
export type FigureStorage = Pick<StorageAdapter, 'getAll' | 'remove' | 'putMany'>;

/** 一张图取回来的结果（由 electron 侧提供，这里只声明形状） */
export interface FetchedFigure {
  dataUri: string;
  width: number;
  height: number;
  byteSize: number;
}

/** 取一张图的抽象。桌面版接 IPC，测试接假实现。 */
export type FigureFetcher = (locator: string) => Promise<
  { ok: true; figure: FetchedFigure } | { ok: false; error: string }
>;

/** 一次取图的结果账目 */
export interface FigureImportReport {
  sourceId: string;
  /** 正文里认出的图片总数 */
  total: number;
  /** 成功存下的张数 */
  stored: number;
  /** 外链图片（`![](https://...)`）—— 我们取不了，不算失败 */
  skippedExternal: number;
  /** 没有定位符或定位符格式不对，跳过 */
  skippedNoLocator: number;
  /** 真的去取了但失败的 */
  failed: number;
  /** 逐条失败原因，界面原样显示（不吞） */
  failures: Array<{ locator: string; error: string }>;
}

/**
 * sourceImages 的主键。
 *
 * `figure_<sourceId>_<page>_<block>` —— 用 MinerU 的 page/block 拼，
 * 同一份资料重转时是**覆盖**而不是累积。
 * 若改成随机 id，每转一次就多一整套图，库会长出一堆永远点不到的孤儿记录。
 */
export function figureId(sourceId: string, page: number, block: number): string {
  return `figure_${sourceId}_${page}_${block}`;
}

/**
 * 把一页的图片位置 + 取回的字节，拼成待入库的记录。
 *
 * 纯函数（不碰存储、不碰网络），单测直接喂样本。
 *
 * @param fetched 已取回的图，按 locator 的原串索引；取失败的不在里面
 */
export function toImageRecords(options: {
  sourceId: string;
  pages: readonly MinerUPage[];
  fetched: ReadonlyMap<string, FetchedFigure>;
  createdAt?: string;
}): SourceImageRecord[] {
  const { sourceId, pages, fetched } = options;
  const createdAt = options.createdAt ?? nowIso();
  const out: SourceImageRecord[] = [];

  for (const page of pages) {
    for (const fig of page.figures ?? []) {
      const loc = fig.locator;
      if (!loc) continue;
      const hit = fetched.get(formatLocator(loc));
      if (!hit) continue;

      out.push({
        id: figureId(sourceId, loc.page, loc.block),
        sourceId,
        page: loc.page,
        block: loc.block,
        charOffset: fig.charOffset,
        kind: fig.kind,
        dataUri: hit.dataUri,
        width: hit.width,
        height: hit.height,
        byteSize: hit.byteSize,
        caption: fig.caption,
        tier: loc.tier,
        docShortId: loc.doc,
        createdAt,
      });
    }
  }

  return out;
}

/**
 * 收集一页集合里所有**可取的**定位符（去重，保序）。
 *
 * 为什么要去重：同一张图理论上可能被两页引用（跨页图），
 * 重复取会白花一倍时间，还会得到两条记录互相覆盖。
 *
 * 为什么保序：串行取图时按正文顺序打日志，
 * 出问题能一眼看出「卡在第几张」。
 */
export function collectLocators(pages: readonly MinerUPage[]): ImageLocator[] {
  const seen = new Set<string>();
  const out: ImageLocator[] = [];
  for (const page of pages) {
    for (const fig of page.figures ?? []) {
      if (!fig.locator) continue;
      const key = formatLocator(fig.locator);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(fig.locator);
    }
  }
  return out;
}

/**
 * 统计一页集合里各类图片的数量（不算取图结果，只算正文里认出的）。
 *
 * 界面在开始取图前就能显示「这份资料有 N 张图」，不用等全部取完 ——
 * 取一本书的图要几十秒，没有预期数字用户会以为卡死了。
 */
export function countFigures(pages: readonly MinerUPage[]): {
  total: number;
  external: number;
  byKind: Record<string, number>;
} {
  let total = 0;
  let external = 0;
  const byKind: Record<string, number> = {};
  for (const page of pages) {
    for (const fig of page.figures ?? []) {
      total += 1;
      if (!fig.locator) external += 1;
      byKind[fig.kind] = (byKind[fig.kind] ?? 0) + 1;
    }
  }
  return { total, external, byKind };
}

/**
 * 取回一份资料的全部插图，并写进 sourceImages。
 *
 * 行为约定（都是「不假装」）：
 *  - 取不到的**不存空记录**。宁可少一张图，也不要存一条 dataUri 为空、
 *    渲染出来是破图的记录 —— 那会让用户以为资料有问题。
 *  - 重转时先清掉这份资料的旧图，再写新的。否则上次的图会以孤儿形式留着，
 *    而且 charOffset 可能已经变了，插回位置全错。
 *  - 一张都没取到不算失败（可能整本都是扫描图，MinerU 没切出图片块）。
 *
 * @returns 如实的账目；界面据此汇报，不吞失败
 */
export async function importFigures(options: {
  storage: FigureStorage;
  sourceId: string;
  pages: readonly MinerUPage[];
  fetcher: FigureFetcher;
  /** 进度回调：已处理 / 总数。界面用来显示「正在取第 12/88 张」 */
  onProgress?: (done: number, total: number) => void;
}): Promise<FigureImportReport> {
  const { storage, sourceId, pages, fetcher } = options;

  const locators = collectLocators(pages);
  const counts = countFigures(pages);

  const fetched = new Map<string, FetchedFigure>();
  const failures: Array<{ locator: string; error: string }> = [];

  let done = 0;
  for (const loc of locators) {
    const key = formatLocator(loc);
    const r = await fetcher(key);
    if (r.ok) fetched.set(key, r.figure);
    else failures.push({ locator: key, error: r.error });
    done += 1;
    options.onProgress?.(done, locators.length);
  }

  const records = toImageRecords({ sourceId, pages, fetched });

  /*
   * 先删旧图。
   *
   * 为什么不「按 id 覆盖」就完事：重转后 block 编号可能变
   * （MinerU 换了 tier、或版面模型升级），旧 id 就再也匹配不上，
   * 那些记录会永远留着，还带着过期的 charOffset。
   */
  const old = await storage.getAll('sourceImages');
  for (const rec of old) {
    if (rec.sourceId === sourceId) await storage.remove('sourceImages', rec.id);
  }

  if (records.length > 0) await storage.putMany('sourceImages', records);

  return {
    sourceId,
    total: counts.total,
    stored: records.length,
    skippedExternal: counts.external,
    skippedNoLocator: counts.total - counts.external - locators.length,
    failed: failures.length,
    failures,
  };
}

/**
 * 取一份资料的全部插图记录（渲染用，按页 + 位置排序）。
 *
 * 排序**必须稳定且与正文一致**：同一页里多张图时按 charOffset 升序，
 * 否则渲染出来图序会和原文不符，而用户对着原书看会以为程序弄错了。
 */
export async function loadFigures(
  storage: StorageAdapter,
  sourceId: string,
): Promise<SourceImageRecord[]> {
  const all = await storage.getAll('sourceImages');
  return all
    .filter((r) => r.sourceId === sourceId)
    .sort((a, b) =>
      a.page !== b.page ? a.page - b.page : a.charOffset - b.charOffset,
    );
}

/**
 * 把一批图片按「插在第几个字符」拆进正文。
 *
 * 纯函数，渲染层直接调。返回的是**切片计划**而不是 DOM ——
 * 这样这段逻辑能单测，不必挂 React。
 *
 * ## 为什么用「插在 offset 之前」而不是「替换某个区间」
 *
 * 正文里图片原本就不占字符（转换时整行丢掉了，text 是纯文字）。
 * 所以没有区间可替换，只有「在这儿插一个东西」。
 *
 * ## 边界怎么处理
 *
 * - offset <= 0        → 插到最前
 * - offset >= 文本长度 → 插到最后
 * - offset 相同        → 按输入顺序（同一位置多张图不丢）
 *
 * @returns 形如 `[{ text: '前一段' }, { figure }, { text: '后一段' }]` 的序列，
 *          相邻的 text 片段**不合并**（渲染层自己决定怎么拼段）
 */
export type SplitPiece =
  | { kind: 'text'; text: string }
  | { kind: 'figure'; figure: SourceImageRecord };

export function splitByFigures(
  text: string,
  figures: readonly SourceImageRecord[],
): SplitPiece[] {
  if (figures.length === 0) {
    return text ? [{ kind: 'text', text }] : [];
  }

  const sorted = [...figures].sort((a, b) => {
    const ao = clamp(a.charOffset, text.length);
    const bo = clamp(b.charOffset, text.length);
    return ao - bo;
  });

  const out: SplitPiece[] = [];
  let cursor = 0;

  for (const fig of sorted) {
    const at = clamp(fig.charOffset, text.length);
    if (at > cursor) {
      out.push({ kind: 'text', text: text.slice(cursor, at) });
      cursor = at;
    }
    out.push({ kind: 'figure', figure: fig });
  }

  if (cursor < text.length) {
    out.push({ kind: 'text', text: text.slice(cursor) });
  }

  return out;
}

function clamp(n: number, max: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, n));
}

/** 供渲染层判断：这段文本里有没有图（没有就走原来的纯文本路径，零开销） */
export function hasFigures(figures: readonly SourceImageRecord[]): boolean {
  return figures.length > 0;
}

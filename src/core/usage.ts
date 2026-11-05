import type { UsageRecord } from './model.ts';
import type { StorageAdapter } from './storage/types.ts';
import { nowIso } from './id.ts';

/**
 * 用量统计。
 *
 * ## 要解决的问题
 *
 * 用户填的是自己的 Key，账单是真金白银。P5 第 5 条要求「用量统计按后端按天」。
 * 但「统计」这个词很容易做过：做成一屏折线图、每次调用一条流水、精确到毫秒，
 * 结果用户还是只知道「花了一些」。所以这里只回答三个问题：
 *
 *   1. 今天/这个月，我用了多少 token？（以及大概多少钱）
 *   2. 是哪个后端用的？（多服务商之后，用户需要知道哪家在花钱）
 *   3. 花在整理上多，还是出题上多？
 *
 * ## 为什么是聚合而不是流水账
 *
 * 一次整理可能发好几次请求，一次出题也是。按次存，一个月几千条，
 * 而用户关心的粒度是「天」。所以主键是确定性三元组
 * `${day}|${backendId}|${kind}`，重复写入即累加，天然幂等。
 *
 * 好处：记录数有上界（天数 × 后端数 × 2），不会无限膨胀；
 * 写入不需要先查再改（可以直接 put 同一个 id）。
 *
 * ## 什么不算进来
 *
 * - 失败的调用：服务端没返回 usage 就没有 token 数，**不猜**。
 *   请求可能确实计费了，但我们不知道多少，编一个数字进账单比不记更糟。
 * - 假后端（MockBackend / MockQuestionBackend）：没花用户一分钱，
 *   记进来只会让真实花费看起来更多。
 */

/** 本地日期 YYYY-MM-DD。按本地时区切天，不能用 toISOString（那是 UTC） */
export function localDay(at: Date = new Date()): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 确定性主键，保证同一格只有一条记录 */
export function usageKey(day: string, backendId: string, kind: UsageRecord['kind']): string {
  return `${day}|${backendId}|${kind}`;
}

/** 记一笔用量的输入 */
export interface UsageEntry {
  backendId: string;
  provider: string;
  kind: UsageRecord['kind'];
  tokens: number;
  /** 调用了几次请求（一次整理可能含多次 chat 请求） */
  calls?: number;
  /** 注入时钟便于测试 */
  at?: Date;
}

/** 按后端汇总的一行 */
export interface UsageByBackend {
  backendId: string;
  provider: string;
  tokens: number;
  calls: number;
  organizeTokens: number;
  questionsTokens: number;
  /** 生成 PPT 大纲的 token（与整理/出题分开，便于判断钱花在哪一环） */
  slidesTokens: number;
  lastAt: string;
}

/** 按天的一行（给界面画趋势用） */
export interface UsageByDay {
  day: string;
  tokens: number;
  calls: number;
}

export class UsageService {
  constructor(private readonly storage: StorageAdapter) {}

  /**
   * 记一笔用量。
   *
   * tokens <= 0 时直接返回 null，不写库：服务端没给 usage 时
   * 我们宁可留空，也不留一个 0 让用户以为「白用了」。
   */
  async record(entry: UsageEntry): Promise<UsageRecord | null> {
    if (!Number.isFinite(entry.tokens) || entry.tokens <= 0) return null;

    const at = entry.at ?? new Date();
    const day = localDay(at);
    const id = usageKey(day, entry.backendId, entry.kind);
    const existing = await this.storage.get('usageRecords', id);

    const next: UsageRecord = {
      id,
      day,
      backendId: entry.backendId,
      provider: entry.provider,
      kind: entry.kind,
      calls: (existing?.calls ?? 0) + Math.max(1, entry.calls ?? 1),
      tokens: (existing?.tokens ?? 0) + entry.tokens,
      lastAt: nowIso(),
    };

    await this.storage.put('usageRecords', next);
    return next;
  }

  /** 全部记录，按日期倒序（最近的在前） */
  async list(): Promise<UsageRecord[]> {
    const all = await this.storage.getAll('usageRecords');
    return all.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  }

  /**
   * 按后端汇总。
   *
   * 排序按 token 从多到少 —— 用户打开这一页最想知道「谁在花钱」，
   * 花钱最多的排最上面才一眼看到。
   */
  async byBackend(from?: string, to?: string): Promise<UsageByBackend[]> {
    const rows = await this.filterByDay(from, to);
    const map = new Map<string, UsageByBackend>();

    for (const r of rows) {
      const cur = map.get(r.backendId) ?? {
        backendId: r.backendId,
        provider: r.provider,
        tokens: 0,
        calls: 0,
        organizeTokens: 0,
        questionsTokens: 0,
        slidesTokens: 0,
        lastAt: r.lastAt,
      };
      cur.tokens += r.tokens;
      cur.calls += r.calls;
      /**
       * 按用途分流，必须是穷举而不是 if/else。
       *
       * 早先是 `else cur.questionsTokens += ...`，加进 'slides' 之后
       * 生成 PPT 的钱会被算到「出题」名下 —— 数字没错，归属错了，
       * 而这种错很难被发现（总数对得上，用户不会去核对分项）。
       */
      if (r.kind === 'organize') cur.organizeTokens += r.tokens;
      else if (r.kind === 'questions') cur.questionsTokens += r.tokens;
      else if (r.kind === 'slides') cur.slidesTokens += r.tokens;
      // 记录里 lastAt 是一切写入的时间，取最晚的那条
      if (r.lastAt > cur.lastAt) cur.lastAt = r.lastAt;
      map.set(r.backendId, cur);
    }

    return [...map.values()].sort((a, b) => b.tokens - a.tokens);
  }

  /** 按天汇总，日期升序（画趋势从左到右） */
  async byDay(from?: string, to?: string): Promise<UsageByDay[]> {
    const rows = await this.filterByDay(from, to);
    const map = new Map<string, UsageByDay>();

    for (const r of rows) {
      const cur = map.get(r.day) ?? { day: r.day, tokens: 0, calls: 0 };
      cur.tokens += r.tokens;
      cur.calls += r.calls;
      map.set(r.day, cur);
    }

    return [...map.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }

  /** 合计。界面顶部那一行「共 X token」 */
  async total(from?: string, to?: string): Promise<{ tokens: number; calls: number }> {
    const rows = await this.filterByDay(from, to);
    return rows.reduce(
      (acc, r) => ({ tokens: acc.tokens + r.tokens, calls: acc.calls + r.calls }),
      { tokens: 0, calls: 0 },
    );
  }

  /** 清空用量记录（用户换 Key / 重新开始记账时用） */
  async clear(): Promise<void> {
    await this.storage.clear('usageRecords');
  }

  /** from/to 都是 YYYY-MM-DD 闭区间，省略表示不限 */
  private async filterByDay(from?: string, to?: string): Promise<UsageRecord[]> {
    const all = await this.storage.getAll('usageRecords');
    return all.filter((r) => {
      if (from && r.day < from) return false;
      if (to && r.day > to) return false;
      return true;
    });
  }
}

/**
 * 本月第一天（本地时区）。界面默认看本月，避免一上来就是「全部历史」的一堆数字。
 */
export function startOfMonth(at: Date = new Date()): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

/**
 * 粗略折算成人民币。
 *
 * ## 为什么给一个汇率表而不是精确计价
 *
 * 各家价格差异极大（glm-4-flash 近乎免费、gpt-4o-mini 与 deepseek-chat 差一个量级），
 * 而且随时调价、还分输入/输出两档。真按官方价算需要维护一张会过期的价目表，
 * 算出来的数字还未必对（缓存命中、批量折扣、阶梯价）。
 *
 * 所以这里只给**数量级参考**，并在界面上明确写「估算，实际以账单为准」。
 * 用户真正需要的是「这个月大概花了几块钱」而不是精确到分。
 *
 * 单位：元 / 百万 token。取各家公开价的中位数量级，不追求准确。
 */
const RATE_PER_MILLION: Record<string, number> = {
  deepseek: 2,
  moonshot: 12,
  zhipu: 2,
  dashscope: 4,
  siliconflow: 4,
  volcengine: 4,
  openai: 15,
  custom: 8,
};

/** 认不出的服务商按中间价算，避免显示 0 元让用户误以为免费 */
const FALLBACK_RATE = 8;

export function estimateCostCny(tokens: number, provider: string): number {
  const rate = RATE_PER_MILLION[provider] ?? FALLBACK_RATE;
  return (tokens / 1_000_000) * rate;
}

/** 把金额格式化成人看得懂的样子：不到一分钱就说「不到 0.01 元」 */
export function formatCost(cny: number): string {
  if (cny <= 0) return '0 元';
  if (cny < 0.01) return '不到 0.01 元';
  if (cny < 1) return `${cny.toFixed(2)} 元`;
  return `${cny.toFixed(2)} 元`;
}

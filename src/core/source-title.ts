/**
 * 资料标题的消歧（2026-11-11）。
 *
 * ## 为什么需要
 *
 * 实测用户的库里有**两份同名资料**，都叫
 * 「信号与系统（第二版）第1章 信号与系统 正文（不含习题）」——
 * 它们来自同一次导入（用户导了两次），但内容不同：
 * 一份 36 页完整、另一份只有 1-2 页。
 *
 * 在「文档解析」「整理知识点」这类下拉/列表里，两行字一模一样，
 * 用户只能靠猜。实测已经导致过一次误操作：把分片解析写到了错的那一份上。
 *
 * ## 怎么做
 *
 * 只给**重名的那几份**加后缀，不重名的保持干净：
 *
 * ```
 * 信号与系统（第二版）第1章…          ← 只有一份时，什么都不加
 * 信号与系统（第二版）第1章…（2）      ← 重名时按导入时间排序编号
 * ```
 *
 * 为什么不给所有资料都加日期：绝大多数情况下用户不需要看见它，
 * 每行都拖着「11-11 13:25」只是噪音。**只在有歧义时**提供区分信息。
 *
 * 为什么编号按 createdAt 排：这样编号是稳定的 ——
 * 只要不增删资料，同一份资料每次看到的编号都一样。
 * 若按列表当前顺序编号，排序一变（比如「待解析」排前面）编号就跟着变，
 * 用户会以为选错了。
 */

export interface TitledItem {
  id: string;
  title: string;
  /** 导入时间（ISO）。用于重名时决定编号顺序 */
  createdAt?: string;
}

/**
 * 给重名的资料加编号后缀。
 *
 * @returns id → 显示用标题。**不重名的条目原样返回**
 */
export function disambiguateTitles<T extends TitledItem>(
  items: readonly T[],
): Map<string, string> {
  const out = new Map<string, string>();

  /* 按标题分组 */
  const byTitle = new Map<string, T[]>();
  for (const it of items) {
    const key = it.title.trim();
    const arr = byTitle.get(key);
    if (arr) arr.push(it);
    else byTitle.set(key, [it]);
  }

  for (const [title, group] of byTitle) {
    if (group.length === 1) {
      out.set(group[0]!.id, title);
      continue;
    }
    /*
     * 重名：按 createdAt 升序（早导入的编号小）。
     * createdAt 缺失时排在后面 —— 不让它抢走「（1）」那个位置。
     */
    const sorted = [...group].sort((a, b) => {
      const ta = a.createdAt ?? '';
      const tb = b.createdAt ?? '';
      if (ta === tb) return 0;
      if (!ta) return 1;
      if (!tb) return -1;
      return ta < tb ? -1 : 1;
    });
    sorted.forEach((it, i) => {
      out.set(it.id, `${title}（${i + 1}）`);
    });
  }

  return out;
}

/**
 * 把 ISO 时间格式化成「11-11 13:25」，供需要显示导入时间的地方用。
 *
 * 与重名编号互补：编号负责「列表里区分」，这个负责「详情里说清是哪次导入」。
 */
export function formatImportedAt(iso: string | undefined | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

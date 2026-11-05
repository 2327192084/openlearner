import type { SlideCitation, SlideDeck, SlideExportRecord } from '@/core/model.ts';

/**
 * 学习 PPT 页（P4）共用的小类型与展示映射。
 *
 * 与资料页（P1）、知识点页（P2）、习题集页（P3）的 `types.ts` 同形但**各有一份**：
 * 四个页面分属不同阶段，共用一个模块会让改一边直接影响另一边。
 * 形状保持一致即可，不需要在代码上耦合。
 */

/**
 * 异步状态用联合类型而不是 `{loading, error, data}` 三件套：
 * 后者允许「加载中且已有数据」这种自相矛盾的状态出现在界面上。
 */
export type Load<T> =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; hint: string }
  | { kind: 'ready'; data: T };

/** 页内提示条，直接喂给 Notice */
export type Flash = { tone: 'info' | 'warning' | 'danger'; text: string } | null;

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 从异常里取「下一步」。
 *
 * core 的错误对象带 `hint` 时优先用它；没有就用调用方给的兜底文案。
 * 全项目不允许出现只说「操作失败」的提示。
 */
export function hintFrom(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'hint' in err) {
    const hint = (err as { hint?: unknown }).hint;
    if (typeof hint === 'string' && hint.trim() !== '') return hint;
  }
  return fallback;
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '未知';
  return n.toLocaleString('zh-CN');
}

export function formatTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString('zh-CN', { hour12: false });
}

/** 导出文件大小。0 字节也如实显示，不写成「未知」。 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** `bytes` 的精确值也给出，方便用户核对导出记录（如 1.2 MB / 1,234,567 字节） */
export function sizeDetail(bytes: number): string {
  if (!Number.isFinite(bytes)) return '';
  return `${formatCount(bytes)} 字节`;
}

export const LAYOUT_LABEL: Record<string, string> = {
  title: '封面',
  section: '章节',
  bullets: '要点',
  sources: '资料',
};

export function layoutLabel(layout: string): string {
  return LAYOUT_LABEL[layout] ?? layout;
}

/** 版式徽章的色调：封面用 info、章节用 neutral、要点用 ready、资料用 planned */
export function layoutTone(layout: string): 'neutral' | 'planned' | 'ready' | 'info' | 'danger' {
  if (layout === 'title') return 'info';
  if (layout === 'section') return 'neutral';
  if (layout === 'bullets') return 'ready';
  return 'planned';
}

/**
 * 封面页不能删除也不能移动 —— core 会直接抛错。
 *
 * 界面上仍然把按钮渲染出来但置为 disabled，并在旁边写清原因：
 * 直接隐藏按钮会让用户以为「这页本来就不能动」，而实际是这一页比较特殊。
 */
export function isPinnedPage(layout: string): boolean {
  return layout === 'title';
}

/** 大纲里每页的要点统计，用于「N 条要点，其中 M 条有出处」 */
export interface PageStats {
  bullets: number;
  withCitation: number;
  withoutCitation: number;
}

export function pageStats(deck: SlideDeck, pageId: string): PageStats {
  const page = deck.pages.find((p) => p.id === pageId);
  if (!page) return { bullets: 0, withCitation: 0, withoutCitation: 0 };
  const bullets = page.bullets.length;
  const withCitation = page.bullets.filter((b) => b.citationIndex !== null).length;
  return { bullets, withCitation, withoutCitation: bullets - withCitation };
}

/** 整份 PPT 的要点统计（只看大纲，不含派生的资料页） */
export function deckBulletStats(deck: SlideDeck): PageStats {
  let bullets = 0;
  let withCitation = 0;
  for (const page of deck.pages) {
    for (const bullet of page.bullets) {
      bullets += 1;
      if (bullet.citationIndex !== null) withCitation += 1;
    }
  }
  return { bullets, withCitation, withoutCitation: bullets - withCitation };
}

/**
 * 找到某个角标编号对应的引用。
 *
 * 返回 null 表示**大纲里还有角标但引用表里没有这一条**——这是数据不一致，
 * 界面上要如实说出来，不能画一个指向空的角标。
 */
export function citationOf(deck: SlideDeck, index: number | null): SlideCitation | null {
  if (index === null) return null;
  return deck.citations.find((c) => c.index === index) ?? null;
}

export function lastExport(deck: SlideDeck): SlideExportRecord | null {
  if (deck.exports.length === 0) return null;
  return deck.exports[deck.exports.length - 1] ?? null;
}

/**
 * 导出之后又改过吗？
 *
 * 坑：`SlideService.export()` 自己也会写 `updatedAt`（它走的是同一条 mutate 路径），
 * 所以正常导出一次后 `updatedAt` 会**比 `exportedAt` 晚几毫秒**。
 * 如果直接比 `updatedAt > exportedAt`，每次刚导完就会立刻提示「导出后又改过」，
 * 用户会以为导出坏了。
 *
 * 因此留一个宽限窗口：只有超过 1.5 秒才认定是用户真的改过。
 * 用户手改大纲不可能在 1.5 秒内完成，这个窗口不会漏报。
 */
export const EDIT_AFTER_EXPORT_GRACE_MS = 1500;

export function editedAfterLastExport(deck: SlideDeck): boolean {
  const record = lastExport(deck);
  if (!record) return false;
  const exportedAt = new Date(record.exportedAt).getTime();
  const updatedAt = new Date(deck.updatedAt).getTime();
  if (Number.isNaN(exportedAt) || Number.isNaN(updatedAt)) return false;
  return updatedAt - exportedAt > EDIT_AFTER_EXPORT_GRACE_MS;
}

/** 删除确认文案：说清会丢什么，并给一个替代方案 */
export function deleteConfirmText(deck: SlideDeck): string {
  const pages = deck.pages.length;
  const exports = deck.exports.length;
  const lines = [
    `删除「${deck.title}」？`,
    '',
    `这份大纲共 ${pages} 页${exports > 0 ? `，导出过 ${exports} 次` : ''}。`,
    '删除后这份 PPT 和它的导出记录都会从本机移除，此操作不可撤销。',
    '',
    '已导出的 .pptx 文件在下载目录里不受影响，仍然可以打开。',
  ];
  return lines.join('\n');
}

import type { Source, SourceTextStatus } from '@/core/model.ts';
import type { ImportFailureCode } from '@/core/parsers/types.ts';

/**
 * 资料页的展示格式化。
 *
 * 全部集中在这里，理由和设计令牌一样：同一种信息在列表、详情、阅读器
 * 三处必须长得一样，否则用户会以为它们是不同的东西。
 */

const KIND_LABEL: Record<Source['kind'], string> = {
  pdf: 'PDF',
  docx: 'Word',
  pptx: 'PPT',
  markdown: 'Markdown',
  text: '文本',
};

export function kindLabel(kind: Source['kind']): string {
  return KIND_LABEL[kind] ?? '未知';
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
}

/** 字节数。粘贴文本的 byteSize 是编码后字节数，不是字数，这里不换算成「字」。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 页数未知时明确说「页数未知」，不要显示 0 页——0 页看起来像文件坏了 */
export function formatPageCount(pageCount: number | null): string {
  return pageCount === null ? '页数未知' : `${pageCount} 页`;
}

export const TEXT_STATUS_LABEL: Record<
  SourceTextStatus,
  { text: string; tone: 'ready' | 'planned'; hint: string }
> = {
  ready: {
    text: '文本可搜索',
    tone: 'ready',
    hint: '这份资料有文字层，可以全文搜索并把命中处跳回原文。',
  },
  'no-text-layer': {
    text: '扫描件·无文字层',
    tone: 'planned',
    hint: '这份是扫描件，只能翻看，搜不出文字。P6 会接入看图模型来读它——它没有被当成导入失败。',
  },
};

/** 六种导入失败原因的中文短标签，用在结果列表的徽标上；完整说明用 core 给的 hint */
export const FAILURE_LABEL: Record<ImportFailureCode, string> = {
  'unsupported-format': '格式不支持',
  corrupted: '文件损坏',
  encrypted: '有密码保护',
  empty: '没有内容',
  'too-large': '文件太大',
  unknown: '未预期的问题',
};

/** 搜索命中处的「第 N 页」写法，带章节时一并显示，方便判断上下文 */
export function hitLocationLabel(page: number, chapter: string | null): string {
  return chapter ? `${chapter} · 第 ${page} 页` : `第 ${page} 页`;
}

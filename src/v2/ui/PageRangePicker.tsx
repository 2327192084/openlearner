/**
 * 解析方式选择：完整解析 / 分片解析（2026-11-11）。
 *
 * ## 用户要求
 *
 * 「将 pdf 解析功能增加两个解析方式，一个是完整解析，一个是分片解析。
 *   完整解析就是直接让 MinerU 全部解析完整个导入资料的内容，
 *   而分片解析可以选择解析页数，解析从哪一页开始到哪一页结束。」
 *
 * ## 为什么分片有用
 *
 * MinerU 跑整本教材要几十分钟（`ConvertPanel` 里原本就写着这句）。
 * 用户常常只想先看某一章 —— 解析 3-15 页几十秒就好了。
 * 这是把「能不能试一下」的门槛从「几十分钟」降到「几十秒」。
 *
 * ## 为什么单独一个文件
 *
 * `ConvertPanel.tsx` 已 444 行。硬约束 5：新增 UI 一律独立文件。
 *
 * ## 校验放在哪
 *
 * 这里只做**即时提示**（起点大于终点时立刻变红），真正的拦截在
 * `electron/mineru.cjs` 的 validateRequest 里 —— 渲染层的校验永远
 * 不能当成安全边界，而且主进程那边的提示词更完整。
 */

import { useMemo } from 'react';

export type ParseMode = 'full' | 'range';

export interface PageRangePickerProps {
  mode: ParseMode;
  onModeChange: (next: ParseMode) => void;
  /** 起始页（1 基） */
  start: string;
  onStartChange: (next: string) => void;
  /** 结束页（1 基，含） */
  end: string;
  onEndChange: (next: string) => void;
  /**
   * 这份资料的总页数（可能为 null）。
   *
   * 用它做「结束页默认填总页数」和软提示，但**不做硬性上限** ——
   * 导入时记录的页数可能为空或不准（加密 / 扫描件），硬拦会误伤。
   */
  pageCount?: number | null;
  /** 是否禁用（解析中） */
  disabled?: boolean;
}

/** 把 start/end 收成一个 MinerU 认识的 `--pages` 值 */
export function toPagesArg(mode: ParseMode, start: string, end: string): string {
  if (mode === 'full') return 'all';
  const s = Number.parseInt(start, 10);
  const e = Number.parseInt(end, 10);
  if (!Number.isFinite(s)) return 'all';
  const ee = Number.isFinite(e) ? e : s;
  return s === ee ? String(s) : `${s}-${ee}`;
}

/**
 * 把 `--pages` 参数翻成「这次解析真正覆盖了哪几页」（2026-11-11 晚）。
 *
 * ## 为什么需要它
 *
 * 取图那一步（`importFigures`）要按页清理旧图：分片解析 1-2 页时
 * 只能删第 1-2 页的旧图，第 3-36 页的必须留着。
 * 否则用户分片解析后，别的页的插图会全被删掉 ——
 * 实测就是「文字还在，图没了」。
 *
 * ## 为什么不用 `result.pages` 推断
 *
 * `parseMarkdown` 会把结果补成整本页数，分片解析时补位出几十个空页；
 * 而**完整解析时某页若没有产出，那页也是补位空页**。
 * 两种模式在 `pages` 的形状上无法区分，只有调用方知道自己传的是
 * `--pages all` 还是 `--pages 1-2`。所以显式换算。
 *
 * @returns `undefined` = 覆盖整份（完整解析，清理全部旧图）；
 *          数组 = 只覆盖这几页
 */
export function pagesArgToCoveredPages(pagesArg: string): number[] | undefined {
  const s = String(pagesArg ?? '').trim();
  if (!s || s === 'all') return undefined;

  const out: number[] = [];
  for (const part of s.split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(seg);
    if (m) {
      const a = Number.parseInt(m[1]!, 10);
      const b = Number.parseInt(m[2]!, 10);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let p = lo; p <= hi; p++) out.push(p);
      continue;
    }
    const one = Number.parseInt(seg, 10);
    if (Number.isFinite(one)) out.push(one);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 校验页范围（2026-11-11）。
 *
 * ## 为什么单独导出
 *
 * 这个判断原来是 `PageRangePicker` 内部的一个 useMemo，只用来显示红字提示 ——
 * **但它不阻止提交**。实测后果：用户在一份只有 2 页的资料上填 3-4 页，
 * 界面只提示一句，仍然点了下去，MinerU 照解析，写回时把 36 段塞进那份资料
 * （前两页清空、3-4 页是别的文件的内容）。
 *
 * 现在 `ConvertPanel` 在提交前也调它 —— 有一处说不通就不发请求。
 *
 * @returns 说得通返回 null；否则返回给用户看的一句话
 */
export function validatePageRange(
  mode: ParseMode,
  start: string,
  end: string,
  pageCount?: number | null,
): string | null {
  if (mode === 'full') return null;
  const s = Number.parseInt(start, 10);
  const e = Number.parseInt(end, 10);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return '请把起始页和结束页都填上。';
  if (s < 1) return '起始页从 1 开始。';
  if (e < s) return '结束页不能小于起始页。';
  /*
   * 超出总页数是**硬错误**，不是提醒。
   *
   * 为什么敢拦：`pageCount` 来自导入时解析出的真实页数，PDF 与图片都有。
   * 万一它不准（极少数），MinerU 那边仍会给出它自己的错 ——
   * 而放过去写坏用户已有正文的代价，比偶尔误拦大得多。
   */
  if (pageCount && e > pageCount) {
    return `这份资料只有 ${pageCount} 页，结束页超出去了。`;
  }
  return null;
}

export function PageRangePicker({
  mode,
  onModeChange,
  start,
  onStartChange,
  end,
  onEndChange,
  pageCount,
  disabled,
}: PageRangePickerProps) {
  /** 即时判断范围是否说得通（只用于提示，不替代主进程校验） */
  /* 与提交前用的是同一个判断 —— 一处写两遍迟早会不一致 */
  const problem = useMemo(
    () => validatePageRange(mode, start, end, pageCount),
    [mode, start, end, pageCount],
  );

  const pages = Math.max(1, (Number.parseInt(end, 10) || 0) - (Number.parseInt(start, 10) || 0) + 1);

  return (
    <div className="prp">
      <div className="prp__modes" role="radiogroup" aria-label="解析方式">
        <label className={`prp__mode${mode === 'full' ? ' prp__mode--on' : ''}`}>
          <input
            type="radio"
            name="parse-mode"
            checked={mode === 'full'}
            disabled={disabled}
            onChange={() => onModeChange('full')}
          />
          <span className="prp__mode-name">完整解析</span>
          <span className="prp__mode-hint">
            整份从头到尾解析一遍
            {pageCount ? `（共 ${pageCount} 页）` : ''}
          </span>
        </label>

        <label className={`prp__mode${mode === 'range' ? ' prp__mode--on' : ''}`}>
          <input
            type="radio"
            name="parse-mode"
            checked={mode === 'range'}
            disabled={disabled}
            onChange={() => onModeChange('range')}
          />
          <span className="prp__mode-name">分片解析</span>
          <span className="prp__mode-hint">只解析指定的页范围，快得多</span>
        </label>
      </div>

      {mode === 'range' ? (
        <div className="prp__range">
          <label className="prp__field">
            <span className="prp__label">从第</span>
            <input
              className="prp__input"
              type="number"
              min={1}
              value={start}
              disabled={disabled}
              onChange={(e) => onStartChange(e.target.value)}
              aria-label="起始页"
            />
            <span className="prp__label">页</span>
          </label>
          <label className="prp__field">
            <span className="prp__label">到第</span>
            <input
              className="prp__input"
              type="number"
              min={1}
              value={end}
              disabled={disabled}
              onChange={(e) => onEndChange(e.target.value)}
              aria-label="结束页"
            />
            <span className="prp__label">页</span>
          </label>

          {!problem ? (
            <span className="prp__ok">
              将解析 {start === end ? `第 ${start} 页` : `第 ${start}–${end} 页`}（{pages} 页）
            </span>
          ) : (
            <span className="prp__bad">{problem}</span>
          )}
        </div>
      ) : null}

      {mode === 'range' ? (
        <p className="prp__note">
          分片解析只转这一段，<strong>其他页的正文会保留</strong> ——
          可以分几次把整本凑齐（重新解析同一页会覆盖该页的旧内容）。
        </p>
      ) : null}
    </div>
  );
}

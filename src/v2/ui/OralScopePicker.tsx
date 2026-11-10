/**
 * 提问范围选择器（2026-11-10）。
 *
 * ## 它解决什么
 *
 * 三期做提问式复习时只接了「知识点随机」一条路。用户最初要的是
 * 整本书 / 某章节 / 某段落 / 知识点四种范围。段落由阅读器划选补上，
 * 剩下的「整本 / 章节 / 整库」都落在本组件里。
 *
 * ## 为什么抽成独立文件
 *
 * `OralReviewPanel.tsx` 已经 441 行、`App.tsx` 1500+。项目对往大文件里
 * 插代码有过教训（GeneratePage 的 CRLF 混用、ReaderPage 900+ 行时
 * 抽 ReaderSidePanel）。所以新 UI 一律独立文件，宿主只插一行引用。
 *
 * ## 为什么是「一个下拉」而不是「资料 + 章节两级」
 *
 * 用户说的「某章节」用两级要两次点击；而这个库通常只有几份资料、
 * 每份几章，平铺成一级的选项更少一步，也让「哪一章有料可问」一眼可见。
 * 选项 label 里带书名（`《信号与系统》· 1.1 信号`），
 * 同名章节不会混（不同资料都可能有「第一章 绪论」）。
 *
 * ## 为什么 count 要显示出来
 *
 * 「《概率论》整本（12）」告诉用户这段范围里有多少段可问。
 * 不显示的话，选了「整本」却只问到同一段几百次，用户会以为功能坏了。
 */

import { useCallback } from 'react';
import type { OralScopeOption } from '@/core/oral-scope-service.ts';
import './oral-scope.css';

export interface OralScopePickerProps {
  /** 可选范围（不可选的、素材为 0 的已由服务层过滤掉） */
  options: readonly OralScopeOption[];
  /** 当前选中的选项 id */
  value: string;
  /** 换范围 */
  onChange: (id: string) => void;
  /** 正在按新范围取素材（期间禁用，避免连点） */
  loading?: boolean;
  /** 取素材失败时的说明 */
  error?: string | null;
  /** 不能选范围的原因（比如没接模型）；有值就禁用并说明 */
  disabledReason?: string | null;
}

export function OralScopePicker({
  options,
  value,
  onChange,
  loading = false,
  error,
  disabledReason,
}: OralScopePickerProps) {
  const handleChange = useCallback(
    (id: string) => {
      if (loading || disabledReason) return;
      onChange(id);
    },
    [loading, disabledReason, onChange],
  );

  /*
   * 没有任何可选范围（全新库、或所有资料都没正文）。
   * 如实说明，不摆一个空下拉 —— 那与「假开关」是同一类问题。
   */
  const usable = options.filter((o) => o.count > 0);

  if (usable.length === 0) {
    return (
      <p className="osp__empty">
        这个库里还没有能提问的正文。先导入资料，
        {
          // 资料太短（只有页眉）时也不算「能提问」—— 说清楚比让人猜好
        }
        或者换一份有正文的资料。
      </p>
    );
  }

  return (
    <div className="osp">
      <label className="osp__field">
        <span className="osp__label">提问范围</span>
        <select
          className="osp__select"
          value={value}
          disabled={loading || Boolean(disabledReason)}
          onChange={(e) => handleChange(e.target.value)}
          title={disabledReason ?? '选从哪部分内容出题'}
        >
          {usable.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}（{o.count}）
            </option>
          ))}
        </select>
      </label>

      {loading ? <span className="osp__hint">正在取这段内容…</span> : null}
      {error ? <span className="osp__error">{error}</span> : null}
      {disabledReason ? <span className="osp__hint">{disabledReason}</span> : null}
    </div>
  );
}

/**
 * 解析引擎选择器（2026-11-15，用户要求）。
 *
 * ## 用户原话
 *
 * > 「最近 deepseek 公开了功能 api，其中有 ocr 识别的功能，
 * >  能不能把调用 ocr 识别作为除了本地模型解析 pdf 的另一方式」
 *
 * 并且选了「并列两条路，用户自己选」。
 *
 * ## 为什么要把代价写在选择器上
 *
 * 两条路各有明确代价，用户选之前必须知道，否则选完发现不对会以为坏了：
 *
 * | | 本地 MinerU | DeepSeek 云 OCR |
 * |---|---|---|
 * | 网络 | 不需要 | **必须联网** |
 * | 装环境 | 要先装 MinerU | 不用 |
 * | 钱 | 免费 | **1.5 元 / 1000 页** |
 * | 插图 | **有**（切图 + 位置） | **没有，只有文字** |
 * | 章节 | 会从标题推 | 不给 |
 * | 大文件 | 分片可行 | 180 秒总时长，**大文件很可能超时** |
 *
 * 尤其「不出插图」这条：MinerU 会切图写回，阅读器有「这一页有哪些插图」、
 * 图文页能点开原图。走云 OCR 这条路，那些会整段失效。
 * **必须在选之前就说**，不能等解析完让用户发现图没了。
 */

import type { MinerUEngine } from './engine-choice.ts';

export interface EnginePickerProps {
  value: MinerUEngine;
  onChange: (next: MinerUEngine) => void;
  /** 云端那条路是否可用（没接后端 / 没 Key 时禁用并说明原因） */
  cloudDisabledReason?: string | null;
  /** 本地那条路是否可用 */
  localDisabledReason?: string | null;
  disabled?: boolean;
}

export function EnginePicker({
  value,
  onChange,
  cloudDisabledReason,
  localDisabledReason,
  disabled = false,
}: EnginePickerProps) {
  return (
    <div className="engine-pick" role="radiogroup" aria-label="用哪个引擎解析">
      <p className="engine-pick__lead">
        两条路各有取舍，选一条。换另一条重解析会覆盖这本资料的正文。
      </p>

      <div className="engine-pick__options">
        {/* ---------- 本地 MinerU ---------- */}
        <label
          className={`engine-opt${value === 'local' ? ' engine-opt--on' : ''}${
            localDisabledReason ? ' engine-opt--off' : ''
          }`}
        >
          <input
            type="radio"
            name="parse-engine"
            value="local"
            checked={value === 'local'}
            disabled={disabled || Boolean(localDisabledReason)}
            onChange={() => onChange('local')}
          />
          <span className="engine-opt__body">
            <span className="engine-opt__name">本地 MinerU</span>
            <span className="engine-opt__note">
              不需要联网、不花钱，<strong>会切出插图</strong>并能从标题推章节。
              要先在设置里装好 MinerU。
            </span>
            {localDisabledReason ? (
              <span className="engine-opt__why">{localDisabledReason}</span>
            ) : null}
          </span>
        </label>

        {/* ---------- DeepSeek 云 OCR ---------- */}
        <label
          className={`engine-opt${value === 'deepseek' ? ' engine-opt--on' : ''}${
            cloudDisabledReason ? ' engine-opt--off' : ''
          }`}
        >
          <input
            type="radio"
            name="parse-engine"
            value="deepseek"
            checked={value === 'deepseek'}
            disabled={disabled || Boolean(cloudDisabledReason)}
            onChange={() => onChange('deepseek')}
          />
          <span className="engine-opt__body">
            <span className="engine-opt__name">
              DeepSeek 云 OCR
              <span className="engine-opt__tag">按页收费</span>
            </span>
            <span className="engine-opt__note">
              不用装任何环境，直接上传原文件识别。按 <strong>1.5 元 / 1000 页</strong> 计费。
            </span>
            {/*
              ⚠️ 这条是「选之前必须知道」里最重要的一条。
              不做成灰色小字，用醒目一点的样式 —— 用户漏看会以为功能坏了。
            */}
            <span className="engine-opt__warn">
              不会切出插图（阅读器里那些「这一页有哪些图」会没有），也不推章节。
              只支持整本解析，不能只解析指定页；超过 180 秒的大文件可能超时。
            </span>
            {cloudDisabledReason ? (
              <span className="engine-opt__why">{cloudDisabledReason}</span>
            ) : null}
          </span>
        </label>
      </div>
    </div>
  );
}
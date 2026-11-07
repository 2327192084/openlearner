import type { Source } from '@/core/model.ts';

/**
 * 「出题素材从哪来」选择器。
 *
 * ## 为什么抽成独立组件
 *
 * 用户要求（2026-11-07）：
 *  1. 新增「从知识库出题」，可整库随机，也可指定一份资料；
 *  2. 原来的「从资料出题」改成读**资料原文**，不再读知识点。
 *
 * 这件事本质上是在出题表单最前面加一段「选来源」。直接往 GeneratePage
 * 那一大片 JSX 里塞，条件分支会互相嵌套，很容易把结构改坏
 * （实际也确实改坏过一次，靠 git 回退才救回来）。
 *
 * 抽成独立组件后：这里只有「来源」这一件事，父组件只读它的结果。
 */

export type MaterialOrigin = 'source-text' | 'knowledge';

export interface OriginPickerProps {
  origin: MaterialOrigin;
  onOriginChange: (next: MaterialOrigin) => void;
  /** 知识库来源时：是否跨全部资料随机抽 */
  acrossAll: boolean;
  onAcrossAllChange: (next: boolean) => void;
  sources: Source[] | null;
  /** 当前选中的资料 id（原文出题 / 指定资料时用） */
  selected: string;
  onSelectedChange: (next: string) => void;
  /** 选中资料里已定位的知识点条数（用于提示） */
  locatedPointCount: number | null;
  disabled?: boolean;
  /** 去整理这份资料的知识点 */
  onOpenOrganize: (sourceId: string) => void;
}

export function OriginPicker({
  origin,
  onOriginChange,
  acrossAll,
  onAcrossAllChange,
  sources,
  selected,
  onSelectedChange,
  locatedPointCount,
  disabled,
  onOpenOrganize,
}: OriginPickerProps) {
  const needSource = !(origin === 'knowledge' && acrossAll);

  return (
    <>
      <fieldset className="gen-field">
        <legend className="gen-legend">01 / 出题素材从哪来</legend>

        <div className="gen-origins">
          {(
            [
              ['source-text', '资料原文', '直接读解析后的正文段落出题，更贴近原文语境'],
              ['knowledge', '知识库知识点', '用整理过的知识点出题，更聚焦、也更短'],
            ] as const
          ).map(([key, title, desc]) => (
            <button
              key={key}
              type="button"
              className={`gen-origin${origin === key ? ' gen-origin--on' : ''}`}
              onClick={() => onOriginChange(key)}
              disabled={disabled}
              aria-pressed={origin === key}
            >
              <span className="gen-origin__title">{title}</span>
              <span className="gen-origin__desc">{desc}</span>
            </button>
          ))}
        </div>

        {origin === 'knowledge' ? (
          <label className="gen-check">
            <input
              type="checkbox"
              checked={acrossAll}
              onChange={(e) => onAcrossAllChange(e.target.checked)}
              disabled={disabled}
            />
            从整个知识库随机抽知识点（不勾选就只用下面选的那一份资料）
          </label>
        ) : (
          <p className="gen-hint">
            直接读这份资料解析出来的正文。扫描件需要先转成正文 ——
            在「整理知识点」页有这个按钮。
          </p>
        )}
      </fieldset>

      {needSource ? (
        <fieldset className="gen-field">
          <legend className="gen-legend">02 / 选资料</legend>
          <select
            className="gen-select"
            value={selected}
            onChange={(e) => onSelectedChange(e.target.value)}
            disabled={disabled}
          >
            {(sources ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>

          {/*
           * 提示按来源分开说 —— 两种来源的「下一步」不同：
           * 原文出题要的是正文，知识库出题要的是已定位知识点。
           */}
          {origin === 'knowledge' && locatedPointCount !== null ? (
            <>
              <p className="gen-hint">
                {locatedPointCount > 0
                  ? `这份资料有 ${locatedPointCount} 条已定位的知识点可以出题`
                  : '这份资料还没有可出题的知识点。先到「整理知识点」把它过一遍 —— 有了带出处的小条目，这里就能出题。'}
              </p>
              {locatedPointCount === 0 ? (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => onOpenOrganize(selected)}
                >
                  去整理这份资料的知识点
                </button>
              ) : null}
            </>
          ) : null}
        </fieldset>
      ) : (
        <p className="gen-hint gen-hint--block">
          已选择「整个知识库随机抽」，不限定资料。共 {sources?.length ?? 0} 份资料里的知识点都可能被抽到。
        </p>
      )}
    </>
  );
}

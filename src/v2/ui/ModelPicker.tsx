/**
 * 模型选择器：填好地址和 Key 之后，从服务商那儿把可用模型问出来再挑
 * （2026-11-13 深夜，用户要求）。
 *
 * ## 用户原话
 *
 * > 「最后改一下模型后端界面，让用户填入 api 后能选择实际模型。
 * >  例如现在 deepseek 的 api 可以调用两个模型，一个 deepseek v4pro，
 * >  一个 deepseek v4.1flash」
 *
 * ## 改之前是什么
 *
 * 一个文本输入框 + `<datalist>`。datalist 的问题：
 *  - 它**只是提示**，用户仍然得自己背出准确的模型名
 *  - 提示值来自 `presets.ts` 里写死的数组 —— 服务商上了新模型，
 *    这里永远是旧的。用户这次的诉求正是「V4 Pro / V4.1 Flash」这种新名字。
 *
 * ## 现在的交互
 *
 * 「模型名」变成一个可下拉的选择框 + 一个「拉取列表」按钮：
 *  1. 点「拉取列表」→ 真的 `GET <base>/models`，把结果列出来
 *  2. 从列表里挑一个 → 填进 model
 *  3. **手填永远保留**：有的端点（火山方舟的接入点 ID）不支持列表接口，
 *     也有的服务商格式不兼容。所以这始终是一个「可选辅助」，
 *     不是唯一入口 —— 不做假开关。
 *
 * ## 为什么拉取要用户主动点，而不是自动
 *
 * 自动拉取会在他还没填完 Key 时就发请求（必然 401），
 * 界面上一直挂着一条红字很吵。用户在这一步的意图很清楚：
 * 填完 Key → 想知道有哪些模型 → 点一下。
 */

import { useCallback, useMemo, useState } from 'react';
import {
  fetchModels,
  formatContext,
  type DiscoveredModel,
} from '@/core/ai/list-models.ts';

export interface ModelPickerProps {
  /** 当前模型名（受控） */
  value: string;
  onChange: (model: string) => void;
  /** 接口地址（用户可能刚改过，所以每次拉取都用最新的） */
  baseUrl: string;
  /** API Key：新建时取输入框里的值；编辑已有后端时用已保存的那把 */
  apiKey: string;
  /** 编辑已有后端且 Key 留空时，Key 在凭据库里 —— 此时拉取要用它 */
  savedKeyAvailable?: boolean;
  /**
   * 取出已保存的 Key（编辑已有后端时用）。
   *
   * 为什么需要这个而不是让调用方直接把 Key 传进来：
   * 项目刻意**不把明文凭据交给界面**（backends.ts:19 的注释），
   * `BackendView` 里只有 `credentialHint`（打了码的）。
   * 所以拉取列表时得通过服务层现取一次，且**只在这一刻**取 ——
   * 不能缓存进 React state，否则明文 Key 就留在界面内存里了。
   */
  readSavedKey?: () => Promise<string | null>;
  /** 服务商预设里的默认值与候选（作为「没有网络时」的兜底提示） */
  presetModels?: readonly string[];
  defaultModel?: string;
  /** 这个服务商要求填接入点 ID（火山方舟），列表接口帮不上忙 */
  modelMustBeFilled?: boolean;
  disabled?: boolean;
}

export function ModelPicker({
  value,
  onChange,
  baseUrl,
  apiKey,
  savedKeyAvailable = false,
  readSavedKey,
  presetModels = [],
  defaultModel,
  modelMustBeFilled = false,
  disabled = false,
}: ModelPickerProps) {
  const [models, setModels] = useState<DiscoveredModel[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  /** 过滤输入（列表可能有上百个模型，需要能缩小范围） */
  const [filter, setFilter] = useState('');

  const canFetch = useMemo(
    () => !disabled && !busy && (!!apiKey.trim() || savedKeyAvailable),
    [disabled, busy, apiKey, savedKeyAvailable],
  );

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      /*
       * 用哪个 Key 的顺序（很重要）：
       *   1. 用户刚在输入框里打的（新建后端、或想换一把 Key）
       *   2. 已保存的那把（编辑已有后端、输入框留空 —— 界面回填策略是
       *      「已保存的 Key 永不回填到界面」，所以这里必须去凭据库拿一次）
       *
       * 拿不到就明确说，不去发一个必然 401 的请求。
       */
      let key = apiKey.trim();
      if (!key && readSavedKey) {
        const saved = await readSavedKey();
        key = (saved ?? '').trim();
      }
      if (!key) {
        setError('先填入 API Key（或先保存这个后端），才能问服务商有哪些模型。');
        setModels(null);
        return;
      }

      const r = await fetchModels({ apiKey: key, baseUrl });
      if (r.ok) {
        setModels(r.models);
        setOpen(true);
        /*
         * 拉到之后，如果当前模型名是空的、或不在列表里，
         * **不自动改**用户的填值 —— 他可能故意填了一个列表里没有的
         * 别名/中转站模型名。只在界面上标明「不在列表里」。
         */
      } else {
        setError(r.reason);
        setModels(null);
      }
    } finally {
      setBusy(false);
    }
  }, [apiKey, baseUrl, readSavedKey]);

  const filtered = useMemo(() => {
    if (!models) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.id.toLowerCase().indexOf(q) !== -1 || m.label.toLowerCase().indexOf(q) !== -1,
    );
  }, [models, filter]);

  /** 当前填的模型是否在已拉取的列表里（用于给一句提醒） */
  const currentInList = models ? models.some((m) => m.id === value) : null;

  return (
    <div className="set-field set-model">
      <span className="set-label">模型名</span>

      <div className="set-model__row">
        <input
          className="set-input set-input--mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={defaultModel ?? 'deepseek-chat'}
          spellCheck={false}
          disabled={disabled}
          aria-label="模型名"
          list="set-model-suggestions"
        />
        {/* 没有网络时仍然有预设可点（保留原 datalist 的兜底作用） */}
        <datalist id="set-model-suggestions">
          {(presetModels.length > 0 ? presetModels : []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>

        <button
          type="button"
          className="set-model__fetch"
          onClick={() => void load()}
          disabled={!canFetch}
          title={
            canFetch
              ? '向服务商查询这把 Key 能用的模型'
              : savedKeyAvailable
                ? '正在查询…'
                : '先填入 API Key 才能查询'
          }
        >
          {busy ? '查询中…' : models ? '重新拉取' : '拉取列表'}
        </button>
      </div>

      {error ? (
        <span className="set-hint set-hint--bad" role="alert">
          {error}
        </span>
      ) : null}

      {models ? (
        <>
          <span className="set-hint">
            从服务商查到 {models.length} 个模型
            {currentInList === false ? '（当前填的那个不在列表里，可能是个别名）' : ''}
            。点一个就填进去，也可以继续手填。
          </span>

          <button
            type="button"
            className="set-model__toggle"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {open ? '收起列表' : '展开列表'}
          </button>

          {open ? (
            <div className="set-model__list">
              {models.length > 6 ? (
                <input
                  className="set-model__filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="筛选模型名…"
                  spellCheck={false}
                  aria-label="筛选模型"
                />
              ) : null}
              {filtered.length === 0 ? (
                <p className="set-model__empty">没有匹配的模型。</p>
              ) : (
                <ul className="set-model__items">
                  {filtered.map((m) => {
                    const ctx = formatContext(m.contextWindow);
                    const on = m.id === value;
                    return (
                      <li key={m.id}>
                        <button
                          type="button"
                          className={`set-model__item${on ? ' set-model__item--on' : ''}`}
                          onClick={() => {
                            onChange(m.id);
                            setOpen(false);
                          }}
                          aria-pressed={on}
                        >
                          <span className="set-model__name">{m.label}</span>
                          {m.label !== m.id ? (
                            <span className="set-model__id">{m.id}</span>
                          ) : null}
                          <span className="set-model__tags">
                            {ctx ? <span className="set-model__tag">{ctx}</span> : null}
                            {m.supportsImage === true ? (
                              <span className="set-model__tag set-model__tag--vision">可看图</span>
                            ) : null}
                            {on ? <span className="set-model__tag set-model__tag--on">当前</span> : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : null}
        </>
      ) : null}

      {modelMustBeFilled ? (
        <span className="set-hint">这个服务要求填推理接入点 ID（ep- 开头），不能填模型本名。</span>
      ) : null}
    </div>
  );
}

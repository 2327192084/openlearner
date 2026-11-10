/**
 * 知识点标签编辑器（2026-11-10）。
 *
 * ## 为什么只让改标签
 *
 * `KnowledgeService.update()` 其实能改 statement / chapter / cognitiveLevel / tags，
 * 但 `KnowledgePage` 的注释写清了为什么不做完整编辑：
 * **改 statement 会让锚点失效**（锚点是靠 quotes 在原文里定位出来的，
 * 改了表述就和原文对不上了），还会牵动已出的题。
 *
 * 而 tags **完全不参与定位** —— 它只用于分类与筛选。
 * 所以「只放行标签编辑」是安全且够用的：用户能纠正 AI 的错误分类，
 * 又不会碰到任何会影响定位的字段。
 *
 * ## 为什么单独一个文件
 *
 * `KnowledgePage.tsx` 已经 600+ 行。项目对往大文件里插代码有过教训。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import './kp-tags.css';

export interface KpTagsEditorProps {
  /** 当前标签 */
  tags: readonly string[];
  /** 这份资料里已知的小节/章节名，作为输入建议（不是白名单） */
  suggestions?: readonly string[];
  /** 保存新标签 */
  onSave: (next: string[]) => Promise<void> | void;
  /** 最多几个（与解析层的上限一致，避免两处口径不同） */
  max?: number;
}

/**
 * 上限与 `cleanTags`（deepseek-backend.ts）保持一致。
 *
 * 为什么两处都写而不是抽个共享常量：那一处是「解析模型输出」时的清洗，
 * 这里是「用户手输」时的限制。它们的值碰巧相同，但改动的理由不同
 * （解析层怕模型啰嗦，界面怕标签太碎）。抽成共享常量会让
 * 「改一个连带影响另一个」变成隐藏的耦合。
 */
const DEFAULT_MAX = 2;

export function KpTagsEditor({
  tags,
  suggestions = [],
  onSave,
  max = DEFAULT_MAX,
}: KpTagsEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [local, setLocal] = useState<string[]>([...tags]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /* 外部标签变了（切换资料、重新整理）→ 同步，避免显示旧值 */
  useEffect(() => {
    setLocal([...tags]);
  }, [tags]);

  /* 进入编辑时自动聚焦，省一次点击 */
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const add = useCallback(
    (raw: string) => {
      const t = raw.trim().replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '');
      if (!t) return;
      if (t.length < 2 || t.length > 40) return;
      if (local.includes(t)) return;
      if (local.length >= max) return;
      setLocal([...local, t]);
      setDraft('');
    },
    [local, max],
  );

  const remove = useCallback((t: string) => {
    setLocal((prev) => prev.filter((x) => x !== t));
  }, []);

  const commit = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onSave(local);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }, [busy, local, onSave]);

  const cancel = useCallback(() => {
    setLocal([...tags]);
    setDraft('');
    setEditing(false);
  }, [tags]);

  /* ---------------- 只读：显示标签 + 一个「改」 ---------------- */
  if (!editing) {
    return (
      <div className="kpt">
        <span className="kpt__label">分类</span>
        {local.length === 0 ? (
          /*
           * 没有标签时**明说「未分类」**而不是留空。
           * 留空看起来像「这里本来就没什么」，用户不会想到去点它。
           */
          <span className="kpt__none">未分类</span>
        ) : (
          <ul className="kpt__list">
            {local.map((t) => (
              <li key={t} className="kpt__tag">
                {t}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="kpt__mini"
          onClick={() => setEditing(true)}
          title="改分类标签（不影响知识点在原文里的位置）"
        >
          改
        </button>
      </div>
    );
  }

  /* ---------------- 编辑中 ---------------- */
  return (
    <div className="kpt kpt--editing">
      <span className="kpt__label">分类</span>

      <div className="kpt__edit">
        <ul className="kpt__list">
          {local.map((t) => (
            <li key={t} className="kpt__tag kpt__tag--removable">
              {t}
              <button
                type="button"
                className="kpt__x"
                onClick={() => remove(t)}
                aria-label={`删除标签 ${t}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>

        {local.length < max ? (
          <input
            ref={inputRef}
            className="kpt__input"
            value={draft}
            list="kpt-suggestions"
            placeholder={local.length === 0 ? '填小节名，如「1.1 线性时不变系统」' : '再加一个（可选）'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (draft.trim()) add(draft);
                else void commit();
              } else if (e.key === 'Escape') {
                cancel();
              }
            }}
          />
        ) : (
          <p className="kpt__hint">最多 {max} 个标签。删一个才能再加。</p>
        )}

        {/* 建议列表用 datalist：不占空间、不清空用户输入 */}
        <datalist id="kpt-suggestions">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>

      <div className="kpt__actions">
        <button type="button" className="kpt__mini kpt__mini--primary" onClick={() => void commit()} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" className="kpt__mini" onClick={cancel} disabled={busy}>
          取消
        </button>
      </div>
    </div>
  );
}

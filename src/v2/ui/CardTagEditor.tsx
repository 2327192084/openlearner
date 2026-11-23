/**
 * 闪卡标签编辑器（2026-11-23，用户要求）。
 *
 * 用户原话：
 * > 可以去掉手写的闪卡这一栏，让用户在编写完成后通过选择标签决定闪卡存放位置。
 *
 * 所以标签是**用户自己维护的归档口径**：写完一张卡，打一个标签，
 * 导出到 Obsidian 时它落到哪个卡组就由这个标签决定
 * （`#flashcards/<标签>`，见 flashcard-export.ts）。
 *
 * ## 为什么单独成文件
 *
 * 硬约束 9：FlashcardsPage 已经 880+ 行，不再往里堆交互。
 * 这里只有 UI；规范化（去空/去重）由数据层的 `normalizeTags` 负责，
 * 两层各一套规则迟早漂移，所以这个组件**不做去重**，
 * 提交给宿主的就是用户输入的原始顺序。
 *
 * ## 已有标签点选 + 自由输入
 *
 * 用户多半会给同类卡重复打同一个标签，所以把库里已有的标签
 * 摆在上面当候选（点一下就加/取消），同时留一个自由输入框 ——
 * 新标签直接打字回车。不做下拉限制：那会让用户想新建标签时卡住。
 */

import { useState } from 'react';
import './card-tag-editor.css';

export interface CardTagEditorProps {
  /** 这张卡当前的标签 */
  value: readonly string[];
  /** 库里已有的标签（候选；含计数，让用户知道别的卡用过什么） */
  known: readonly { tag: string; count: number }[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

export function CardTagEditor(props: CardTagEditorProps) {
  const { value, known, onChange, disabled } = props;
  const [draft, setDraft] = useState('');

  const has = (t: string) => value.indexOf(t) >= 0;

  const toggle = (t: string) => {
    onChange(has(t) ? value.filter((x) => x !== t) : [...value, t]);
  };

  const addDraft = () => {
    const t = draft.trim();
    if (!t) return;
    if (!has(t)) onChange([...value, t]);
    setDraft('');
  };

  return (
    <div className="ctag">
      <span className="ctag__label">标签（决定导出到 Obsidian 时放进哪个卡组）</span>

      {known.length > 0 ? (
        <div className="ctag__known">
          {known.map((k) => (
            <button
              key={k.tag}
              type="button"
              className={`ctag__chip${has(k.tag) ? ' ctag__chip--on' : ''}`}
              onClick={() => toggle(k.tag)}
              disabled={disabled}
              title={has(k.tag) ? '这一点取消这个标签' : `库里已有 ${k.count} 张卡用过`}
            >
              {k.tag}
              <span className="ctag__n">{k.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {value.length > 0 ? (
        <ul className="ctag__current">
          {value.map((t) => (
            <li key={t} className="ctag__cur">
              {t}
              <button
                type="button"
                className="ctag__rm"
                onClick={() => toggle(t)}
                disabled={disabled}
                aria-label={`去掉标签 ${t}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ctag__empty">还没打标签 —— 不打也行，导出时会落进默认卡组。</p>
      )}

      <div className="ctag__add">
        <input
          className="ctag__input"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addDraft();
            }
          }}
          placeholder="新标签名，回车添加"
          disabled={disabled}
          aria-label="新标签"
        />
        <button type="button" className="ctag__addbtn" onClick={addDraft} disabled={disabled}>
          添加
        </button>
      </div>
    </div>
  );
}

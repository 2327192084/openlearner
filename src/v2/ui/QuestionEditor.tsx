/**
 * 题目编辑与删除（2026-11-11 晚）。
 *
 * ## 用户的要求
 *
 * 「建议：加一个题库编辑功能，要不然待审核按钮相当于没用，
 *   不能删除出错题目或是重新对出错题目进行纠正生成」
 *
 * 用户说的是实情：题组页能「发布 / 撤回 / 删除整个题组」，
 * 但**单道题既不能改也不能删**。于是「待审核」这一步形同虚设 ——
 * 发现一道题是错的，只能删掉整个题组重来。
 *
 * ## 服务层早就支持了
 *
 * `DeckService.updateQuestion()` 与 `removeQuestion()` 都已存在
 * （`src/core/questions/service.ts:662 / 677`），
 * 而且改完会自动 `revalidate()`、删题会进回收站。
 * 缺的只是界面 —— 属于典型的「说了没做」，硬约束禁止的那类问题。
 *
 * ## 为什么独立成文件
 *
 * `DecksPage.tsx` 已 470+ 行，`App.tsx` 1988 行。
 * 硬约束：新增 UI 一律独立文件。
 *
 * ## 几个刻意的取舍
 *
 * 1. **默认只读，点「编辑」才可改** —— 待审核页的主要任务是「看」，
 *    满屏输入框会让人不敢点发布。
 * 2. **改完自动重校验**（服务层做的）。所以界面只说「已保存」，
 *    不自己判断题目合不合格 —— 那是 `validateQuestions` 的事。
 * 3. **删除有二次确认**，且说明会进回收站（可还原），
 *    不像删题组那样「不能撤销」。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Question } from '@/core/model.ts';
import type { DeckService } from '@/core/questions/service.ts';
import { MathText } from './MathText.tsx';
import './question-editor.css';

export interface QuestionEditorProps {
  question: Question;
  /** 第几题（1 基，仅用于显示） */
  index: number;
  decks: DeckService;
  /** 保存或删除成功后通知外层重新读题 */
  onChanged: () => void;
}

type Mode = 'read' | 'edit';

export function QuestionEditor({ question, index, decks, onChanged }: QuestionEditorProps) {
  const [mode, setMode] = useState<Mode>('read');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /* 编辑态草稿：初始值是当前题目 */
  const [prompt, setPrompt] = useState(question.prompt);
  const [answer, setAnswer] = useState(question.answer);
  const [explanation, setExplanation] = useState(question.explanation ?? '');
  /* 选项文本（只改文本，不动 key 与对错判断 —— 改 key 会让答案失效） */
  const [options, setOptions] = useState(
    question.options.map((o) => ({ key: o.key, text: o.text })),
  );

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /** 重新开始编辑：把草稿重置成当前题目的值（放弃未保存的改动） */
  const beginEdit = useCallback(() => {
    setPrompt(question.prompt);
    setAnswer(question.answer);
    setExplanation(question.explanation ?? '');
    setOptions(question.options.map((o) => ({ key: o.key, text: o.text })));
    setNote(null);
    setMode('edit');
  }, [question]);

  const cancelEdit = useCallback(() => {
    setMode('read');
    setNote(null);
  }, []);

  const save = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      /*
       * 只提交真正改过的字段。
       *
       * 为什么不是无脑全传：`updateQuestion` 会把 patch 合并进原记录并
       * 重跑校验。把没变的字段也塞进去没有坏处，但「只传改动」
       * 让日志与未来的审计更容易看出用户动了什么。
       */
      const patch: Parameters<DeckService['updateQuestion']>[1] = {};
      if (prompt !== question.prompt) patch.prompt = prompt;
      if (answer !== question.answer) patch.answer = answer;
      if ((question.explanation ?? '') !== explanation) patch.explanation = explanation;

      const nextOptions = question.options.map((o) => {
        const draft = options.find((d) => d.key === o.key);
        return draft && draft.text !== o.text ? { ...o, text: draft.text } : o;
      });
      if (nextOptions.some((o, i) => o.text !== question.options[i]?.text)) {
        patch.options = nextOptions;
      }

      if (Object.keys(patch).length === 0) {
        setNote('没有改动。');
        setMode('read');
        return;
      }

      const r = await decks.updateQuestion(question.id, patch);
      if (!aliveRef.current) return;
      if (!r) {
        setNote('保存失败：这道题可能已被删除。');
        return;
      }
      setNote('已保存，并已重新校验。');
      setMode('read');
      onChanged();
    } catch (e) {
      if (!aliveRef.current) return;
      setNote(e instanceof Error ? e.message : '保存失败');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [busy, decks, question, prompt, answer, explanation, options, onChanged]);

  const doDelete = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await decks.removeQuestion(question.id);
      if (!aliveRef.current) return;
      /*
       * 不在这里 setNote('已删除') —— 这道题马上会从列表消失，
       * 提示挂在一个已经不存在的行上没有意义。外层刷新即是反馈。
       */
      onChanged();
    } catch (e) {
      if (!aliveRef.current) return;
      setNote(e instanceof Error ? e.message : '删除失败');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [busy, decks, question.id, onChanged]);

  /* ---- 只读态 ---- */
  if (mode === 'read') {
    return (
      <li className="deck-q">
        <span className="deck-q__no">{index}</span>
        <div className="deck-q__body">
          <p className="deck-q__prompt"><MathText text={question.prompt} /></p>

          {question.options.length > 0 ? (
            <ul className="deck-q__options">
              {question.options.map((o) => (
                <li
                  key={o.key}
                  className={o.key === question.answer ? 'deck-q__opt deck-q__opt--right' : 'deck-q__opt'}
                >
                  <span className="deck-q__key">{o.key}</span>
                  <MathText text={o.text} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="deck-q__answer">答案：<MathText text={question.answer} /></p>
          )}

          {question.anchors.length > 0 ? (
            <p className="deck-q__anchor">出处：第 {question.anchors[0]?.page ?? '?'} 页</p>
          ) : (
            <p className="deck-q__anchor deck-q__anchor--none">没找到原文位置</p>
          )}

          {note ? <p className="qed-note">{note}</p> : null}

          <div className="qed-actions">
            <button type="button" className="btn-ghost btn-ghost--sm" onClick={beginEdit} disabled={busy}>
              编辑
            </button>
            <button
              type="button"
              className="qed-del"
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
            >
              删除这题
            </button>
          </div>

          {confirmDelete ? (
            <div className="qed-confirm">
              <p className="qed-confirm__text">
                删除第 {index} 题？它会进回收站（可还原），这道题的历史作答记录也会一并清掉。
              </p>
              <div className="qed-actions">
                <button type="button" className="qed-del" onClick={() => void doDelete()} disabled={busy}>
                  确认删除
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-ghost--sm"
                  onClick={() => setConfirmDelete(false)}
                  disabled={busy}
                >
                  取消
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </li>
    );
  }

  /* ---- 编辑态 ---- */
  return (
    <li className="deck-q deck-q--editing">
      <span className="deck-q__no">{index}</span>
      <div className="deck-q__body">
        <label className="qed-field">
          <span className="qed-label">题干</span>
          <textarea
            className="qed-input qed-input--area"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            disabled={busy}
          />
        </label>

        {options.length > 0 ? (
          <div className="qed-field">
            <span className="qed-label">选项（改动不影响对错，正确答案是 {question.answer}）</span>
            {options.map((o) => (
              <div key={o.key} className="qed-opt">
                <span className="deck-q__key">{o.key}</span>
                <input
                  className="qed-input"
                  value={o.text}
                  onChange={(e) => {
                    const v = e.target.value;
                    setOptions((prev) => prev.map((x) => (x.key === o.key ? { ...x, text: v } : x)));
                  }}
                  disabled={busy}
                />
              </div>
            ))}
          </div>
        ) : null}

        <label className="qed-field">
          <span className="qed-label">答案</span>
          <input
            className="qed-input"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            disabled={busy}
          />
        </label>

        <label className="qed-field">
          <span className="qed-label">解析（可空）</span>
          <textarea
            className="qed-input qed-input--area"
            value={explanation}
            onChange={(e) => setExplanation(e.target.value)}
            rows={3}
            disabled={busy}
          />
        </label>

        {note ? <p className="qed-note">{note}</p> : null}

        <div className="qed-actions">
          <button type="button" className="btn-fill btn-fill--sm" onClick={() => void save()} disabled={busy}>
            {busy ? '保存中…' : '保存修改'}
          </button>
          <button type="button" className="btn-ghost btn-ghost--sm" onClick={cancelEdit} disabled={busy}>
            取消
          </button>
        </div>
      </div>
    </li>
  );
}

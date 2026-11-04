import { useEffect, useState } from 'react';
import { Badge, Notice } from '@/components/states.tsx';
import { useServices } from '@/app/services-context.ts';
import type { Question, QuestionIssue, QuestionOption, Source } from '@/core/model.ts';
import {
  ISSUE_CODE_LABEL,
  describeError,
  hintFrom,
  kindLabel,
  levelLabel,
  locationText,
} from './types.ts';
import type { Flash } from './types.ts';
import { SourcePeek } from '../practice/SourcePeek.tsx';

/**
 * 一道题的审阅卡片。
 *
 * 三件事必须同时可见，否则「校对」这个动作不成立：
 *  1. **题面**（题干 + 选项 + 答案 + 解析）—— 可以就地改；
 *  2. **这题自己的校验问题** —— 红/黄标出来，改完立即重算；
 *  3. **出处** —— 继承自知识点，**只读**，但可以点开看原文。
 *
 * ## 为什么出处不可编辑
 *
 * 出处是这道题最可信的东西（它来自知识点，而知识点是被定位器在真实正文里
 * 实测定位过的）。让用户在这里「重新指定出处」等于允许他填一个没验证过的位置，
 * 那就把产品最重要的承诺（点得通）变成了一个可以人工造假的东西。
 * 想改出处应该去知识点页重新指认——那是唯一有定位器的地方。
 */

type Draft = {
  prompt: string;
  answer: string;
  explanation: string;
  options: QuestionOption[];
};

function toDraft(q: Question): Draft {
  return {
    prompt: q.prompt,
    answer: q.answer,
    explanation: q.explanation,
    options: q.options.map((o) => ({ ...o })),
  };
}

export function QuestionEditCard({
  question,
  issues,
  sourceKind,
  busy,
  onChange,
  onNotify,
}: {
  question: Question;
  issues: QuestionIssue[];
  /** 资料类型：docx/markdown 的 page 是章节序号，界面要写「节」 */
  sourceKind?: Source['kind'];
  /** 父组件的全局 busy（发布中等），用于禁用整卡 */
  busy: boolean;
  onChange: () => Promise<void> | void;
  onNotify: (flash: Flash) => void;
}) {
  const { decks: deckService } = useServices();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(question));
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);
  const [peekOpen, setPeekOpen] = useState(false);

  const blocking = issues.filter((i) => i.severity === 'blocking');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const number = question.order + 1;
  const hasOptions = question.kind === 'single' || question.kind === 'multiple';

  // 父组件重新拉题目后，如果这张卡没在编辑，草稿要跟上最新的真实值
  useEffect(() => {
    if (!editing) setDraft(toDraft(question));
  }, [question, editing]);

  const startEdit = () => {
    setDraft(toDraft(question));
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    const prompt = draft.prompt.trim();
    if (!prompt) {
      setError({
        message: '题干不能为空。',
        hint: '空题干会让这道题在练习里显示成一片空白。想删掉这道题请用「删除」。',
      });
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const next = await deckService.updateQuestion(question.id, {
        prompt,
        answer: draft.answer.trim(),
        explanation: draft.explanation.trim(),
        // 选项只在选择题里可改；填空/问答的 options 恒为空数组
        options: hasOptions ? draft.options.map((o) => ({ key: o.key, text: o.text.trim() })) : [],
      });
      if (!next) {
        setError({
          message: '这道题已经不在了（可能刚被删除）。',
          hint: '刷新页面看这套题的最新内容；刚才的改动没有保存。',
        });
        return;
      }
      await onChange();
      setEditing(false);
      onNotify({ tone: 'info', text: `第 ${number} 题已保存，校验结果已重算` });
    } catch (err) {
      setError({
        message: describeError(err),
        hint: hintFrom(err, '这道题没有被改动。可以再点一次保存；若反复失败，检查本地存储是否可用。'),
      });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const ok = window.confirm(
      `删除第 ${number} 题？\n\n「${truncate(question.prompt, 80)}」\n\n` +
        '这道题的作答记录会一起删掉，错题本里也不会再出现它。\n' +
        '删掉之后题号会重排，其他题目不受影响。',
    );
    if (!ok) return;
    setRemoving(true);
    setError(null);
    try {
      await deckService.removeQuestion(question.id);
      await onChange();
      onNotify({ tone: 'info', text: `已删除第 ${number} 题` });
    } catch (err) {
      setError({
        message: describeError(err),
        hint: hintFrom(err, '这道题没有被删除。可以刷新后重试。'),
      });
    } finally {
      setRemoving(false);
    }
  };

  const disabled = busy || saving || removing;

  return (
    <li className="card dk-q" id={`q-${question.id}`}>
      <div className="dk-q__head">
        <div className="dk-q__badges">
          <span className="dk-q__number">第 {number} 题</span>
          <Badge tone="neutral">{kindLabel(question.kind)}</Badge>
          <Badge tone="neutral">{levelLabel(question.cognitiveLevel)}</Badge>
          {blocking.length > 0 ? (
            <Badge tone="danger">阻塞 {blocking.length}</Badge>
          ) : null}
          {warnings.length > 0 ? <Badge tone="planned">提醒 {warnings.length}</Badge> : null}
          {question.topic ? <span className="dk-q__topic">{question.topic}</span> : null}
        </div>
        <div className="page__row" style={{ flex: 'none' }}>
          {!editing ? (
            <button type="button" className="btn btn--sm" onClick={startEdit} disabled={disabled}>
              编辑
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--sm btn--danger"
            onClick={() => void remove()}
            disabled={disabled}
          >
            {removing ? '删除中…' : '删除'}
          </button>
        </div>
      </div>

      {/* ---------- 校验问题（内联在题上，红色优先） ---------- */}
      {issues.length > 0 ? (
        <ul className="dk-q__issues">
          {blocking.map((issue, idx) => (
            <li key={`b-${issue.code}-${idx}`} className="dk-q__issue dk-q__issue--blocking">
              <Badge tone="danger">阻塞</Badge>
              <span className="dk-q__issue-code">{ISSUE_CODE_LABEL[issue.code]}</span>
              <span>{issue.message}</span>
            </li>
          ))}
          {warnings.map((issue, idx) => (
            <li key={`w-${issue.code}-${idx}`} className="dk-q__issue dk-q__issue--warning">
              <Badge tone="planned">提醒</Badge>
              <span className="dk-q__issue-code">{ISSUE_CODE_LABEL[issue.code]}</span>
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* ---------- 题面 ---------- */}
      {editing ? (
        <div className="card__body page__stack dk-q__edit">
          <div className="field">
            <label className="field__label" htmlFor={`q-prompt-${question.id}`}>
              题干
            </label>
            <textarea
              id={`q-prompt-${question.id}`}
              className="textarea"
              rows={3}
              value={draft.prompt}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              disabled={disabled}
            />
          </div>

          {hasOptions ? (
            <div className="field">
              <span className="field__label">选项</span>
              <div className="dk-q__options">
                {draft.options.map((opt, idx) => (
                  <div className="dk-q__option-edit" key={`${opt.key}-${idx}`}>
                    <span className="dk-q__option-key">{opt.key}</span>
                    <input
                      className="input"
                      value={opt.text}
                      aria-label={`选项 ${opt.key} 的内容`}
                      onChange={(e) => {
                        const options = draft.options.map((o, i) =>
                          i === idx ? { ...o, text: e.target.value } : o,
                        );
                        setDraft({ ...draft, options });
                      }}
                      disabled={disabled}
                    />
                  </div>
                ))}
              </div>
              <div className="field__hint">
                选项的字母标识不可改——作答记录靠它判分，改了等于让历史记录判错。
              </div>
            </div>
          ) : null}

          <div className="field">
            <label className="field__label" htmlFor={`q-answer-${question.id}`}>
              {hasOptions ? '正确答案（选项字母）' : '参考答案'}
            </label>
            <input
              id={`q-answer-${question.id}`}
              className="input"
              value={draft.answer}
              onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
              disabled={disabled}
            />
            <div className="field__hint">
              {question.kind === 'multiple'
                ? '多选写多个字母，用英文逗号分隔，如 A,C。顺序不影响判分。'
                : question.kind === 'single'
                  ? '单选只写一个字母，如 A。'
                  : question.kind === 'blank'
                    ? '填空判分会忽略大小写、空格和首尾标点。'
                    : '问答无法自动判分，这是给自评时对照的参考答案。'}
            </div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor={`q-exp-${question.id}`}>
              解析
            </label>
            <textarea
              id={`q-exp-${question.id}`}
              className="textarea"
              rows={3}
              value={draft.explanation}
              onChange={(e) => setDraft({ ...draft, explanation: e.target.value })}
              disabled={disabled}
            />
            <div className="field__hint">
              作答后展示给学生。missing 解析只是提醒，不影响判分，但学生答错时没有解释会很困惑。
            </div>
          </div>

          <div className="page__row">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void save()}
              disabled={disabled}
            >
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setDraft(toDraft(question));
                setEditing(false);
                setError(null);
              }}
              disabled={disabled}
            >
              取消
            </button>
          </div>

          {error ? (
            <Notice tone="danger" title="没有保存">
              {error.message}
              <br />
              <strong>下一步：</strong>
              {error.hint}
            </Notice>
          ) : null}
        </div>
      ) : (
        <div className="card__body page__stack dk-q__view">
          <div className="dk-q__prompt">{question.prompt}</div>

          {hasOptions && question.options.length > 0 ? (
            <ul className="dk-q__options">
              {question.options.map((opt) => {
                const correct = isCorrectOption(question, opt.key);
                return (
                  <li
                    key={opt.key}
                    className={`dk-q__option${correct ? ' dk-q__option--correct' : ''}`}
                  >
                    <span className="dk-q__option-key">{opt.key}</span>
                    <span className="dk-q__option-text">{opt.text}</span>
                    {correct ? <Badge tone="ready">正确</Badge> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          <div className="dk-q__field">
            <span className="dk-q__field-label">
              {hasOptions ? '正确答案' : '参考答案'}
            </span>
            <span className="dk-q__field-value">{question.answer.trim() || '（空）'}</span>
          </div>

          <div className="dk-q__field">
            <span className="dk-q__field-label">解析</span>
            <span className={`dk-q__field-value${question.explanation.trim() ? '' : ' dk-q__field-value--empty'}`}>
              {question.explanation.trim() || '（没有解析）'}
            </span>
          </div>

          {/* ---------- 出处：只读，但可点开看原文 ---------- */}
          <div className="dk-q__field">
            <span className="dk-q__field-label">出处</span>
            <span className="dk-q__field-value">
              {question.anchors.length === 0 ? (
                <span className="dk-q__field-value--empty">
                  这条知识点没有定位到原文，所以这道题没有出处。
                  <span className="page__muted">（要补出处请去知识点页重新指认）</span>
                </span>
              ) : (
                <span className="dk-q__anchor">
                  <span>{locationText(question.anchors[0], sourceKind)}</span>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => setPeekOpen((v) => !v)}
                  >
                    {peekOpen ? '收起原文' : '看原文'}
                  </button>
                  <span className="page__muted">出处继承自知识点，不在这里改</span>
                </span>
              )}
            </span>
          </div>

          {/*
            用 anchor 自带的 sourceId 而不是 deck 的：
            anchor 是「这条知识点在哪份资料的哪一页」，它自己带 sourceId。
            习题集的 sourceId 只是「这批题是从哪份资料出的」，
            手工建或跨资料的题集里两者可能不一致。读 anchor 的永远是对的。
          */}
          {peekOpen && question.anchors[0] ? (
            <SourcePeek
              sourceId={question.anchors[0].sourceId}
              anchor={question.anchors[0]}
              sourceKind={sourceKind}
              onClose={() => setPeekOpen(false)}
            />
          ) : null}

          {error ? (
            <Notice tone="danger" title="操作没有完成">
              {error.message}
              <br />
              <strong>下一步：</strong>
              {error.hint}
            </Notice>
          ) : null}
        </div>
      )}
    </li>
  );
}

/** 这道题的答案里是否包含这个选项键（单选/多选通用） */
function isCorrectOption(question: Question, key: string): boolean {
  return question.answer
    .split(',')
    .map((k) => k.trim().toUpperCase())
    .filter(Boolean)
    .includes(key.trim().toUpperCase());
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

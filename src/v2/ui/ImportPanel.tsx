/**
 * 导入 JSON 题组面板。
 *
 * ## 为什么做成「粘贴 + 选文件」两种
 *
 * 用户手上的 JSON 有两种来源：
 *  - 从我们这个软件导出的（在别的机器上），通常是个文件
 *  - 从别处（聊天窗口、别的 AI）复制的，通常是粘贴
 *
 * 只给其中一种都会让人卡住。
 *
 * ## 为什么导入前先「预览」
 *
 * 外部 JSON 的字段名五花八门，解析出来可能和用户以为的不一样
 * （比如「只有两个选项的单选」被当成判断题）。
 * 所以先解析、先显示「识别到 N 道题、题型分布、标题」，
 * 用户确认没问题再真的写库 —— 而不是导进去之后才发现一堆题不对。
 */

import { useCallback, useRef, useState } from 'react';
import type { DeckService } from '@/core/questions/service.ts';
import { ImportError, parseDeckJson } from '@/core/questions/import-json.ts';
import type { ParsedImport } from '@/core/questions/import-json.ts';
import { kindLabel } from '@/core/questions/kinds.ts';

export interface ImportPanelProps {
  decks: DeckService;
  /** 导入成功后通知外层刷新（题组列表要更新） */
  onImported: (deckId: string, count: number) => void;
  disabled?: boolean;
}

type Stage =
  | { kind: 'input' }
  | { kind: 'preview'; parsed: ParsedImport; raw: string }
  | { kind: 'done'; deckId: string; title: string; count: number };

export function ImportPanel({ decks, onImported, disabled }: ImportPanelProps) {
  const [stage, setStage] = useState<Stage>({ kind: 'input' });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ msg: string; hint: string; at: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const fail = useCallback((e: unknown) => {
    if (e instanceof ImportError) {
      setErr({ msg: e.message, hint: e.hint, at: e.questionIndex });
    } else {
      setErr({
        msg: e instanceof Error ? e.message : String(e),
        hint: '如果反复失败，把 JSON 里的第一道题贴出来看看结构',
        at: 0,
      });
    }
  }, []);

  /** 解析但不写库 */
  function preview() {
    setErr(null);
    try {
      const parsed = parseDeckJson(text);
      setStage({ kind: 'preview', parsed, raw: text });
    } catch (e) {
      fail(e);
    }
  }

  /** 确认后真写库 */
  async function confirm() {
    if (stage.kind !== 'preview') return;
    setBusy(true);
    setErr(null);
    try {
      const out = await decks.importJson(stage.raw, { title: stage.parsed.title });
      setStage({ kind: 'done', deckId: out.deck.id, title: out.deck.title, count: out.questions.length });
      onImported(out.deck.id, out.questions.length);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function pickFile(file: File) {
    setErr(null);
    try {
      const content = await file.text();
      setText(content);
      /* 选完文件直接预览，少点一次 */
      const parsed = parseDeckJson(content);
      setStage({ kind: 'preview', parsed, raw: content });
    } catch (e) {
      fail(e);
    }
  }

  /* ---------- 完成 ---------- */
  if (stage.kind === 'done') {
    return (
      <div className="imp-done">
        <p className="imp-done__text">
          ✓ 已导入「{stage.title}」，共 {stage.count} 道题。
        </p>
        <p className="imp-done__hint">
          它现在是<strong>待审核</strong> —— 导入的题可能有格式问题，
          先到「我的题组」检查一遍，发布之后才会进入复习。
        </p>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            setStage({ kind: 'input' });
            setText('');
          }}
        >
          再导入一个
        </button>
      </div>
    );
  }

  /* ---------- 预览 ---------- */
  if (stage.kind === 'preview') {
    const { parsed } = stage;
    const byKind = new Map<string, number>();
    for (const q of parsed.questions) byKind.set(q.kind, (byKind.get(q.kind) ?? 0) + 1);

    return (
      <div className="imp-preview">
        <h3 className="imp-preview__title">识别结果</h3>
        <dl className="imp-kv">
          <dt>题组名</dt>
          <dd>{parsed.title}</dd>
          <dt>题数</dt>
          <dd>{parsed.questions.length} 道</dd>
          <dt>题型</dt>
          <dd>
            {[...byKind.entries()].map(([k, n]) => `${kindLabel(k)} ${n}`).join(' · ')}
          </dd>
          <dt>格式</dt>
          <dd>{parsed.format === 'openleaner' ? 'OpenLeaner 导出' : '通用格式'}</dd>
        </dl>

        {parsed.droppedFields.length > 0 ? (
          <p className="imp-warn">
            这些字段本软件用不到，已忽略：{parsed.droppedFields.join('、')}
          </p>
        ) : null}

        {/* 前 3 道题预览：让用户核对「解析出来的东西是不是他想要的」 */}
        <h4 className="imp-preview__sub">前几道题</h4>
        <ol className="imp-list">
          {parsed.questions.slice(0, 3).map((q, i) => (
            <li key={i} className="imp-item">
              <span className="imp-item__kind">{kindLabel(q.kind)}</span>
              <span className="imp-item__prompt">{q.prompt.slice(0, 80)}</span>
              <span className="imp-item__answer">答案：{q.answer.slice(0, 30)}</span>
            </li>
          ))}
        </ol>
        {parsed.questions.length > 3 ? (
          <p className="imp-hint">…以及另外 {parsed.questions.length - 3} 道</p>
        ) : null}

        {err ? (
          <p className="imp-error">
            {err.at > 0 ? `第 ${err.at} 题：` : ''}
            {err.msg}
            <span className="imp-error__hint">{err.hint}</span>
          </p>
        ) : null}

        <div className="imp-actions">
          <button type="button" className="btn-fill" onClick={() => void confirm()} disabled={busy}>
            {busy ? '导入中…' : `确认导入这 ${parsed.questions.length} 道题`}
          </button>
          <button type="button" className="btn-text" onClick={() => setStage({ kind: 'input' })} disabled={busy}>
            返回修改
          </button>
        </div>
      </div>
    );
  }

  /* ---------- 输入 ---------- */
  return (
    <div className="imp-input">
      <p className="imp-lead">
        把 JSON 粘贴进来，或选一个 .json 文件。支持本软件导出的格式，
        也接受常见的外部格式（字段名可以是 prompt/题干、answer/答案）。
      </p>

      <textarea
        className="imp-textarea"
        rows={8}
        placeholder={'{\n  "title": "第一章 · 题组",\n  "questions": [\n    { "kind": "single", "prompt": "…", "options": [{"key":"A","text":"…"}], "answer": "A" }\n  ]\n}'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled || busy}
      />

      <div className="imp-actions">
        <button
          type="button"
          className="btn-fill"
          onClick={preview}
          disabled={disabled || busy || text.trim().length === 0}
        >
          解析并预览
        </button>
        <button type="button" className="btn-ghost" onClick={() => fileRef.current?.click()} disabled={disabled || busy}>
          选文件…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json,.txt,text/plain"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pickFile(f);
            /* 清空 value，让同一个文件能再选一次 */
            e.target.value = '';
          }}
        />
      </div>

      {err ? (
        <p className="imp-error">
          {err.at > 0 ? `第 ${err.at} 题：` : ''}
          {err.msg}
          <span className="imp-error__hint">{err.hint}</span>
        </p>
      ) : null}

      <details className="imp-help">
        <summary>支持哪些字段</summary>
        <ul className="imp-help__list">
          <li>
            <strong>题干</strong>：prompt / 题干 / question
          </li>
          <li>
            <strong>答案</strong>：answer / 答案 / 正确答案
          </li>
          <li>
            <strong>题型</strong>：kind / type / 题型，取值为
            single·multiple·truefalse·blank·essay，或 单选·多选·判断·填空·问答；
            不写则按选项内容推断
          </li>
          <li>
            <strong>选项</strong>：[{'{'}key,text{'}'}, …] 或纯字符串数组（key 自动编 A/B/C）
          </li>
          <li>
            <strong>解析</strong>：explanation / 解析（可选）
          </li>
        </ul>
      </details>
    </div>
  );
}

/**
 * 导入闪卡面板（2026-11-24，用户要求「再加给导入闪卡功能」）。
 *
 * 只认 Obsidian Callout 版式（用户在选择里只勾了这一种）——
 * 也就是本应用自己导出的那种，所以导入与导出能往返。
 *
 * ## 流程：选文件 → 看清楚 → 确认
 *
 * 不做「选完文件直接入库」：导入是**不可自动撤销**的批量操作
 * （闪卡删除走单卡确认、批量走回收站，但导入进来的卡混进列表后
 * 用户很难再挑干净）。所以先给一张清单：解析出几张、有几张库里已经有了、
 * 有哪些告警，用户看完再按「导入」。
 *
 * ## 归属与标签在**导入时**选
 *
 * 用户的新要求是「写完闪卡后再决定归属」，导入同理：
 * 文件里的卡本身没有归属信息（Obsidian 那边只认 callout 类型），
 * 所以让用户在这一步统一决定这批卡归到哪一栏、打什么标签。
 * 文件里写了 `#flashcards/高数` 分节的，标签会预先填上；
 * 用户也可以再改。
 */

import { useRef, useState } from 'react';
import { CardGroupPicker } from './CardGroupPicker.tsx';
import { CardTagEditor } from './CardTagEditor.tsx';
import { parseFlashcardMarkdown, type ImportParseResult } from '@/v2/core/flashcard-import.ts';
import type { CardGroup } from '@/v2/core/callout-kind.ts';

export interface ImportDraft {
  front: string;
  back: string | null;
  tags: string[];
}

export interface FlashcardImportPanelProps {
  /** 库里已有的标签（给 CardTagEditor 当候选） */
  knownTags: readonly { tag: string; count: number }[];
  /** 库里已有的正面全文（判重预览用；不传就不做"已经有了"的预览） */
  existingFronts?: ReadonlySet<string>;
  busy?: boolean;
  onCancel: () => void;
  onImport: (cards: ImportDraft[], group: CardGroup) => void | Promise<void>;
}

export function FlashcardImportPanel({
  knownTags,
  existingFronts,
  busy,
  onCancel,
  onImport,
}: FlashcardImportPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ImportParseResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [group, setGroup] = useState<CardGroup>('memory');
  const [tags, setTags] = useState<string[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);

  /** 库里已有这些正面 → 会被 addMany 的按正面判重挡掉 */
  const dupes = parsed && existingFronts
    ? parsed.cards.filter((c) => existingFronts.has(c.front.trim()))
    : [];
  const willImport = parsed ? parsed.cards.length - dupes.length : 0;

  async function pickFile(f: File) {
    setErr(null);
    setParsed(null);
    setFileName(f.name);
    setSkipped([]);
    try {
      const text = await f.text();
      const r = parseFlashcardMarkdown(text);
      setParsed(r);
      /* 文件里带 `#flashcards/xxx` 的，把这个标签预填上（用户还能改） */
      if (r.tags.length > 0) setTags((cur) => (cur.length > 0 ? cur : r.tags));
      if (r.cards.length === 0) {
        setErr('这个文件里没找到闪卡。它得是 Obsidian Callout 版式（`> [!tip] 闪卡 1｜…`）。');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '读不出这个文件');
      setFileName(f.name);
    }
  }

  async function doImport() {
    if (!parsed) return;
    const cards: ImportDraft[] = parsed.cards
      .filter((c) => !(existingFronts && existingFronts.has(c.front.trim())))
      .map((c) => ({
        front: c.front,
        back: c.back,
        /* 用户这次填的标签优先；没填就用文件分节带来的 */
        tags: tags.length > 0 ? tags : c.tags,
      }));
    if (cards.length === 0) {
      setErr('没有可导入的卡。');
      return;
    }
    await onImport(cards, group);
    setSkipped([]);
  }

  return (
    <div className="fcx__new fcx__import">
      <h2 className="fcx__new-title">导入闪卡</h2>
      <p className="fcx__new-hint">
        从 Obsidian 的 Callout 闪卡文件导入。就是你库里那种「<code>&gt; [!tip] 闪卡 1｜标题</code>
        + <code>✅答案：</code>」的写法，也是本应用导出时的格式 —— 所以导出再导入能原样搬回来。
      </p>

      <div className="fcx__import-pick">
        <button
          type="button"
          className="btn-ghost btn-ghost--sm"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          选文件…
        </button>
        <span className="fcx__import-file">{fileName ?? '还没选文件（.md / .markdown / .txt）'}</span>
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pickFile(f);
            /* 清空 value，让同一个文件能再选一次 */
            e.target.value = '';
          }}
        />
      </div>

      {err ? <p className="fcx__err">{err}</p> : null}

      {parsed && parsed.cards.length > 0 ? (
        <>
          <ul className="fcx__import-stats">
            <li>
              认出 <b>{parsed.cards.length}</b> 张卡
            </li>
            {existingFronts ? (
              <li>
                其中 <b>{dupes.length}</b> 张库里已经有了（正面完全一样，会跳过）
              </li>
            ) : null}
            {parsed.tags.length > 0 ? (
              <li>
                文件里的卡组：<b>{parsed.tags.join('、')}</b>
              </li>
            ) : null}
            {parsed.ignoredLines > 0 ? <li>另有 {parsed.ignoredLines} 行不是卡（说明文字等），已忽略</li> : null}
          </ul>

          {parsed.warnings.length > 0 ? (
            <ul className="fcx__import-warn">
              {parsed.warnings.slice(0, 6).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
              {parsed.warnings.length > 6 ? <li>…还有 {parsed.warnings.length - 6} 条</li> : null}
            </ul>
          ) : null}

          {skipped.length > 0 ? (
            <p className="fcx__hint fcx__hint--bad">库里已有、这次跳过的：{skipped.join('、')}</p>
          ) : null}

          {/* 先看几张，确认解析对不对再导入 */}
          <details className="fcx__import-preview">
            <summary>预览前 {Math.min(5, parsed.cards.length)} 张</summary>
            <ol>
              {parsed.cards.slice(0, 5).map((c, i) => (
                <li key={i}>
                  <p className="fcx__front">{c.front.slice(0, 160)}</p>
                  <p className="fcx__back">{(c.back ?? '（没有背面）').slice(0, 160)}</p>
                </li>
              ))}
            </ol>
          </details>

          <CardGroupPicker
            value={group}
            onChange={setGroup}
            disabled={busy}
            label="这批卡归到哪一栏"
            hint="导入后随时能改：每张卡点「编辑」就能换归属。"
          />

          <CardTagEditor value={tags} known={knownTags} onChange={setTags} disabled={busy} />

          <div className="fcx__new-actions">
            <button
              type="button"
              className="btn-fill btn-fill--sm"
              onClick={() => void doImport()}
              disabled={busy || willImport === 0}
            >
              {willImport > 0 ? `导入 ${willImport} 张` : '没有可导入的卡'}
            </button>
            <button type="button" className="btn-ghost btn-ghost--sm" onClick={onCancel} disabled={busy}>
              收起
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

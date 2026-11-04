import { useRef, useState } from 'react';
import { Badge, Notice } from '@/components/states.tsx';
import type { ImportOutcome } from '@/core/sources.ts';
import { FAILURE_LABEL } from './format.ts';

/**
 * 导入面板：拖拽 / 多选文件 / 粘贴文字，三条路都通向同一张结果表。
 *
 * P1 的硬要求是「不要只说失败」，所以每次导入的结果都是**逐条**列出来的：
 * 成功的显示标题，失败的显示 message + hint，hint 用带底色的块，
 * 不会被当成附注略过。部分成功时两种结果同时在表里，
 * 用户能一眼看清哪几份没进来。
 *
 * 这里**不执行导入**：拿 service、算课程归属、刷新列表都是父组件的活，
 * 本组件只负责「选什么」和「显示什么」。
 */

export function ImportPanel({
  onImportFiles,
  onSaveText,
  importing,
  progress,
  outcomes,
  courseId,
  courses,
  onCourseChange,
  importError,
}: {
  onImportFiles: (files: File[]) => void | Promise<void>;
  onSaveText: (title: string, text: string) => void | Promise<void>;
  importing: boolean;
  progress: { done: number; total: number; current: string } | null;
  outcomes: ImportOutcome[] | null;
  courseId: string | null;
  courses: { id: string; name: string }[];
  onCourseChange: (courseId: string | null) => void;
  /** 整个导入流程层面的错误（不是单份失败），例如服务不可用 */
  importError: { message: string; hint: string } | null;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [mode, setMode] = useState<'files' | 'text'>('files');
  const [titleDraft, setTitleDraft] = useState('');
  const [textDraft, setTextDraft] = useState('');
  const [textBusy, setTextBusy] = useState(false);

  /*
   * 拖拽计数：dragenter/dragleave 会在子元素之间反复触发，
   * 直接置 false 会让落区在鼠标划过文字时闪一下。
   */
  const dragDepth = useRef(0);

  const submitFiles = (fileList: FileList | null) => {
    if (importing) return;
    if (!fileList || fileList.length === 0) return;
    void onImportFiles([...fileList]);
  };

  const submitText = () => {
    if (textBusy || importing || !textDraft.trim()) return;
    setTextBusy(true);
    void (async () => {
      try {
        await onSaveText(titleDraft, textDraft);
        setTextDraft('');
        setTitleDraft('');
      } finally {
        setTextBusy(false);
      }
    })();
  };

  const busy = importing || textBusy;
  const targetCourse = courseId ? courses.find((c) => c.id === courseId) : undefined;

  return (
    <section className="card" id="sources-import">
      <div className="card__head">
        <div>
          <div className="card__title">导入资料</div>
          <div className="card__subtitle">
            支持 PDF、Word（.docx）、PPT（.pptx）、Markdown、纯文本，可一次多份。
            {targetCourse
              ? `本次导入会归入「${targetCourse.name}」。`
              : '未指定课程时会落在「未分类」，导入后可以再改。'}
          </div>
        </div>
        <div className="page__row" style={{ flex: 'none' }}>
          <button
            type="button"
            className={`btn btn--sm${mode === 'files' ? ' btn--primary' : ''}`}
            onClick={() => setMode('files')}
          >
            选文件
          </button>
          <button
            type="button"
            className={`btn btn--sm${mode === 'text' ? ' btn--primary' : ''}`}
            onClick={() => setMode('text')}
          >
            粘贴文字
          </button>
        </div>
      </div>

      <div className="card__body page__stack">
        {/*
          导入目标课程要显式可选，而不是「最近建的那门课」这种隐式状态：
          隐式目标会让人导完才发现归错了课。
        */}
        <div className="field" style={{ maxWidth: 360 }}>
          <label className="field__label" htmlFor="import-course">
            归入课程
          </label>
          <select
            id="import-course"
            className="select"
            value={courseId ?? ''}
            onChange={(e) => onCourseChange(e.target.value === '' ? null : e.target.value)}
            disabled={busy}
          >
            <option value="">未分类</option>
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.name}
              </option>
            ))}
          </select>
          <div className="field__hint">
            {courses.length === 0
              ? '还没有课程。先在下面建一门，或者直接导入到「未分类」，之后能再改。'
              : '只影响这次导入；已有资料的归属在列表里单独改。'}
          </div>
        </div>

        {mode === 'files' ? (
          <div
            className={`dropzone${dragOver ? ' dropzone--over' : ''}`}
            onDragEnter={(e) => {
              e.preventDefault();
              dragDepth.current += 1;
              setDragOver(true);
            }}
            onDragOver={(e) => {
              // 必须 preventDefault，否则浏览器会把它当成「打开这个文件」并导航走
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              dragDepth.current = Math.max(0, dragDepth.current - 1);
              if (dragDepth.current === 0) setDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              dragDepth.current = 0;
              setDragOver(false);
              submitFiles(e.dataTransfer?.files ?? null);
            }}
          >
            <div className="dropzone__title">
              {importing ? '正在导入，请稍候…' : '把文件拖到这里，或点下面的按钮选'}
            </div>
            <div className="dropzone__hint">
              课件、讲义、整理好的笔记都行。扫描件也能导入——它会标出「没有文字层」，
              仍然可以翻看，只是搜不出字。
            </div>
            <div className="dropzone__actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
              >
                选择文件
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.pptx,.md,.markdown,.txt,application/pdf"
                multiple
                hidden
                onChange={(e) => {
                  submitFiles(e.target.files);
                  // 清空 value：否则连续选同一个文件不会再触发 onChange
                  e.target.value = '';
                }}
              />
            </div>
          </div>
        ) : (
          <div className="page__stack">
            <div className="field">
              <label className="field__label" htmlFor="paste-title">
                标题
              </label>
              <input
                id="paste-title"
                className="input"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                placeholder="例如：第三章 栈与队列 课堂笔记"
                maxLength={80}
                style={{ maxWidth: 480 }}
              />
              <div className="field__hint">不填也能存，会叫「粘贴的资料」。</div>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="paste-body">
                正文
              </label>
              <textarea
                id="paste-body"
                className="textarea"
                value={textDraft}
                onChange={(e) => setTextDraft(e.target.value)}
                placeholder="把整理好的笔记、从别处复制来的讲义正文粘在这里。段落之间空一行，阅读器会按段落显示。"
                style={{ minHeight: 200 }}
              />
              <div className="field__hint">
                已输入 {textDraft.length} 字
                {textDraft.trim() === '' ? '（还没有可保存的内容）' : ''}
              </div>
            </div>

            <div className="page__row">
              <button
                type="button"
                className="btn btn--primary"
                onClick={submitText}
                disabled={busy || !textDraft.trim()}
              >
                {textBusy ? '保存中…' : '存为资料'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setTextDraft('')}
                disabled={busy || textDraft === ''}
              >
                清空
              </button>
            </div>
          </div>
        )}

        {progress ? (
          <div className="import-progress" role="status" aria-live="polite">
            <div className="import-progress__line">
              <span className="spinner" aria-hidden="true" />
              <span>
                {/* core 的 onProgress 传的是「已完成份数」，显示时换成人类数数的「第 n 份」 */}
                正在导入 {Math.min(progress.done + 1, progress.total)}/{progress.total}
                {progress.current ? `：${progress.current}` : '…'}
              </span>
            </div>
            <div
              className="import-progress__bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
              aria-label="导入进度"
            >
              <div
                className="import-progress__fill"
                style={{
                  width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
        ) : null}

        {importError ? (
          <Notice tone="danger" title="这批文件没能开始导入">
            {importError.message}
            <br />
            <strong>下一步：</strong>
            {importError.hint}
          </Notice>
        ) : null}

        {outcomes && outcomes.length > 0 ? <ImportResults outcomes={outcomes} /> : null}
      </div>
    </section>
  );
}

/**
 * 逐条结果。
 *
 * 成功与失败在同一张表里，失败不会被折进「N 份失败」这种笼统说法 ——
 * 学生一次拖 5 份，必须能指出具体是哪一份、为什么、下一步做什么。
 */
export function ImportResults({ outcomes }: { outcomes: ImportOutcome[] }) {
  const okCount = outcomes.filter((o) => o.ok).length;
  const failCount = outcomes.length - okCount;

  return (
    <div className="import-result">
      <div className="import-result__summary">
        <strong>本次共 {outcomes.length} 份</strong>
        <Badge tone="ready">成功 {okCount}</Badge>
        {failCount > 0 ? <Badge tone="danger">失败 {failCount}</Badge> : null}
      </div>

      <ul className="import-result__list">
        {outcomes.map((outcome, i) => (
          <OutcomeRow key={`${outcome.fileName}-${i}`} outcome={outcome} />
        ))}
      </ul>

      {failCount > 0 ? (
        <Notice tone="warning" title="失败的几份没有进库">
          成功的已经在列表里了。按各自提示的原因处理后再单独拖进来一次即可，
          不需要重做已经成功的部分。
        </Notice>
      ) : null}
    </div>
  );
}

function OutcomeRow({ outcome }: { outcome: ImportOutcome }) {
  return (
    <li className={`outcome outcome--${outcome.ok ? 'ok' : 'fail'}`}>
      <div className="outcome__head">
        <span aria-hidden="true">{outcome.ok ? '✓' : '✕'}</span>
        <span className="outcome__name">{outcome.fileName}</span>
        {outcome.ok ? (
          <>
            <Badge tone="ready">已导入</Badge>
            {outcome.source ? (
              <span className="page__muted">
                「{outcome.source.title}」· {outcome.source.segmentCount} 段
              </span>
            ) : null}
          </>
        ) : (
          <Badge tone="danger">
            {outcome.failure ? FAILURE_LABEL[outcome.failure.code] : '失败'}
          </Badge>
        )}
      </div>

      {!outcome.ok && outcome.failure ? (
        <>
          <div className="outcome__message">{outcome.failure.message}</div>
          {/* hint 是硬要求：只给原因不给下一步，等于把排查丢回给学生 */}
          <div className="outcome__hint">
            <strong>下一步：</strong>
            {outcome.failure.hint}
          </div>
        </>
      ) : null}
    </li>
  );
}

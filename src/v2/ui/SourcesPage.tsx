import { useCallback, useEffect, useRef, useState } from 'react';
import type { Source } from '@/core/model.ts';
import type { SourceService, ImportOutcome } from '@/core/sources.ts';
import { IconSources, IconUpload } from './icons.tsx';
import { ConfirmDialog } from './dialog.tsx';

/**
 * 资料页。
 *
 * 按截图还原：
 *  - 标题「资料」+ 副标题 + 右侧「已归档 (N)」+ 朱砂「添加资料」按钮
 *  - 三个标签：文件 / 粘贴文本 / 音频 / 录音
 *  - 虚线拖放区（可一次放多个）
 *  - 格式说明那一行灰字
 *  - 「PDF 解析」折叠（讲扫描件与公式多的文件）
 *
 * ## 为什么标签而不是一个按钮
 *
 * 三种资料的「导入体验」完全不同：
 * 文件要选/拖，粘贴要文本框，音频要上传后转写。
 * 塞进一个入口会让用户猜「我该点哪里」。
 */

type Tab = 'file' | 'paste' | 'audio';

export interface SourcesPageProps {
  service: SourceService;
  onOpenSource: (source: Source) => void;
  /** 导入成功后通知上层刷新卡片池 */
  onImported?: () => void;
}

export function SourcesPage({ service, onOpenSource, onImported }: SourcesPageProps) {
  const [tab, setTab] = useState<Tab>('file');
  const [sources, setSources] = useState<Source[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; name: string } | null>(
    null,
  );
  const [results, setResults] = useState<ImportOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  /** 待删除的资料。二级确认框由它驱动，删完清空。 */
  const [deleting, setDeleting] = useState<Source | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const all = await service.list();
      setSources(all);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不出资料列表');
    }
  }, [service]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 删除一份资料。
   *
   * 用 SourceService.remove() —— 它会级联删掉段、原始字节、手写注释，
   * 但**不会**删由这份资料整理出来的知识点、题组、题目与复习记录
   * （这些是「改数据模型/删除语义」的岔路，本轮不动）。
   * 所以确认框里必须把「哪些会一起删、哪些会留下孤儿」讲清楚，
   * 不能只写一句「确定删除吗」。
   */
  const confirmDelete = useCallback(async () => {
    if (!deleting) return;
    await service.remove(deleting.id);
    setDeleting(null);
    setResults(null);
    setError(null);
    await load();
    onImported?.();
  }, [deleting, service, load, onImported]);

  /** 导入文件（拖放与选择共用） */
  const importFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || busy) return;
      setBusy(true);
      setError(null);
      setResults(null);
      setProgress({ done: 0, total: files.length, name: files[0]?.name ?? '' });

      try {
        const outcomes = await service.importFiles(files, {
          onProgress: (done, total, name) => setProgress({ done, total, name }),
        });
        setResults(outcomes);
        await load();
        onImported?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : '导入失败');
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [service, busy, load, onImported],
  );

  /** 粘贴文本导入 */
  const importPasted = useCallback(async () => {
    const text = pasteText.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const source = await service.importText(pasteTitle.trim() || '粘贴的文本', text);
      setResults([{ fileName: source.title, ok: true, source }]);
      setPasteText('');
      setPasteTitle('');
      await load();
      onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败');
    } finally {
      setBusy(false);
    }
  }, [service, pasteText, pasteTitle, busy, load, onImported]);

  /*
   * 归档功能 v1 没有实现（Source 上没这个字段）。
   * 这里不显示「已归档 (0)」—— 那会让人以为能点开一个空列表。
   * 等真做了归档再放上去。
   */

  return (
    <div className="sources-page">
      {/* 头部 */}
      <div className="sources-head">
        <div>
          <h1 className="sources-title">资料</h1>
          <p className="sources-sub">题目从这里生长。原文与引用一直保留。</p>
        </div>
        <div className="sources-head__right">
          <button
            type="button"
            className="btn-fill btn-fill--sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
          >
            <IconUpload size={15} />
            添加资料
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.docx,.pptx,.md,.markdown,.txt,.png,.jpg,.jpeg,.webp,.gif,.bmp,application/pdf,image/*"
        multiple
        hidden
        onChange={(e) => {
          void importFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />

      {/* 空状态提示（还没有任何资料时） */}
      {sources !== null && sources.length === 0 ? (
        <div className="sources-empty">
          <h2 className="sources-empty__title">还没有资料</h2>
          <p className="sources-empty__desc">
            添加讲义、笔记或录音，之后就能用它们出题；题目会引用原文。
          </p>
        </div>
      ) : null}

      {/* 课程选择（简化版：未分类） */}
      <div className="sources-course">
        <span className="sources-course__label">未分类</span>
        <button type="button" className="btn-text">
          更改
        </button>
      </div>

      {/* 三标签 */}
      <div className="sources-tabs" role="tablist">
        {(
          [
            ['file', '文件', IconSources],
            ['paste', '粘贴文本', null],
            ['audio', '音频 / 录音', null],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`sources-tab${tab === id ? ' sources-tab--on' : ''}`}
            onClick={() => setTab(id as Tab)}
          >
            {Icon ? <Icon size={15} /> : null}
            {label}
          </button>
        ))}
      </div>

      {/* ---- 文件 ---- */}
      {tab === 'file' ? (
        <div
          className={`dropzone${dragging ? ' dropzone--over' : ''}${busy ? ' dropzone--busy' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void importFiles(Array.from(e.dataTransfer.files));
          }}
        >
          {busy && progress ? (
            <>
              <div className="dropzone__title">
                正在导入 {progress.done}/{progress.total}
              </div>
              <div className="dropzone__name">{progress.name}</div>
              <div className="dropzone__bar">
                <div
                  className="dropzone__bar-fill"
                  style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
                />
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                className="dropzone__inner"
                onClick={() => fileInputRef.current?.click()}
              >
                <span className="dropzone__icon" aria-hidden="true">
                  <IconUpload size={22} />
                </span>
                <span className="dropzone__title">把讲义、笔记或题组文件拖到这里，可以一次放多个</span>
                <span className="dropzone__formats">
                  PDF · Word · PowerPoint · Markdown · HTML · TXT · JSON 题组 · SRT / VTT 字幕 · PDF 与文本最大 8 MB，Word / PPT 最大 40 MB
                </span>
              </button>
              <button
                type="button"
                className="btn-ghost dropzone__pick"
                onClick={() => fileInputRef.current?.click()}
              >
                选择文件
              </button>
            </>
          )}
        </div>
      ) : null}

      {/* ---- 粘贴文本 ---- */}
      {tab === 'paste' ? (
        <div className="paste-box">
          <input
            className="paste-title"
            value={pasteTitle}
            onChange={(e) => setPasteTitle(e.target.value)}
            placeholder="标题（可选，默认取前 20 个字）"
            disabled={busy}
          />
          <textarea
            className="paste-area"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="把讲义或笔记粘贴到这里…"
            rows={10}
            disabled={busy}
          />
          <div className="paste-foot">
            <span className="paste-count">{pasteText.trim().length} 字</span>
            <button
              type="button"
              className="btn-fill btn-fill--sm"
              onClick={() => void importPasted()}
              disabled={busy || pasteText.trim().length === 0}
            >
              导入这段文字
            </button>
          </div>
        </div>
      ) : null}

      {/* ---- 音频 ---- */}
      {tab === 'audio' ? (
        <div className="audio-todo">
          <p className="audio-todo__text">
            音频转写还在做。现在需要的话，可以先用别的工具转成文字，
            再粘贴到「粘贴文本」里导入 —— 效果一样。
          </p>
        </div>
      ) : null}

      {/* 格式说明折叠 */}
      <details className="sources-note">
        <summary>
          <span>PDF 解析</span>
          <span className="sources-note__hint">扫描件、公式多或大文件</span>
        </summary>
        <p>
          讲义和笔记保存为资料，原文件一并保留；JSON 题组存为草稿；
          字幕和录音在「音频 / 录音」里确认用量后导入。
        </p>
      </details>

      {/* 导入结果 */}
      {error ? <div className="sources-error">{error}</div> : null}
      {results ? (
        <ul className="import-results">
          {results.map((r, i) => (
            <li key={i} className={r.ok ? 'import-result--ok' : 'import-result--bad'}>
              {r.ok ? '✓' : '✕'} {r.fileName}
              {!r.ok && r.failure ? (
                <span className="import-result__reason" title={r.failure.hint}>
                  {r.failure.message}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {/* 资料列表 */}
      {sources !== null && sources.length > 0 ? (
        <ul className="source-list">
          {sources.map((s) => (
            <li key={s.id} className="source-item">
              <button type="button" className="source-row" onClick={() => onOpenSource(s)}>
                <span className="source-row__title">{s.title}</span>
                <span className="source-row__meta">
                  {s.kind.toUpperCase()} · {s.pageCount ?? '?'} 页 · {s.segmentCount} 段
                </span>
              </button>
              <button
                type="button"
                className="source-item__delete"
                aria-label={`删除「${s.title}」`}
                title="删除这份资料"
                disabled={busy}
                onClick={() => setDeleting(s)}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`删除「${deleting.title}」？`}
          description="这份资料的正文、原始文件与手写批注会一起删掉，不能撤销。"
          confirmLabel="删除"
          onConfirm={confirmDelete}
          onClose={() => setDeleting(null)}
        >
          <p className="set-hint" style={{ marginTop: 0 }}>
            注意：由它整理出的知识点、题组、题目和复习记录不会删（它们还在库里，
            但已经点不回原文）。要清掉这些，得先删对应的题组或重新整理。
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

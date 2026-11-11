import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  /** 点资料行 —— 打开阅读器看原文 */
  onOpenSource: (source: Source) => void;
  /** 点「整理」—— 把这份资料整理成知识点 */
  onOrganizeSource?: (source: Source) => void;
  /** 导入成功后通知上层刷新卡片池 */
  onImported?: () => void;
}

export function SourcesPage({
  service,
  onOpenSource,
  onOrganizeSource,
  onImported,
}: SourcesPageProps) {
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

  /**
   * 本机 MinerU 是否可用（2026-11-11）。
   *
   * 从 preload 的同步 getter 读 —— 主进程启动时探测过一次，
   * 这里只取结果，不再触发探测。
   *
   * 为什么要判断它：无文字层的文件只有靠 MinerU 才能转出正文。
   * 没装的时候不该给一个点了必然失败的按钮（硬约束：不做假开关），
   * 而应直接说明去哪装。
   */
  const mineruReady = Boolean(
    typeof window !== 'undefined' ? window.openleaner?.mineru?.available : false,
  );

  /**
   * 导入后发现的「没有文字层」的资料（2026-11-11）。
   *
   * 只在**刚导入**的结果里找，不是全库扫：
   * 全库扫会把用户几个月前的旧扫描件每次都翻出来提醒一遍，
   * 那是骚扰而不是帮助。
   */
  const noTextSources: Source[] = useMemo(() => {
    const out: Source[] = [];
    for (const r of results ?? []) {
      if (r.ok && r.source && r.source.textStatus === 'no-text-layer') {
        /* 同一次导入里可能重复出现（拖了两次同名文件），去重 */
        if (!out.some((s) => s.id === r.source!.id)) out.push(r.source);
      }
    }
    return out;
  }, [results]);

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
        /*
         * 把每个导入成功的资料与原文件的绝对路径对应起来登记给主进程。
         *
         * 为什么现在做：扫描件转换要用本机 MinerU，而 MinerU 是命令行程序，
         * 需要磁盘上的路径 —— 但渲染进程的 File 对象没有路径（浏览器安全设计）。
         * 只有在**导入的这一刻**我们手里同时有 File 和刚生成的 sourceId，
         * 过了这一步就再也拿不到原始路径了。
         *
         * 桌面版才有这个能力；浏览器里 pathOf 返回 null，静默跳过即可 ——
         * 浏览器本来也跑不了 MinerU。
         */
        void rememberSourcePaths(files, outcomes);

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

      {/*
        课程选择条已删除（2026-11-11）。

        原来这里是「未分类  更改」—— 但那个「更改」按钮没有任何 onClick，
        点下去什么都不会发生。用户明确反馈「这两个按钮是假的，删掉」。

        而且整条都是死的：它不显示真实的课程归属（永远写死「未分类」），
        也不反映资料页的筛选状态。留着比没有更糟 ——
        它让用户以为能改，试一次就发现是摆设。

        真要做「按课程归类资料」，得先有课程管理（建/改名/删除）与
        逐份资料的归属编辑，那是独立一件事，不在这一行里硬塞。
      */}

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

      {/*
        「PDF 解析」折叠块已删除（2026-11-11）。

        用户反馈「图二的按钮是假的，删掉」。核对后确实两边都不成立：
        - **标题与内容不符**：标题写「PDF 解析」，展开讲的却是
          「讲义保存为资料 / JSON 存草稿 / 字幕在音频里导入」——
          跟 PDF 解析没有任何关系。
        - **点了没有动作**：它只是个 <details>，没有任何解析入口。
          真正的 PDF 解析（MinerU）在「整理知识点 / 转换」那条流程里，
          且需要有模型才能用。

        留着会让用户以为「这里能开启 PDF 解析」，点开却看到无关说明。
        真要给解析入口，应该做成「选中资料 → 开始解析」的按钮，
        而不是一个假装是开关的折叠块。
      */}

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

      {/*
        无文字层提醒（2026-11-11）。
        用户要求：「导入没有文字层的 PDF 或图片时，先提醒是否需要 PDF 解析」。

        为什么放在导入结果下面而不是导入前弹窗：
        导入前我们**不知道**这个文件有没有文字层 —— 要解析完才知道。
        所以只能在导入完成后提示，这时判断是准确的（textStatus 已定）。

        为什么要点名是哪几个文件：
        一次拖五个文件时，用户需要知道是哪一个没文字，
        而不是笼统说「有文件解析失败」。
      */}
      {noTextSources.length > 0 ? (
        <div className="sources-notice sources-notice--warn">
          <p className="sources-notice__title">
            这些文件没有文字层，暂时读不到正文
          </p>
          <ul className="sources-notice__list">
            {noTextSources.map((s) => (
              <li key={s.id}>{s.title}</li>
            ))}
          </ul>
          <p className="sources-notice__body">
            扫描件、拍照或截图类文件里的字是「图片」而不是「文本」，软件读不到。
            可以用 <strong>MinerU</strong> 做一次解析，把图里的字转成正文，之后就能
            整理知识点、出题、搜索了。
          </p>
          <div className="sources-notice__actions">
            {mineruReady ? (
              onOrganizeSource ? (
                <button
                  type="button"
                  className="btn-fill btn-fill--sm"
                  onClick={() => onOrganizeSource(noTextSources[0]!)}
                >
                  去解析这份资料
                </button>
              ) : null
            ) : (
              /*
               * 没有 MinerU 时不摆一个点了会失败的按钮，
               * 直接说明去哪装（硬约束：不做假开关）。
               */
              <span className="sources-notice__hint">
                本机还没有 MinerU。到「设置 → 模型与解析」里可以查看安装方式。
              </span>
            )}
          </div>
        </div>
      ) : null}

      {/* 资料列表 */}
      {sources !== null && sources.length > 0 ? (
        <ul className="source-list">
          {sources.map((s) => (
            <li key={s.id} className="source-item">
              <button
                type="button"
                className="source-row"
                onClick={() => onOpenSource(s)}
                title="打开原文"
              >
                <span className="source-row__title">{s.title}</span>
                <span className="source-row__meta">
                  {s.kind.toUpperCase()} · {s.pageCount ?? '?'} 页 · {s.segmentCount} 段
                </span>
              </button>
              {onOrganizeSource ? (
                <button
                  type="button"
                  className="source-item__organize"
                  aria-label={`整理「${s.title}」`}
                  title="整理成知识点"
                  disabled={busy}
                  onClick={() => onOrganizeSource(s)}
                >
                  整理
                </button>
              ) : null}
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

/**
 * 把「导入成功的资料」与其原文件绝对路径登记给主进程。
 *
 * 只在桌面版有效：`pathOf` 依赖 Electron 的 webUtils，
 * 浏览器里拿不到路径（那是浏览器安全设计，不是缺陷）。
 * 拿不到就静默跳过 —— 浏览器本来也跑不了 MinerU。
 *
 * 匹配策略：`importFiles` 返回的结果里带 `source`，而 `File` 带 `name`。
 * 同名多选时按顺序配对。宁可保守（配不上就不登记），也不要错配 ——
 * 错配会让转换读到**另一份**文件的路径，然后把别人的内容写进这份资料。
 */
async function rememberSourcePaths(
  files: File[],
  outcomes: Array<{ ok: boolean; source?: { id: string }; fileName?: string }>,
): Promise<void> {
  const mineru = typeof window !== 'undefined' ? window.openleaner?.mineru : undefined;
  if (!mineru || typeof mineru.pathOf !== 'function') return;

  // 按文件名分组，保持各自的选取顺序
  const byName = new Map<string, File[]>();
  for (const f of files) {
    const list = byName.get(f.name) ?? [];
    list.push(f);
    byName.set(f.name, list);
  }

  for (const outcome of outcomes) {
    if (!outcome.ok || !outcome.source) continue;
    const candidates = byName.get(outcome.fileName ?? '');
    const file = candidates?.shift();
    if (!file) continue;

    const absolute = mineru.pathOf(file);
    if (!absolute) continue;
    try {
      await mineru.rememberPath(outcome.source.id, absolute);
    } catch {
      // 登记失败不影响导入本身，转换时会给出「拿不到路径」的说明
    }
  }
}

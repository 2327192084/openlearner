import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorState, LoadingState, Notice } from '@/components/states.tsx';
import { useServices } from '@/app/services-context.ts';
import { backupFileName, LibraryError } from '@/core/library.ts';
import type { LibraryMeta } from '@/core/model.ts';
import { BackendSection } from './BackendSection.tsx';
import '@/components/page.css';

type Flash = { tone: 'info' | 'warning' | 'danger'; text: string } | null;

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; hint: string }
  | { kind: 'ready'; meta: LibraryMeta | null; counts: Record<string, number> };

/**
 * 设置页：P0 里唯一有真实动作的页面。
 *
 * 承担两件事（对应计划书 P0 第 3、4 条）：
 *  - 学习库：创建、重命名、导出备份、从备份恢复
 *  - AI 后端配置：录入并保存（只存不联调，P5 才真正调用）
 */
export function SettingsPage() {
  const { library } = useServices();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash>(null);
  const [nameDraft, setNameDraft] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const meta = await library.getMeta();
      const counts = meta ? await library.counts() : {};
      setState({ kind: 'ready', meta, counts });
      setNameDraft((prev) => (prev === '' ? (meta?.name ?? '我的学习库') : prev));
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
        hint: '刷新页面重试；若持续失败，可能是浏览器或系统禁用了本地存储（无痕模式常见）',
      });
    }
  }, [library]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async () => {
    setBusy('create');
    setFlash(null);
    try {
      const meta = await library.create(nameDraft || '我的学习库');
      setFlash({ tone: 'info', text: `学习库「${meta.name}」已创建` });
      setNameDraft(meta.name);
      await refresh();
    } catch (err) {
      setFlash({ tone: 'danger', text: describe(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleRename = async () => {
    setBusy('rename');
    setFlash(null);
    try {
      const meta = await library.rename(nameDraft);
      setFlash({ tone: 'info', text: `已重命名为「${meta.name}」` });
      setNameDraft(meta.name);
      await refresh();
    } catch (err) {
      setFlash({ tone: 'danger', text: describe(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleExport = async () => {
    setBusy('export');
    setFlash(null);
    try {
      const backup = await library.exportBackup();
      const fileName = backupFileName(backup.meta);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      downloadBlob(blob, fileName);
      setFlash({ tone: 'info', text: `已导出「${fileName}」，不含任何 API 凭据` });
    } catch (err) {
      setFlash({ tone: 'danger', text: describe(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleImportFile = async (file: File) => {
    setBusy('import');
    setFlash(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new LibraryError(
          '这个文件不是有效的 JSON',
          '请确认选的是「导出学习库」生成的 .json 文件，而不是被改过扩展名的其他文件',
        );
      }
      const meta = await library.importBackup(parsed);
      setFlash({ tone: 'info', text: `已从备份恢复学习库「${meta.name}」` });
      setNameDraft(meta.name);
      await refresh();
    } catch (err) {
      const msg = describe(err);
      const hint =
        err instanceof LibraryError ? err.hint : '检查文件是否完整；原学习库未被改动，可以放心重试';
      setFlash({ tone: 'danger', text: `${msg}。${hint}` });
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  if (state.kind === 'loading') return <LoadingState label="正在读取学习库…" />;

  if (state.kind === 'error') {
    return (
      <ErrorState
        title="读不到学习库"
        message={state.message}
        hint={state.hint}
        onRetry={() => void refresh()}
      />
    );
  }

  const { meta, counts } = state;
  const totalRecords = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="page page__stack">
      <header className="page__head">
        <div className="page__head-main">
          <h2 className="page__title">设置</h2>
          <p className="page__summary">
            学习库的位置与备份，以及 AI 后端的录入。P0 只做界面与保存，不联调；后端真正被调用要等
            P2/P5。
          </p>
        </div>
      </header>

      {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}

      <section className="card">
        <div className="card__head">
          <div>
            <div className="card__title">学习库</div>
            <div className="card__subtitle">
              资料和生成结果都存在这里。整库可导出成一个文件，换机器时导入即可。
            </div>
          </div>
        </div>
        <div className="card__body page__stack">
          {meta ? (
            <>
              <div className="field">
                <label className="field__label" htmlFor="lib-name">
                  学习库名称
                </label>
                <div className="page__row">
                  <input
                    id="lib-name"
                    className="input"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    maxLength={60}
                    style={{ maxWidth: 320 }}
                  />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void handleRename()}
                    disabled={busy !== null || nameDraft.trim() === meta.name || !nameDraft.trim()}
                  >
                    {busy === 'rename' ? '保存中…' : '重命名'}
                  </button>
                </div>
              </div>

              <dl className="dl">
                <dt>创建时间</dt>
                <dd>{formatTime(meta.createdAt)}</dd>
                <dt>最后更新</dt>
                <dd>{formatTime(meta.updatedAt)}</dd>
                <dt>结构版本</dt>
                <dd>v{meta.schemaVersion}</dd>
                <dt>库内记录</dt>
                <dd>
                  {totalRecords} 条
                  <span className="page__muted">
                    （课程 {counts.courses ?? 0} · 资料 {counts.sources ?? 0} · 知识点{' '}
                    {counts.knowledgePoints ?? 0} · 习题集 {counts.decks ?? 0} · 题目{' '}
                    {counts.questions ?? 0} · 幻灯片 {counts.slideDecks ?? 0} · 后端{' '}
                    {counts.backends ?? 0}）
                  </span>
                </dd>
              </dl>

              <div className="page__row">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void handleExport()}
                  disabled={busy !== null}
                >
                  {busy === 'export' ? '导出中…' : '导出学习库'}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy !== null}
                >
                  {busy === 'import' ? '导入中…' : '从备份恢复'}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleImportFile(file);
                  }}
                />
              </div>

              <Notice tone="warning" title="导入会整体替换现有学习库">
                恢复备份是整库替换，不是合并。现在库里的内容会被备份文件覆盖，请先导出一份当前库留底。
                凭据不会随备份走，导入后需要重新填写 API Key。
              </Notice>
            </>
          ) : (
            <>
              <Notice tone="info" title="还没有学习库">
                学习库是存放资料与生成结果的地方，一个就够用。创建之后它保存在本机，关掉应用再打开仍然在。
              </Notice>
              <div className="page__row">
                <input
                  className="input"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder="我的学习库"
                  maxLength={60}
                  style={{ maxWidth: 320 }}
                  aria-label="学习库名称"
                />
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void handleCreate()}
                  disabled={busy !== null}
                >
                  {busy === 'create' ? '创建中…' : '创建学习库'}
                </button>
                {/*
                  换机器后的第一条路就是「从备份恢复」，所以这个入口在**没有库**时
                  也必须存在。之前只在已建库分支里渲染，等于把最需要它的场景关掉了。
                */}
                <button
                  type="button"
                  className="btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy !== null}
                >
                  {busy === 'import' ? '导入中…' : '从备份恢复'}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleImportFile(file);
                  }}
                />
              </div>
              <div className="field__hint">
                之前导出过学习库备份？直接选文件恢复即可，不需要先手动建一个空库。
              </div>
            </>
          )}
        </div>
      </section>

      <BackendSection
        onFlash={setFlash}
        onChanged={() => {
          // 只刷计数，不重置 flash —— 否则刚弹出的成功提示会被立刻清掉
          void (async () => {
            if (state.kind !== 'ready' || !state.meta) return;
            const counts = await library.counts();
            setState({ kind: 'ready', meta: state.meta, counts });
          })();
        }}
      />
    </div>
  );
}

/** 触发浏览器下载。Electron 里同样走 Blob + a.click()，会弹系统保存对话框。 */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器来不及读到 blob，让出一个宏任务再释放
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
}

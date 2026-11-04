import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, EmptyState, ErrorState, LoadingState, Notice } from '@/components/states.tsx';
import { useServices } from '@/app/services-context.ts';
import type { Course, Source } from '@/core/model.ts';
import type { CourseGroup, ImportOutcome } from '@/core/sources.ts';
import { ImportPanel } from './ImportPanel.tsx';
import { SourceReader } from './SourceReader.tsx';
import { SourceDetailDrawer } from './SourceDetailDrawer.tsx';
import {
  TEXT_STATUS_LABEL,
  formatPageCount,
  formatTime,
  kindLabel,
} from './format.ts';
import { describeError, hintFrom } from './types.ts';
import type { Flash, Load } from './types.ts';
import './sources.css';
import './reader.css';

/**
 * 资料库页面（P1）。
 *
 * 结构上只有一个页面组件，用 `view` 状态在「列表」与「阅读器」之间切换 ——
 * 注册表只有 `/sources` 一条路由，加子路由要改 `core/registry.ts`，
 * 那是别人的域，而且没必要：这里本来就是「库 → 打开其中一份」的两层视图。
 *
 * 状态组织照 SettingsPage 的写法：
 *  - 一次加载进 `Load<T>` 联合类型，三态显式；
 *  - 每个写动作自带 busy，避免双击重复提交；
 *  - 结果用 Flash（单条）或 outcomes（多条）如实显示，不吞失败。
 */
export function SourcesPage() {
  const { sources: sourceService, courses: courseService } = useServices();

  const [view, setView] = useState<
    { kind: 'list' } | { kind: 'reader'; sourceId: string }
  >({ kind: 'list' });

  const [groups, setGroups] = useState<Load<CourseGroup[]>>({ kind: 'loading' });
  const [flash, setFlash] = useState<Flash>(null);

  // ---- 导入 ----
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(
    null,
  );
  const [outcomes, setOutcomes] = useState<ImportOutcome[] | null>(null);
  const [importError, setImportError] = useState<{ message: string; hint: string } | null>(null);
  /** 当前导入目标课程。null = 未分类 */
  const [importCourseId, setImportCourseId] = useState<string | null>(null);

  // ---- 课程操作 ----
  const [courseNameDraft, setCourseNameDraft] = useState('');
  const [courseBusy, setCourseBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  // ---- 详情抽屉 ----
  const [detailOpen, setDetailOpen] = useState(false);

  /** 换课程下拉的 busy，按资料 id 区分，避免整列表一起禁用 */
  const [movingId, setMovingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await sourceService.listByCourse();
      setGroups({ kind: 'ready', data: list });
    } catch (err) {
      setGroups({
        kind: 'error',
        message: describeError(err),
        hint: '资料列表读不出来通常是本地存储的问题。先刷新页面重试；如果提示存储不可用，检查是否在无痕模式或磁盘是否已满。',
      });
    }
  }, [sourceService]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const courses: Course[] = useMemo(() => {
    if (groups.kind !== 'ready') return [];
    return groups.data.map((g) => g.course).filter((c): c is Course => c !== null);
  }, [groups]);

  const allSources: Source[] = useMemo(() => {
    if (groups.kind !== 'ready') return [];
    return groups.data.flatMap((g) => g.sources);
  }, [groups]);

  const activeSource =
    view.kind === 'reader' ? allSources.find((s) => s.id === view.sourceId) ?? null : null;

  // -------------------------------------------------------------------------
  // 导入
  // -------------------------------------------------------------------------

  const handleImportFiles = async (files: File[]) => {
    setImporting(true);
    setImportError(null);
    setOutcomes(null);
    setProgress({ done: 0, total: files.length, current: files[0]?.name ?? '' });

    try {
      const result = await sourceService.importFiles(files, {
        courseId: importCourseId,
        onProgress: (done, total, current) => setProgress({ done, total, current }),
      });
      setOutcomes(result);

      const ok = result.filter((r) => r.ok).length;
      const failed = result.length - ok;
      if (ok > 0) {
        // 成功时的提示与结果表并存：结果表说细节，Flash 给一句结论
        setFlash({
          tone: failed > 0 ? 'warning' : 'info',
          text: `已导入 ${ok} 份资料${failed > 0 ? `，${failed} 份失败（原因在导入结果里）` : ''}`,
        });
        await refresh();
      }
    } catch (err) {
      setImportError({
        message: describeError(err),
        hint: hintFrom(
          err,
          '这批文件一份都没进来，原来的资料不受影响。可以拆成单份再试，或用不同格式另存后导入。',
        ),
      });
    } finally {
      setImporting(false);
      setProgress(null);
    }
  };

  const handleSaveText = async (title: string, text: string) => {
    setImportError(null);
    try {
      const source = await sourceService.importText(title, text, { courseId: importCourseId });
      setOutcomes([{ fileName: title.trim() || '粘贴的资料', ok: true, source }]);
      setFlash({ tone: 'info', text: `已存为资料「${source.title}」，${source.segmentCount} 段` });
      await refresh();
    } catch (err) {
      setImportError({
        message: describeError(err),
        hint: hintFrom(err, '检查正文是否为空；把内容复制到记事本再贴回来通常就能保存。'),
      });
    }
  };

  // -------------------------------------------------------------------------
  // 课程
  // -------------------------------------------------------------------------

  const handleCreateCourse = async () => {
    const name = courseNameDraft.trim();
    if (!name) return;
    setCourseBusy(true);
    setFlash(null);
    try {
      const course = await courseService.create(name);
      setCourseNameDraft('');
      setImportCourseId(course.id);
      setFlash({ tone: 'info', text: `已新建课程「${course.name}」，之后的导入默认归到这门课` });
      await refresh();
    } catch (err) {
      setFlash({
        tone: 'danger',
        text: `${describeError(err)}。${hintFrom(err, '课程名不能为空，换一个名字再试。')}`,
      });
    } finally {
      setCourseBusy(false);
    }
  };

  const handleRenameCourse = async (course: Course) => {
    const name = renameDraft.trim();
    if (!name || name === course.name) {
      setRenamingId(null);
      return;
    }
    setCourseBusy(true);
    try {
      await courseService.rename(course.id, name);
      setRenamingId(null);
      setFlash({ tone: 'info', text: `课程已改名为「${name}」` });
      await refresh();
    } catch (err) {
      setFlash({
        tone: 'danger',
        text: `${describeError(err)}。${hintFrom(err, '课程名不能为空。')}`,
      });
    } finally {
      setCourseBusy(false);
    }
  };

  const handleRemoveCourse = async (course: Course) => {
    const count = groups.kind === 'ready'
      ? groups.data.find((g) => g.course?.id === course.id)?.sources.length ?? 0
      : 0;

    const ok = window.confirm(
      `删除课程「${course.name}」？\n\n` +
        `资料不会被删除：这门课下的 ${count} 份资料会移到「未分类」，之后可以再归到别的课程。\n` +
        `已生成的知识点和题目也不受影响。`,
    );
    if (!ok) return;

    setCourseBusy(true);
    setFlash(null);
    try {
      await courseService.remove(course.id);
      setFlash({
        tone: 'info',
        // 不能说「已删除」——用户会以为资料也没了
        text: `课程「${course.name}」已删除，${count} 份资料移到了「未分类」`,
      });
      if (importCourseId === course.id) setImportCourseId(null);
      await refresh();
    } catch (err) {
      setFlash({
        tone: 'danger',
        text: `${describeError(err)}。${hintFrom(err, '刷新页面后重试；资料本身不会受影响。')}`,
      });
    } finally {
      setCourseBusy(false);
    }
  };

  const handleMoveSource = async (source: Source, courseId: string | null) => {
    if (source.courseId === courseId) return;
    setMovingId(source.id);
    setFlash(null);
    try {
      await sourceService.setCourse(source.id, courseId);
      const target = courseId ? courses.find((c) => c.id === courseId)?.name : null;
      setFlash({
        tone: 'info',
        text: `「${source.title}」已移到「${target ?? '未分类'}」`,
      });
      await refresh();
    } catch (err) {
      setFlash({
        tone: 'danger',
        text: `${describeError(err)}。${hintFrom(err, '资料仍留在原来的课程里，可以重试或刷新后确认。')}`,
      });
    } finally {
      setMovingId(null);
    }
  };

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  if (groups.kind === 'loading') {
    return <LoadingState label="正在读取资料库…" />;
  }

  if (groups.kind === 'error') {
    return (
      <ErrorState
        title="读不到资料库"
        message={groups.message}
        hint={groups.hint}
        onRetry={() => void refresh()}
      />
    );
  }

  // ---- 阅读器视图 ----
  if (view.kind === 'reader') {
    if (!activeSource) {
      return (
        <ErrorState
          title="这份资料找不到了"
          message="它可能刚被删除，或者当前学习库里没有这个 id。"
          hint="回到资料列表重新选一份。"
          onRetry={() => setView({ kind: 'list' })}
          retryLabel="回到资料列表"
        />
      );
    }

    return (
      <>
        <SourceReader
          source={activeSource}
          service={sourceService}
          onBack={() => {
            setDetailOpen(false);
            setView({ kind: 'list' });
          }}
          onOpenDetail={() => setDetailOpen(true)}
        />
        <SourceDetailDrawer
          source={activeSource}
          service={sourceService}
          open={detailOpen}
          onClose={() => setDetailOpen(false)}
          onDeleted={() => {
            setDetailOpen(false);
            setView({ kind: 'list' });
            setFlash({ tone: 'info', text: `已删除「${activeSource.title}」及其正文` });
            void refresh();
          }}
        />
      </>
    );
  }

  // ---- 列表视图 ----
  const hasSources = allSources.length > 0;
  /*
   * 空态只在「既没资料也没课程」时独占整块。
   *
   * 曾经写成只看「没资料」，结果刚建好的课程被空态盖掉，
   * 用户会以为课程没建成功 —— 这正是 core 保留下空课程要避免的误解。
   * 有课程时仍然渲染分组，空组自己会说「这门课还没有资料」。
   */
  const showEmptyState = !hasSources && courses.length === 0;

  return (
    <div className="page page__stack">
      <header className="page__head">
        <div className="page__head-main">
          <h2 className="page__title">资料库</h2>
          <p className="page__summary">
            把教材、课件、讲义放进来，按课程分组管理。导入后可以翻页阅读、搜索全文，
            搜索命中的地方能直接跳回原文 —— 这是后面出知识点、出题时「点回原文」的依据。
          </p>
        </div>
        <div className="page__head-side">
          <Badge tone="neutral">P1</Badge>
          <Badge tone="ready">可用</Badge>
        </div>
      </header>

      {flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null}

      <ImportPanel
        onImportFiles={handleImportFiles}
        onSaveText={handleSaveText}
        importing={importing}
        progress={progress}
        outcomes={outcomes}
        importError={importError}
        courseId={importCourseId}
        courses={courses}
        onCourseChange={setImportCourseId}
      />

      <section className="card">
        <div className="card__head">
          <div>
            <div className="card__title">课程</div>
            <div className="card__subtitle">
              课程只用来给资料分组。删课程不会删资料，资料会回到「未分类」。
            </div>
          </div>
        </div>
        <div className="card__body page__stack">
          {courses.length === 0 ? (
            <div className="page__muted">
              还没有课程。不建也能用 —— 所有资料会集中在「未分类」里。
            </div>
          ) : (
            <ul className="course-chips">
              {courses.map((course) => (
                <li key={course.id} className="course-chip">
                  {renamingId === course.id ? (
                    <>
                      <input
                        className="input"
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        aria-label={`重命名课程 ${course.name}`}
                        style={{ width: 160, minHeight: 28 }}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleRenameCourse(course);
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => void handleRenameCourse(course)}
                        disabled={courseBusy}
                      >
                        保存
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => setRenamingId(null)}
                        disabled={courseBusy}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="course-chip__name">{course.name}</span>
                      <span className="course-chip__count">
                        {groups.kind === 'ready'
                          ? groups.data.find((g) => g.course?.id === course.id)?.sources.length ?? 0
                          : 0}{' '}
                        份
                      </span>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => {
                          setRenamingId(course.id);
                          setRenameDraft(course.name);
                        }}
                        disabled={courseBusy}
                      >
                        改名
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => void handleRemoveCourse(course)}
                        disabled={courseBusy}
                      >
                        删除
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="course-create">
            <div className="field">
              <label className="field__label" htmlFor="course-name">
                新建课程
              </label>
              <input
                id="course-name"
                className="input"
                value={courseNameDraft}
                onChange={(e) => setCourseNameDraft(e.target.value)}
                placeholder="例如：数据结构与算法"
                maxLength={40}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreateCourse();
                }}
              />
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => void handleCreateCourse()}
              disabled={courseBusy || !courseNameDraft.trim()}
            >
              {courseBusy ? '处理中…' : '新建课程'}
            </button>
          </div>
        </div>
      </section>

      {showEmptyState ? (
        <section className="card">
          <EmptyState
            title="资料库还是空的"
            description={
              <>
                把课件、讲义、教材 PDF 拖到上面的导入区，或者点「粘贴文字」存一段笔记。
                导入后就能翻页阅读、全文搜索，搜索命中的地方可以跳回原文。
              </>
            }
            actions={
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  document.getElementById('sources-import')?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start',
                  });
                }}
              >
                去导入第一份资料
              </button>
            }
          />
        </section>
      ) : (
        <>
          {!hasSources ? (
            <Notice tone="info" title="还没有资料">
              课程已经建好了。把文件拖到上面的导入区，或在「归入课程」里选一门课再导入，
              资料就会出现在对应的分组下面。
            </Notice>
          ) : null}
          {groups.data.map((group) => (
            <CourseSection
              key={group.course?.id ?? '__unclassified__'}
              group={group}
              courses={courses}
              movingId={movingId}
              onOpen={(source) => setView({ kind: 'reader', sourceId: source.id })}
              onMove={(source, courseId) => void handleMoveSource(source, courseId)}
            />
          ))}
        </>
      )}
    </div>
  );
}

/**
 * 一个课程分组。
 *
 * 空课程也要渲染（后端会保留它们）：刚建完课程却看不到它，
 * 用户会以为没建成功。空组里给一句「还没资料」，并指回导入区。
 */
function CourseSection({
  group,
  courses,
  movingId,
  onOpen,
  onMove,
}: {
  group: CourseGroup;
  courses: Course[];
  movingId: string | null;
  onOpen: (source: Source) => void;
  onMove: (source: Source, courseId: string | null) => void;
}) {
  const isUnclassified = group.course === null;

  return (
    <section className="card course-group">
      <div className="course-group__head">
        <div className="course-group__name">
          <span>{isUnclassified ? '未分类' : group.course!.name}</span>
          <Badge tone="neutral">{group.sources.length} 份</Badge>
          {isUnclassified && group.sources.length > 0 ? (
            <span className="page__muted">导入时没选课程的资料都在这里</span>
          ) : null}
        </div>
      </div>

      {group.sources.length === 0 ? (
        <div className="card__body">
          <div className="page__muted">
            这门课还没有资料。在上面导入时选中它，或把已有资料的「课程」下拉改成它。
          </div>
        </div>
      ) : (
        <ul className="source-list">
          {group.sources.map((source) => {
            const status = TEXT_STATUS_LABEL[source.textStatus];
            return (
              <li key={source.id} className="source-item">
                <button
                  type="button"
                  className="source-item__main"
                  onClick={() => onOpen(source)}
                  title="打开阅读器"
                >
                  <span className="source-item__title">
                    <strong>{source.title}</strong>
                    <Badge tone="neutral">{kindLabel(source.kind)}</Badge>
                    {source.textStatus === 'no-text-layer' ? (
                      <Badge tone="planned">扫描件</Badge>
                    ) : null}
                  </span>
                  <span className="source-item__meta">
                    <span>{formatPageCount(source.pageCount)}</span>
                    <span className="source-item__sep">·</span>
                    <span>{source.segmentCount} 段</span>
                    <span className="source-item__sep">·</span>
                    <span>导入于 {formatTime(source.createdAt)}</span>
                    <span className="source-item__sep">·</span>
                    {/*
                      P1 阶段知识点/题目还没生成，这里恒为 0。
                      不编造数据，但位置先占住 —— 否则 P2 上线后列表会整体跳一下。
                    */}
                    <span className="gen-count gen-count--zero">已生成内容 0</span>
                    {source.textStatus === 'no-text-layer' ? (
                      <>
                        <span className="source-item__sep">·</span>
                        <span title={status.hint}>只能翻看，搜不出字</span>
                      </>
                    ) : null}
                  </span>
                </button>

                <div className="source-item__actions">
                  <label className="sr-only" htmlFor={`move-${source.id}`}>
                    把「{source.title}」换到其他课程
                  </label>
                  <select
                    id={`move-${source.id}`}
                    className="select"
                    value={source.courseId ?? ''}
                    disabled={movingId === source.id}
                    onChange={(e) => onMove(source, e.target.value === '' ? null : e.target.value)}
                  >
                    <option value="">未分类</option>
                    {courses.map((course) => (
                      <option key={course.id} value={course.id}>
                        {course.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => onOpen(source)}
                  >
                    阅读
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

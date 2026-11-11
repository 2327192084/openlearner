import { useCallback, useEffect, useRef, useState } from 'react';
import type { Source } from '@/core/model.ts';
import type { SourceService } from '@/core/sources.ts';
import {
  convertAndWriteBack,
  needsConversion,
  type ConversionReport,
} from '@/core/mineru/write-back.ts';
import { getMinerURunner, type MinerUProgress, type MinerURunner } from '@/core/mineru/runner.ts';
import type { MinerUResult } from '@/core/mineru/markdown.ts';
import { countFigures, importFigures } from '@/core/mineru/images.ts';
import { PageRangePicker, toPagesArg } from './PageRangePicker.tsx';
import type { ParseMode } from './PageRangePicker.tsx';

/**
 * 扫描件 / 图片文件的转换面板。
 *
 * ## 为什么它出现在「整理知识点」页
 *
 * 用户的真实路径是：导入一份扫描版教材 → 去整理知识点 → 发现没有正文。
 * 在此之前这里只说「这份资料没有可整理的正文（可能是扫描件）」，然后就没了 ——
 * 用户不知道下一步该干什么。
 *
 * 现在这里变成：说清这是扫描件 → 一个按钮用本机 MinerU 转成正文 →
 * 转完自动刷新，接着整理。
 *
 * ## 几条不能省的规矩
 *
 * 1. **不可用就明说为什么**，不摆一个点了才报错的按钮。
 * 2. **进度不许编**：MinerU 给了 x/y 就显示，没给就显示当前阶段文字。
 * 3. **转换是有损的**：OCR 一定会有错字，所以转完要如实说「已转 N 页，
 *    可能有识别错误，可点开原文逐页对照」—— 用户原话就是要「方便对照」。
 * 4. **空页要列出来**：整页插图转不出字，直接说哪几页是空的，
 *    别让用户翻到第 5 页发现一片空白还以为程序漏了。
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; progress: MinerUProgress | null }
  | { kind: 'done'; report: ConversionReport }
  | {
      kind: 'failed';
      message: string;
      hint: string;
      /**
       * 失败分类（2026-11-11）。
       *
       * 用来避免 message 与 hint 重复说同一件事 ——
       * `server-not-running` 的原因和建议本来就是一句话，两行都显示会重复。
       */
      trouble?: string;
    };

/**
 * 转换完成后，把正文里的插图取回来存进 sourceImages（2026-11-08）。
 *
 * 抽成独立函数而不是内联在 start 里，有三个理由：
 *  1. 它必须**不阻塞**「转换完成」的显示 —— 88 张图要几十秒
 *  2. 它的失败绝不能影响正文（正文已经落库了）
 *  3. 它自己要有如实的账（取到几张 / 失败几张），不能吞
 *
 * @returns 给界面看的一句话；没有图可取时返回 null
 */
async function backfillFigures(
  source: Source,
  sourceService: SourceService,
  result: MinerUResult,
  aliveRef: { current: boolean },
  setNote: (note: string | null) => void,
  onConverted: () => void,
): Promise<void> {
  const counts = countFigures(result.pages);
  if (counts.total === 0) {
    // 整本没切出图片块。不显示任何提示 —— 说「0 张图」只会让人疑惑。
    setNote(null);
    return;
  }

  const bridge = typeof window !== 'undefined' ? window.openleaner?.mineru : undefined;
  if (!bridge?.readFigure) {
    /*
     * 浏览器里没有 IPC。如实说明，不假装取过 ——
     * 下次在桌面版重转一次就会补上（图能重新取，因为按 bbox 裁）。
     */
    setNote(
      `这份资料有 ${counts.total} 张插图，但取图要在桌面版里跑。` +
        `这次只存了正文，在桌面版重新转换一次就能连图一起补上。`,
    );
    return;
  }

  setNote(`正文已就绪。正在取回 ${counts.total} 张插图…`);

  try {
    const report = await importFigures({
      storage: sourceService.figuresStorage,
      sourceId: source.id,
      pages: result.pages,
      fetcher: async (locator) => {
        const r = await bridge.readFigure(locator);
        if (!r.ok) return { ok: false, error: r.error };
        return {
          ok: true,
          figure: {
            dataUri: r.dataUri,
            width: r.width,
            height: r.height,
            byteSize: r.byteSize,
          },
        };
      },
      onProgress: (done, total) => {
        if (!aliveRef.current) return;
        setNote(`正在取回插图 ${done}/${total}…`);
      },
    });

    if (!aliveRef.current) return;

    /*
     * 汇报要**如实**：取到几张、几张没取到。
     * 不写成「插图已全部取回」—— 那会在真有失败时骗人。
     */
    if (report.failed === 0) {
      setNote(
        report.stored > 0
          ? `已取回 ${report.stored} 张插图，阅读器里会显示在原位置。`
          : null,
      );
    } else {
      const first = report.failures[0]?.error ?? '';
      setNote(
        `取回 ${report.stored} 张插图，${report.failed} 张没取到` +
          (first ? `（第一个失败原因：${first.slice(0, 80)}）` : '') +
          '。没取到的图不会显示，其余正常。',
      );
    }

    if (report.stored > 0) onConverted();
  } catch (err) {
    /*
     * 取图整体失败时**不回滚正文**，也不把 phase 改成 failed ——
     * 正文已经好用了，用户能读能整理，只是没有图。
     * 这里只把原因说出来。
     */
    if (!aliveRef.current) return;
    const msg = err instanceof Error ? err.message : String(err);
    setNote(`正文已就绪，但取插图时出错：${msg.slice(0, 120)}`);
  }
}

export interface ConvertPanelProps {
  source: Source;
  sourceService: SourceService;
  /** 转换成功后通知上层刷新分段等数据 */
  onConverted: () => void;
  /** 打开阅读器，跳转到某一页 —— 用户要「逐页对照」就要能直接点过去 */
  onOpenPage?: (page: number) => void;
  /** 注入 runner（测试用）；不传则取当前环境的真实实现 */
  runner?: MinerURunner;
}

export function ConvertPanel({
  source,
  sourceService,
  onConverted,
  onOpenPage,
  runner,
}: ConvertPanelProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  /**
   * 解析方式与页范围（2026-11-11）。
   *
   * 用户要求两种：完整解析（整份）/ 分片解析（指定起止页）。
   * 默认完整解析 —— 那是原有行为，不该因为加了选项而改变默认。
   */
  const [parseMode, setParseMode] = useState<ParseMode>('full');
  const [rangeStart, setRangeStart] = useState('1');
  /**
   * 结束页默认值（2026-11-11）。
   *
   * ⚠️ 不能只写 `useState(String(source.pageCount ?? ''))`：
   * 面板首次渲染时 `source.pageCount` 可能还是 null（元信息还没读回来），
   * 于是结束页被固化成空串，之后 pageCount 到了也不会更新 ——
   * 实测就出现了「结束页默认 2」这种明显不对的值。
   *
   * 所以：用 effect 在 pageCount 首次可用时补上，且**只补一次**
   * （用户已经手动改过就不覆盖他的输入）。
   */
  const [rangeEnd, setRangeEnd] = useState(String(source.pageCount ?? ''));
  const userTouchedEnd = useRef(false);
  /**
   * 取图的进度说明（2026-11-08）。
   *
   * 与 phase 分开：转换已经完成（phase=done）之后才轮到取图，
   * 两个阶段同时要显示，塞进同一个判别联合会很别扭。
   * null 表示「没有图要取」，不显示这条。
   */
  const [figureNote, setFigureNote] = useState<string | null>(null);
  const effectiveRunner = runner ?? getMinerURunner();
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /**
   * 页数到齐后补上结束页的默认值（2026-11-11）。
   *
   * ## 两个都要处理的时序问题
   *
   * 1. `source.pageCount` 是异步读回来的，首次渲染常常是 null。
   * 2. **用户在整理页切换资料时，本组件不会重新挂载**
   *    （OrganizePage 没有给 key），于是 `rangeEnd` 会保留上一份资料的值 ——
   *    实测：先选一份 2 页的资料，再切到 36 页那份，结束页还是 2。
   *
   * 所以这里按「上一份资料是谁」判断：换资料就重置结束页。
   * 同一份资料内，则只在值为空时补一次，不覆盖用户手输的数字。
   */
  const lastSourceId = useRef(source.id);
  useEffect(() => {
    const switched = lastSourceId.current !== source.id;
    if (switched) {
      lastSourceId.current = source.id;
      /* 换资料：结束页回到「整份」的默认，并清掉「用户动过」标记 */
      userTouchedEnd.current = false;
      setRangeStart('1');
      setRangeEnd(source.pageCount ? String(source.pageCount) : '');
      return;
    }
    if (userTouchedEnd.current) return;
    const total = source.pageCount;
    if (!total) return;
    setRangeEnd((prev) => (prev === '' ? String(total) : prev));
  }, [source.id, source.pageCount]);

  const start = useCallback(async () => {
    setPhase({ kind: 'running', progress: null });
    try {
      /*
       * 这里需要原文件的**绝对路径**。桌面版里资料是从文件导入的，
       * 真实路径由主进程通过导入流程记住（见 electron 的导入 handler）。
       * 拿不到路径时如实说清楚，不要让用户以为点了没反应。
       */
      /*
       * 拿原文件路径。登记表里没有就请用户当场指一次 ——
       * 升级前导入的资料没有记录，而重导一份 45MB 教材代价太大。
       */
      const absolutePath = await resolveSourcePath(source, async () => {
        const bridge = typeof window !== 'undefined' ? window.openleaner?.mineru : undefined;
        if (!bridge || typeof bridge.pickSourceFile !== 'function') return null;
        try {
          return await bridge.pickSourceFile(source.id, source.title);
        } catch {
          return null;
        }
      });
      if (!absolutePath) {
        setPhase({
          kind: 'failed',
          message: '拿不到这份资料的原文件路径。',
          hint:
            '桌面版会用导入时的原路径调用 MinerU。如果这份资料是很早以前导入的、' +
            '或原文件已经被移动/删除，请重新导入一次那份 PDF。',
        });
        return;
      }

      const result = await effectiveRunner.run(
        {
          filePath: absolutePath,
          /*
           * exePath 留空：主进程启动时已经探测到 mineru-kit 在哪，
           * 页面不需要（也不该）知道本机路径。主进程会用它探到的那个。
           */
          exePath: '',
          outDir: '',
          tier: 'standard',
          /* 页范围（2026-11-11）：完整解析传 'all'，分片传 '3-15' */
          pages: toPagesArg(parseMode, rangeStart, rangeEnd),
        },
        (p) => {
          if (aliveRef.current) setPhase({ kind: 'running', progress: p });
        },
      );

      const report = await convertAndWriteBack({ source, sourceService, result });
      if (!aliveRef.current) return;
      setPhase({ kind: 'done', report });
      onConverted();

      /*
       * 取图（2026-11-08）。
       *
       * ## 为什么放在正文写回**之后**、且不 await 到主流程里
       *
       * 正文已经落库、用户已经能读了 —— 这时再去取 88 张图要几十秒。
       * 把它挡在「转换完成」前面，用户会以为转换卡住了。
       * 所以先让界面进入 done，再在后台补图；补完自己刷新一次。
       *
       * ## 为什么必须现在取，不能等用户点开
       *
       * locator 依赖 MinerU 自己的解析缓存，缓存被清就永久取不到
       * （实测：删 parsed 目录后报 `Requested parsed content is not cached.`）。
       * 这一步是整个功能可靠性的关键，不是优化。
       */
      void backfillFigures(source, sourceService, result, aliveRef, setFigureNote, onConverted);
    } catch (err) {
      if (!aliveRef.current) return;
      const message = err instanceof Error ? err.message : '转换失败';
      const trouble = (err as Error & { trouble?: string }).trouble;
      setPhase({
        kind: 'failed',
        message,
        hint: hintForTrouble(trouble),
        ...(trouble ? { trouble } : {}),
      });
    }
  }, [source, sourceService, effectiveRunner, onConverted, parseMode, rangeStart, rangeEnd]);

  // 不需要转换的资料：不渲染这个面板（ready 的资料已经有正文）
  if (!needsConversion(source.textStatus, source.kind)) return null;

  const unavailable = !effectiveRunner.available;

  return (
    <div className="convert-panel">
      <p className="convert-panel__title">
        {source.textStatus === 'no-text-layer'
          ? '这是一份扫描件，没有文字层'
          : source.textStatus === 'decode-failed'
            ? '这份文件的文字取不出来'
            : '这是一张图片'}
      </p>
      <p className="convert-panel__hint">
        {source.textStatus === 'no-text-layer'
          ? '它的内容是一张张图片，所以没有正文可以整理，也没法把知识点定位到具体句子。这不是文件坏了。'
          : source.textStatus === 'decode-failed'
            ? '文件里是有文字的（有字体、有绘制指令），但我们的解析没取出来。这是我们这边的问题 —— 用下面的按钮再试一次。'
            : '图片本身没有文字层，需要先识别成文字才能整理成知识点。'}
      </p>
      <p className="convert-panel__hint">
        可以用本机装的 MinerU 把它转成带页码的正文，转完就能照常整理知识点，
        并且每条都能点回原文对应页。
      </p>

      {unavailable ? (
        <div className="convert-panel__unavailable">
          <p className="convert-panel__unavail-title">这台机器现在用不了 MinerU</p>
          <p className="convert-panel__hint">{effectiveRunner.unavailableReason}</p>
        </div>
      ) : phase.kind === 'idle' || phase.kind === 'running' ? (
        <div className="convert-panel__actions">
          {phase.kind === 'running' ? (
            <div className="convert-panel__progress">
              <div className="convert-panel__progress-top">
                <span className="convert-panel__phase">
                  {phase.progress?.phase ?? '正在启动 MinerU…'}
                </span>
                <span className="convert-panel__ratio">
                  {phase.progress?.detail ??
                    (phase.progress?.ratio !== null && phase.progress?.ratio !== undefined
                      ? `${Math.round(phase.progress.ratio * 100)}%`
                      : '')}
                </span>
              </div>
              {/*
               * 进度条只在拿到真实百分比时画。
               * 拿不到就留空 —— 画一条永远不动的假进度条比没有更糟，
               * 用户会盯着它等，而它其实不知道自己在哪。
               */}
              {phase.progress?.ratio !== null && phase.progress?.ratio !== undefined ? (
                <div className="convert-panel__bar" role="progressbar" aria-valuenow={Math.round(phase.progress.ratio * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <div
                    className="convert-panel__bar-fill"
                    style={{ width: `${Math.round(phase.progress.ratio * 100)}%` }}
                  />
                </div>
              ) : null}
              <p className="convert-panel__note">
                整本大书要几十分钟。进度是 MinerU 当前阶段的进度（比如「文字识别 112/252」），
                不是整本的百分比 —— 阶段会往下走，说明它在干活。
              </p>
            </div>
          ) : (
            <>
              {/*
                解析方式（2026-11-11）。
                完整解析 = 整份；分片解析 = 指定起止页。
                只在 idle 状态显示 —— 跑起来之后改它没有意义。
              */}
              <PageRangePicker
                mode={parseMode}
                onModeChange={setParseMode}
                start={rangeStart}
                onStartChange={setRangeStart}
                end={rangeEnd}
                onEndChange={(v) => {
                  /* 记下「用户动过」，避免 pageCount 到位后覆盖他填的数 */
                  userTouchedEnd.current = true;
                  setRangeEnd(v);
                }}
                pageCount={source.pageCount}
              />

              <button
                type="button"
                className="btn-fill btn-fill--sm"
                onClick={() => void start()}
              >
                {parseMode === 'full' ? '用本机 MinerU 转成正文' : '解析这几页'}
              </button>
              <p className="convert-panel__note">
                {parseMode === 'full'
                  ? '首次运行可能要下载识别模型，会有一段时间没有反应 —— 那是正常的，不是卡死了。整本大书可能要几十分钟。'
                  : '只解析指定的页范围，通常几十秒就好。适合先看某一章。'}
              </p>
            </>
          )}
        </div>
      ) : null}

      {phase.kind === 'done' ? (
        <div className="convert-panel__done">
          <p className="convert-panel__done-title">
            已转好 {phase.report.pagesWithText} / {phase.report.pageCount} 页，共{' '}
            {phase.report.segmentCount} 段
            {/*
              分片解析时补一句「这次只写了几页」，2026-11-11。
              合并模式下 segmentCount 是库里总数，不说明会让人以为整本都被重写了。
            */}
            {phase.report.writtenPageCount !== undefined &&
            phase.report.writtenPageCount !== phase.report.segmentCount
              ? `（这次写入 ${phase.report.writtenPageCount} 页，其余页保持原样）`
              : ''}
          </p>
          <p className="convert-panel__hint">
            页码与原书一一对应，可以逐页对照检查。识别难免有错字，
            发现哪页不对就点开原文看看。
          </p>
          {phase.report.emptyPages.length > 0 ? (
            <p className="convert-panel__warn">
              这几页没有识别出文字（整页插图或扉页）：
              {phase.report.emptyPages.slice(0, 20).join('、')}
              {phase.report.emptyPages.length > 20 ? ' …' : ''}
            </p>
          ) : null}
          <p className="convert-panel__meta">
            档位 {phase.report.tier}
            {phase.report.producer !== 'unknown' ? ` · MinerU ${phase.report.producer}` : ''}
          </p>
          {/*
            取图进度 / 结果（2026-11-08）。
            单独一行放在「转换完成」块里：正文已经可用，取图是后续的补充动作。
            如实显示成功与失败张数 —— 不写成「已全部取回」。
          */}
          {figureNote ? <p className="convert-panel__hint">{figureNote}</p> : null}
          {onOpenPage ? (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => onOpenPage(1)}
            >
              打开原文逐页对照
            </button>
          ) : null}
        </div>
      ) : null}

      {phase.kind === 'failed' ? (
        <div className="convert-panel__failed">
          {/*
            message 与 hint 的分工（2026-11-11 晚修重叠）。

            这两行来自两个地方：
              - message：主进程报上来的**具体情况**（含 MinerU 的原因）
              - hint：前端按 trouble 给的**下一步做什么**

            对 `server-not-running` 这种「原因和做法是同一件事」的情况，
            两边会说出几乎一样的两段话 —— 实测界面上出现了重复。
            所以这一类只显示 hint（它更完整、给了两步操作），
            其余情况仍然两行都显示（原因 + 做法）。
          */}
          {phase.trouble === 'server-not-running' ? null : (
            <p className="convert-panel__failed-msg">{phase.message}</p>
          )}
          <p className="convert-panel__hint">{phase.hint}</p>
          <button type="button" className="btn-ghost" onClick={() => setPhase({ kind: 'idle' })}>
            重试
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 把 trouble 分类翻成「下一步做什么」。不写「出错了，请重试」这种废话。 */
function hintForTrouble(trouble?: string): string {
  switch (trouble) {
    case 'not-installed':
      return '没找到 MinerU。装好之后重启应用，或在设置里填 mineru-kit.exe 的路径。';
    case 'broken':
      return 'MinerU 装了但跑不起来 —— 多半是它的 Python 环境坏了。到 MinerU 目录里重新激活一次环境试试。';
    case 'server-not-running':
      /*
       * 2026-11-11 实测最常见的一类。
       * 服务默认不开机自启，用户第一次用几乎一定撞上。
       * 提示要给出**能照做的两步**，而不是一句「服务没运行」。
       */
      return 'MinerU 的本地服务没在跑。在命令行执行 mineru server start，看到 “Server started” 后回来再点一次 —— 启动后它会一直常驻，下次不用再启。';
    case 'run-failed':
      return 'MinerU 处理这份文件时出错。常见原因：文件损坏、加密 PDF、页数超出限制。换一份文件试试能区分是哪一种。';
    case 'bad-output':
      return 'MinerU 说成功了，但输出读不懂 —— 可能是版本不匹配。请确认装的是 MinerU 4.x。';
    case 'aborted':
      return '转换被取消了。已经转好的部分没有写回，可以重新开始。';
    case 'missing-file':
      return '原文件找不到了。可能被移动或删除，需要重新导入那份 PDF。';
    default:
      return '再试一次；如果一直失败，看看 MinerU 那边的日志。';
  }
}

/**
 * 取资料原文件的绝对路径。
 *
 * ## 两条路
 *
 * 1. **查主进程的登记表**：导入时记下的 `sourceId → 路径`。
 *    只在「导入那一刻」拿得到 File 的路径，过了就没了（浏览器安全设计）。
 * 2. **让用户当场选一次原文件**：兜底。
 *
 * 为什么必须有第 2 条（2026-11-07 用户实测暴露的）：
 * 路径登记是后加的功能，**升级前导入的资料一条记录都没有**，
 * 于是点转换只会看到「拿不到原文件路径」，而一份 45MB 的扫描教材
 * 让他「重新导入一次」代价太大 —— 还会丢掉已有的知识点与题目引用。
 * 让他指一次原文件，比逼他重导合理得多。
 *
 * 拿不到时返回 null，由调用方如实告知，不猜一个路径去调用。
 */
async function resolveSourcePath(
  source: Source,
  pickFile: () => Promise<string | null>,
): Promise<string | null> {
  const bridge = typeof window !== 'undefined' ? window.openleaner : undefined;
  const lookup = (bridge as unknown as {
    sourcePath?: (id: string) => Promise<string | null>;
  } | undefined)?.sourcePath;

  if (typeof lookup === 'function') {
    try {
      const remembered = await lookup(source.id);
      if (remembered) return remembered;
    } catch {
      /* 落到下面的手动选择 */
    }
  }

  // 登记表里没有（升级前导入的、或原文件被移动/删除）→ 请用户指一次
  return await pickFile();
}

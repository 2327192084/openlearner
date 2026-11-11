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
import { PageRangePicker, toPagesArg, validatePageRange } from './PageRangePicker.tsx';
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
  /**
   * 即使资料已经有正文也显示面板（2026-11-11）。
   *
   * 「解析」独立成页时用这个：用户解析了 2 页之后想接着解析第 3-10 页，
   * 此时 textStatus 已是 ready，老的判断会让面板整个消失、没有入口。
   *
   * 默认 false —— 整理页里保持老行为（只在需要补正文时出现），
   * 那边由 OrganizePage 自己给一句「去解析页继续」的提醒。
   */
  alwaysShow?: boolean;
}

export function ConvertPanel({
  source,
  sourceService,
  onConverted,
  onOpenPage,
  runner,
  alwaysShow = false,
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
    /*
     * 提交前先拦一次（2026-11-11 实测 bug）。
     *
     * 页范围超出资料实际页数时，界面原来只显示一行红字提示、
     * **但仍然允许点解析**。实测后果：一份 2 页的资料被填了 3-4 页，
     * 解析完成后那份资料变成 36 段 —— 前两页被清空，
     * 3-4 页塞的是另一个文件的内容。
     *
     * 所以这里硬拦：说不通就不发请求，并把原因写进 failed 状态。
     */
    const rangeProblem = validatePageRange(parseMode, rangeStart, rangeEnd, source.pageCount);
    if (rangeProblem) {
      /*
       * 用 failed 状态但 trouble='invalid-range'，
       * 渲染时**保留输入区**（见下面的分支判断）——
       * 用户要改的就是那两个数字，把输入框藏起来等于让他点「重试」再重来一遍。
       */
      setPhase({
        kind: 'failed',
        message: rangeProblem,
        hint: '改一下上面的页范围再解析。整份解析不需要填页码。',
        trouble: 'invalid-range',
      });
      return;
    }

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

  /*
   * 什么时候不再渲染这个面板（2026-11-11 改）。
   *
   * ## 原来的判断漏了一种情况
   *
   * 原来只要 `needsConversion()` 为 false（即 textStatus 已是 ready）
   * 就整个不渲染。但分片解析之后 textStatus 正是 ready ——
   * 用户解析了 2 页，想接着解析第 3-10 页时，**面板消失了，没有入口**。
   * 这是我在做「分片合并」时留下的连带问题（合并让分片有意义了，
   * 但入口没跟着留）。
   *
   * ## 现在的判断
   *
   * 用 `alwaysShow` 让宿主（解析页）永远挂这个面板；
   * 不传时保持老行为（整理页里只在需要补正文时出现）。
   */
  if (!alwaysShow && !needsConversion(source.textStatus, source.kind)) return null;

  const unavailable = !effectiveRunner.available;
  /**
   * 资料已经有正文了（2026-11-11）。
   *
   * 这时面板的语义变了：不是「补正文」，而是「继续解析其它页」。
   * 标题与说明都要换一套说法 —— 否则用户会看到
   * 「这是一份扫描件，没有文字层」而困惑（明明有正文）。
   */
  const hasText = !needsConversion(source.textStatus, source.kind);

  return (
    <div className="convert-panel">
      {hasText ? (
        <>
          <p className="convert-panel__title">继续解析其它页</p>
          <p className="convert-panel__hint">
            这份资料已经有正文了（{source.segmentCount ?? 0} 段
            {source.pageCount ? ` / 共 ${source.pageCount} 页` : ''}）。
            想解析还没解析的页，用下面的「分片解析」再跑一次 ——
            新解析的页会合并进来，已解析的页不会丢。
          </p>
        </>
      ) : (
        <>
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
        </>
      )}
      {/* 「有正文」时这句不适用 —— 它说的是「先把正文弄出来」 */}
      {hasText ? null : (
        <p className="convert-panel__hint">
          可以用本机装的 MinerU 把它转成带页码的正文，转完就能照常整理知识点，
          并且每条都能点回原文对应页。
        </p>
      )}

      {unavailable ? (
        <div className="convert-panel__unavailable">
          <p className="convert-panel__unavail-title">这台机器现在用不了 MinerU</p>
          <p className="convert-panel__hint">{effectiveRunner.unavailableReason}</p>
        </div>
      ) : phase.kind === 'idle' ||
        phase.kind === 'running' ||
        /*
         * 页范围被拦下时也要**保留输入区**（2026-11-11）。
         *
         * 用户要改的就是那两个数字；如果把输入框藏起来、只留一句红字
         * 和「重试」，他得先点重试回到 idle 才能改 —— 多一步且反直觉。
         */
        (phase.kind === 'failed' && phase.trouble === 'invalid-range') ? (
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
                {/*
                  按钮文案要看语境（2026-11-11）。
                  已有正文时「转成正文」是错的 —— 那是第一次解析的说法；
                  这时用户是在「接着解析更多页」。
                */}
                {parseMode === 'full'
                  ? (hasText ? '重新解析整本' : '用本机 MinerU 转成正文')
                  : '解析这几页'}
              </button>
              <p className="convert-panel__note">
                {parseMode === 'full'
                  ? (hasText
                      ? '会把整本重新解析一遍，覆盖已有正文（通常只有识别质量不满意时才需要）。整本大书可能要几十分钟。'
                      : '首次运行可能要下载识别模型，会有一段时间没有反应 —— 那是正常的，不是卡死了。整本大书可能要几十分钟。')
                  : '只解析指定的页范围，通常几十秒就好。适合先看某一章，或分批把整本凑齐。'}
              </p>

              {/*
                页范围被拦时不在这里重复红字（2026-11-11）。
                `PageRangePicker` 已经在那两个输入框旁边显示了同一句话 ——
                就在用户要改的地方。这里再写一遍会变成三处重复
                （选择器内联 + 这里 + 下面的失败块），实测截图里很啰嗦。
              */}
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
          {/*
            「继续解析」按钮（2026-11-11）。
            
            之前解析完成后 phase 是 done，面板里只剩一句结果文字 ——
            想接着解析下一段就得先点「重试」回到 idle，而那个按钮
            只在失败态出现。用户在这里没有任何可点的东西。
            
            分片解析的用法本来就是「一段一段来」，所以这里必须给入口。
          */}
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setPhase({ kind: 'idle' });
              setFigureNote(null);
            }}
          >
            继续解析其它页
          </button>
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

      {/*
        页范围不合法时不渲染失败块（2026-11-11）。
        输入区还开着，红字就在那两个输入框旁边 —— 那才是用户要改的地方。
        再给一个「重试」按钮反而误导（他会以为要重试才有用）。
      */}
      {phase.kind === 'failed' && phase.trouble !== 'invalid-range' ? (
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
       *
       * ⚠️ 现在程序会**自动启动服务并重试**（见 main.cjs），
       * 用户正常不会看到这一条。它还留着是因为主进程那次自动启动
       * 也可能被绕过（比如旧版本主进程），那时至少给个说明。
       * 措辞也改了：不再要求用户敲命令 —— 那是我们该做的事。
       */
      return 'MinerU 的本地服务没启动。程序会尝试自动启动它；如果一直不行，到设置的「文档解析」里检查 MinerU 状态。';
    case 'server-start-failed':
      /*
       * 自动启动也失败了。这时**不能**再让用户敲命令 ——
       * 那说明问题比「服务没开」更深（环境坏了 / 装得不完整）。
       * 指向设置页，那里有完整的状态与安装说明。
       */
      return '程序没能把 MinerU 的服务启动起来。这通常不是操作问题，而是 MinerU 本体装得不完整 —— 到设置的「文档解析」里能看到具体状态和安装说明。';
    case 'server-started-still-failing':
      return '服务已经起来了，但它一启动就退出。多半是模型没下载完整，到设置的「文档解析」里查看，或重新跑一次模型下载。';
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

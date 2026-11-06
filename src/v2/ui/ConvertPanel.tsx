import { useCallback, useEffect, useRef, useState } from 'react';
import type { Source } from '@/core/model.ts';
import type { SourceService } from '@/core/sources.ts';
import {
  convertAndWriteBack,
  needsConversion,
  type ConversionReport,
} from '@/core/mineru/write-back.ts';
import { getMinerURunner, type MinerUProgress, type MinerURunner } from '@/core/mineru/runner.ts';

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
  | { kind: 'failed'; message: string; hint: string };

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
  const effectiveRunner = runner ?? getMinerURunner();
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const start = useCallback(async () => {
    setPhase({ kind: 'running', progress: null });
    try {
      /*
       * 这里需要原文件的**绝对路径**。桌面版里资料是从文件导入的，
       * 真实路径由主进程通过导入流程记住（见 electron 的导入 handler）。
       * 拿不到路径时如实说清楚，不要让用户以为点了没反应。
       */
      const absolutePath = await resolveSourcePath(source, sourceService);
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
        },
        (p) => {
          if (aliveRef.current) setPhase({ kind: 'running', progress: p });
        },
      );

      const report = await convertAndWriteBack({ source, sourceService, result });
      if (!aliveRef.current) return;
      setPhase({ kind: 'done', report });
      onConverted();
    } catch (err) {
      if (!aliveRef.current) return;
      const message = err instanceof Error ? err.message : '转换失败';
      const trouble = (err as Error & { trouble?: string }).trouble;
      setPhase({ kind: 'failed', message, hint: hintForTrouble(trouble) });
    }
  }, [source, sourceService, effectiveRunner, onConverted]);

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
              <span className="convert-panel__phase">
                {phase.progress?.phase ?? '正在启动 MinerU…'}
              </span>
              {phase.progress?.ratio !== null && phase.progress?.ratio !== undefined ? (
                <span className="convert-panel__ratio">
                  {Math.round(phase.progress.ratio * 100)}%
                  {phase.progress.detail ? ` · ${phase.progress.detail}` : ''}
                </span>
              ) : phase.progress?.detail ? (
                <span className="convert-panel__ratio">{phase.progress.detail}</span>
              ) : null}
            </div>
          ) : (
            <>
              <button
                type="button"
                className="btn-fill btn-fill--sm"
                onClick={() => void start()}
              >
                用本机 MinerU 转成正文
              </button>
              <p className="convert-panel__note">
                首次运行可能要下载识别模型，会有一段时间没有反应 —— 那是正常的，
                不是卡死了。整本大书可能要几十分钟。
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
            {phase.report.parseMode === 'ocr' ? ' · 走了 OCR' : ' · 原生文字层'}
            {phase.report.producer !== 'unknown' ? ` · MinerU ${phase.report.producer}` : ''}
          </p>
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
          <p className="convert-panel__failed-msg">{phase.message}</p>
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
 * 为什么需要单独一步：`Source` 里只有 `fileName`（文件名），没有绝对路径 ——
 * 那是刻意的（浏览器环境根本没有路径概念）。桌面版在导入时会把真实路径
 * 记在主进程侧，这里通过 preload 取。
 *
 * 拿不到时返回 null，由调用方如实告知用户，不猜一个路径去调用。
 */
async function resolveSourcePath(
  source: Source,
  _sourceService: SourceService,
): Promise<string | null> {
  const bridge = typeof window !== 'undefined' ? window.openleaner : undefined;
  const lookup = (bridge as unknown as {
    sourcePath?: (id: string) => Promise<string | null>;
  } | undefined)?.sourcePath;

  if (typeof lookup === 'function') {
    try {
      return await lookup(source.id);
    } catch {
      return null;
    }
  }
  return null;
}

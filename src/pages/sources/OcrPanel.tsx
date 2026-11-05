import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Source } from '@/core/model.ts';
import type { SourceService } from '@/core/sources.ts';
import { Notice } from '@/components/states.tsx';
import {
  OcrService,
  checkOcrReadiness,
  pickVisionBackends,
  ModelVisionBackend,
} from '@/core/ocr/index.ts';
import type { OcrProgress } from '@/core/ocr/index.ts';
import type { BackendService, BackendView } from '@/core/backends.ts';
import { findPreset } from '@/core/ai/presets.ts';
import { describeError } from './types.ts';

/**
 * 「看图识公式」的实际入口。
 *
 * ## 为什么这个组件必须存在
 *
 * `src/core/ocr/` 里的三件套（VisionBackend / ModelVisionBackend /
 * OcrService）早就写好了，39 项测试在验它 —— 但**没有任何界面调用它**。
 * 用户勾上设置页那个「看图识公式」勾选框，扫描件依然只能翻看，
 * 而且看不出为什么。
 *
 * 这个组件就是把那条链路接上：勾选框 → 选到带 visionFormula 的后端 →
 * 这里逐页识别 → 分段里有了字 → 搜索、整理知识点、生成 PPT 才能用。
 *
 * ## 为什么要先做前置检查
 *
 * OCR 是**按页计费**的。让用户在没有原始文件、或后端根本不支持看图
 * 的情况下跑一遍，花掉的钱换不回任何东西。所以入口点之前先把条件
 * 讲清楚，而不是点了才报错。
 */
export function OcrPanel({
  source,
  sources,
  backends,
  onDone,
}: {
  source: Source;
  sources: SourceService;
  backends: BackendService;
  /** 识别成功、资料状态变了之后通知上层刷新 */
  onDone: () => void;
}) {
  const [visionBackends, setVisionBackends] = useState<BackendView[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [result, setResult] = useState<{
    succeeded: number;
    failed: number;
    tokens: number;
    stopped: boolean;
    failures: { pageNo: number; message: string; hint: string }[];
  } | null>(null);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);

  /** 停止信号：OCR 按页计费，用户随时该能停 */
  const abortRef = useRef<AbortController | null>(null);

  const refreshBackends = useCallback(async () => {
    try {
      const all = await backends.list();
      const usable = pickVisionBackends(all);
      setVisionBackends(usable);
      setSelectedId((prev) => {
        if (prev && usable.some((b) => b.id === prev)) return prev;
        return usable[0]?.id ?? '';
      });
    } catch {
      setVisionBackends([]);
    }
  }, [backends]);

  useEffect(() => {
    void refreshBackends();
  }, [refreshBackends]);

  const selected = useMemo(
    () => (visionBackends ?? []).find((b) => b.id === selectedId) ?? null,
    [visionBackends, selectedId],
  );

  /**
   * 前置条件。
   *
   * `pickVisionBackends` 已经把「勾了看图 + 有凭据 + 状态就绪」筛过一遍，
   * 这里再叠一层 checkOcrReadiness 判断资料本身（是不是 PDF、原始文件在不在）。
   */
  const precheck = useMemo(
    () => checkOcrReadiness(source, selected ? { provider: selected.provider } : null),
    [source, selected],
  );

  const start = async (pages?: number[]) => {
    if (running || !selected) return;
    if (!precheck.ok) return;

    setRunning(true);
    setError(null);
    setResult(null);
    setProgress(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const apiKey = await backends.readCredential(selected.id);
      if (!apiKey) {
        throw new Error('读不到这个后端的 API Key。请到设置页重新填一次并保存，然后回来重试。');
      }

      const preset = findPreset(selected.provider);
      const vision = new ModelVisionBackend({
        apiKey,
        provider: selected.provider,
        model: selected.model || preset?.defaultModel || '',
        ...(selected.baseUrl ? { baseUrl: selected.baseUrl } : {}),
      });

      const service = new OcrService({
        sources,
        vision,
        onProgress: setProgress,
      });

      const outcome = await service.run(source.id, {
        signal: controller.signal,
        ...(pages ? { pages } : {}),
      });

      if (!outcome) {
        throw new Error('这份资料已经不存在了，可能在另一个窗口被删除。');
      }

      setResult({
        succeeded: outcome.succeeded,
        failed: outcome.failures.length,
        tokens: outcome.tokens,
        stopped: outcome.stopped,
        failures: outcome.failures.map((f) => ({
          pageNo: f.pageNo,
          message: f.message,
          hint: f.hint,
        })),
      });

      // 状态变了（可能从 no-text-layer 变成 ready），让上层刷新
      onDone();
    } catch (err) {
      setError({
        message: describeError(err),
        hint:
          (err as { hint?: string })?.hint ??
          '识别没有完成。已经识别出来的页会保留；可以只重试失败的那几页。',
      });
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  // ── 没装/没配好心看后端：说清怎么办 ──────────────────────
  if (visionBackends !== null && visionBackends.length === 0) {
    return (
      <Notice tone="warning" title="没有可用的看图后端">
        要让扫描件变成能搜索、能出题的文字，需要一个能看图的模型：
        <ol style={{ margin: '6px 0 0 18px' }}>
          <li>到「设置」页添加一个后端，模型名填多模态模型（如智谱 glm-4v、通义 qwen-vl-max、OpenAI gpt-4o）。</li>
          <li>在那个后端的「这个后端支持的能力」里勾上<strong>「看图识公式」</strong>。</li>
          <li>回到这一页，就能选它来识别了。</li>
        </ol>
      </Notice>
    );
  }

  return (
    <div className="page__stack">
      <div className="page__row">
        <label className="field__label" htmlFor="ocr-backend">
          用哪个后端识别
        </label>
        <select
          id="ocr-backend"
          className="select"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          disabled={running}
        >
          {(visionBackends ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}（{b.model || '未填模型'}）
            </option>
          ))}
        </select>
      </div>

      <div className="field__hint">
        识别是<strong>按页计费</strong>的：一本 600 页的教材成本不低。
        建议先点「只识别第 1 页」看看效果，满意再跑整本。
      </div>

      {!precheck.ok ? (
        <Notice tone="warning" title={precheck.reason ?? '现在还不能识别'}>
          {precheck.hint}
        </Notice>
      ) : null}

      {error ? (
        <Notice tone="danger" title="这次识别没有完成">
          {error.message}
          <br />
          <strong>下一步：</strong>
          {error.hint}
        </Notice>
      ) : null}

      {running && progress ? (
        <div className="field__hint">
          正在识别第 {progress.currentPage} 页 · 已完成 {progress.done}/{progress.total}
          {progress.failed > 0 ? ` · 失败 ${progress.failed}` : ''}
          {progress.tokens > 0 ? ` · 已用 ${progress.tokens} token` : ''}
        </div>
      ) : null}

      {running && !progress ? <div className="field__hint">正在准备（渲染第一页）…</div> : null}

      {result ? (
        <Notice
          tone={result.failed > 0 ? 'warning' : 'info'}
          title={result.stopped ? '已停止（已识别的页保留）' : '识别完成'}
        >
          成功 {result.succeeded} 页
          {result.failed > 0 ? `，失败 ${result.failed} 页` : ''}
          {result.tokens > 0 ? `，用了 ${result.tokens} token` : ''}。
          {result.succeeded > 0 ? (
            <>
              <br />
              现在可以在这份资料里搜索、整理知识点、生成 PPT 了。
            </>
          ) : null}
          {result.failures.length > 0 ? (
            <details style={{ marginTop: 6 }}>
              <summary className="page__muted">查看失败的页</summary>
              <ul>
                {result.failures.slice(0, 20).map((f) => (
                  <li key={f.pageNo}>
                    第 {f.pageNo} 页：{f.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Notice>
      ) : null}

      <div className="page__row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {running ? (
          <button type="button" className="btn btn--ghost" onClick={stop}>
            停止（已识别的页会保留）
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void start([1])}
              disabled={!precheck.ok || !selected}
              title="先跑一页看效果，只花一页的钱"
            >
              只识别第 1 页（先试效果）
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void start()}
              disabled={!precheck.ok || !selected}
            >
              识别整篇
            </button>
          </>
        )}
      </div>

      <div className="field__hint">
        识别结果会替换这份资料的分段正文。原来那份是空的（扫描件没有文字层），
        所以不会丢内容。
      </div>
    </div>
  );
}

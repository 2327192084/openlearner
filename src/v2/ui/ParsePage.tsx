/**
 * 文档解析页（2026-11-11）。
 *
 * ## 为什么单独一页
 *
 * 用户反馈：「我刚刚对一份资料解析了两页，后续想要继续解析时没有入口了。
 * 这个解析应该单独做一个入口，但是整理知识点的这个入口也不用删，
 * 可以提醒用户进行解析。」
 *
 * 根因是 `ConvertPanel` 原来只在 `needsConversion()` 为真时渲染 ——
 * 解析 2 页之后 textStatus 变成 ready，面板整个消失，没有入口继续解析。
 * 而我在上一轮刚把分片解析改成「合并」，正是为了支持「分几次凑齐整本」——
 * 结果入口没了，这个能力等于用不上。
 *
 * ## 与「整理知识点」的分工
 *
 * 两页都保留，职责不同：
 *  - 本页：只管「把 PDF/图片变成正文」这件事
 *  - 整理页：只管「把正文变成知识点」
 *
 * 整理页仍会在需要补正文时内嵌一块解析面板（不打断流程），
 * 但同时给一句「也可以到『文档解析』页慢慢解析」的提醒，
 * 让用户知道有更合适的入口。这比把两件事塞进一页清楚。
 *
 * ## 为什么单独一个文件
 *
 * `App.tsx` 已 1900+ 行（硬约束 5：新增 UI 一律独立文件）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Source } from '@/core/model.ts';
import type { SourceService } from '@/core/sources.ts';
import { needsConversion } from '@/core/mineru/convert.ts';
import { disambiguateTitles, formatImportedAt } from '@/core/source-title.ts';
import { ConvertPanel } from './ConvertPanel.tsx';
import { EnginePicker } from './EnginePicker.tsx';
import { defaultEngine, engineLabel, reconcileEngine, type MinerUEngine } from './engine-choice.ts';
import type { MinerURunner } from '@/core/mineru/runner.ts';
import { EmptyCard } from './EmptyCard.tsx';
import { IconSources } from './icons.tsx';
import './parse-page.css';

export interface ParsePageProps {
  sourceService: SourceService;
  /** 进来时默认选中的资料（从资料页跳来时用） */
  initialSourceId?: string | null;
  /** 去看这份资料的原文 */
  onOpenReader?: (sourceId: string) => void;
  /** 去「整理知识点」页 */
  onOpenOrganize?: (sourceId: string) => void;
  /**
   * 云端 OCR 那条路是否可用（2026-11-15，用户要求）。
   *
   * 不可用时选择器上会显示原因并禁用 —— 不做「点了才报错」的假开关。
   * 不传 = 这个环境没有云 OCR（网页版/没配后端），选择器只显示本地那条。
   */
  cloudOcr?: {
    available: boolean;
    reason?: string | null;
    /** 建 runner：传进来的资料 id → 可运行的 MinerURunner */
    makeRunner: (sourceId: string) => Promise<{ runner: import('@/core/mineru/runner.ts').MinerURunner } | { error: string }>;
  };
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; sources: Source[] };

export function ParsePage({
  sourceService,
  initialSourceId,
  onOpenReader,
  onOpenOrganize,
  cloudOcr,
}: ParsePageProps) {
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [picked, setPicked] = useState<string | null>(initialSourceId ?? null);
  /**
   * 用哪个引擎解析（2026-11-15）。
   *
   * 规则住在 engine-choice.ts（有单测）：默认本地（原有行为、免费），
   * 本地不可用且云端可用才切云端。云端挂了自动切回本地 ——
   * 不把用户留在一个点不了的选项上。
   */
  /*
   * 初值用 defaultEngine：本地可用就本地（原有行为），
   * 本地不可用且云端可用才云 —— 与补救逻辑同一份规则，不各写一遍。
   */
  const [engine, setEngine] = useState<MinerUEngine>(() =>
    defaultEngine({ localOk: true, cloudOk: Boolean(cloudOcr?.available) }),
  );
  /** 云端 runner（按资料懒建；null = 还没建/建失败） */
  const [cloudRunner, setCloudRunner] = useState<MinerURunner | null>(null);
  const [cloudErr, setCloudErr] = useState<string | null>(null);

  /**
   * 云端 runner 的构造器（2026-11-16 抽出来做稳定依赖）。
   *
   * ## 为什么不能直接依赖 `cloudOcr`
   *
   * `cloudOcr` 是 App.tsx 里**内联的对象字面量** —— 每次渲染都是新引用。
   * 下面那个建 runner 的 effect 若把 `cloudOcr` 放进依赖数组，
   * 就会「每次渲染都重跑」：先把 `cloudRunner` 置 null、再异步重建。
   * 而重建是异步的，界面在那一瞬间又会回落成「本机 MinerU」的样子 ——
   * 实测现象：radio 明明切到了「DeepSeek 云 OCR」（`.engine-opt--on`
   * 也在云那条上），按钮却始终写着「用本机 MinerU 转成正文」，
   * 而且这个按钮一直点不动云 OCR 那条路。
   *
   * 这正是交接文档里记过的「对象字面量进依赖数组」同一个坑
   * （`usePageTask` 那次也是它）。修法同样：只依赖**原始值或稳定函数**。
   *
   * ## 这里用的是 useMemo 而不是 useRef
   *
   * `useRef` 兜底虽然能防住「对象换了但函数没换」，但拿不到
   * 「函数真的换了」这个信号（比如用户换了后端，构造逻辑跟着变）。
   * `useMemo` 依赖 `cloudOcr.makeRunner` 这个**函数引用本身**：
   *  - 内联字面量每次重建 → 但里面的箭头函数如果每次也是新的，它还是会变
   *  - 所以真正的稳定点在 App.tsx 那边用 useCallback 包住（已一起改）
   *
   * 两处都做：App 侧给稳定引用，这里再做一层「只有函数真的换了才重建」，
   * 任何一侧单独失效都不会退回到「永远建不起来」。
   */
  const makeRunner = cloudOcr?.makeRunner;
  const stableMakeRunner = useMemo(() => makeRunner, [makeRunner]);
  const cloudAvailable = Boolean(cloudOcr?.available);

  /**
   * 云端那条路现在能不能用。
   *
   * 只在「有 cloudOcr 且它说可用」时为真 —— 网页版或没配后端时是 false，
   * 选择器上会显示原因并禁用。
   */
  const cloudOk = cloudAvailable;

  /**
   * 纠正失效的选择（2026-11-15）。
   *
   * 典型场景：用户选了云端，然后去设置里删了后端，再回来 ——
   * 选择器不该还停在云端并且可点（那会点了才报错）。
   * 规则在 engine-choice.ts 里，有单测。
   */
  useEffect(() => {
    const next = reconcileEngine(engine, {
      localOk: true,
      cloudOk,
      ...(cloudOcr?.reason ? { cloudReason: cloudOcr.reason } : {}),
    });
    if (next.changed) setEngine(next.engine);
  }, [engine, cloudOk, cloudOcr?.reason]);

  /**
   * 切到云端时懒建 runner。
   *
   * 只在那份资料被选中时才建 —— 建它要读后端凭据、要读原文件，
   * 一进页面就为所有资料建一遍是白花钱。
   */
  useEffect(() => {
    if (engine !== 'deepseek' || !picked || !stableMakeRunner) return;
    let cancelled = false;
    setCloudErr(null);
    setCloudRunner(null);

    void (async () => {
      try {
        const r = await stableMakeRunner(picked);
        if (cancelled) return;
        if ('error' in r) setCloudErr(r.error);
        else setCloudRunner(r.runner);
      } catch (e) {
        if (!cancelled) setCloudErr(e instanceof Error ? e.message : '云端 OCR 不可用');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [engine, picked, stableMakeRunner]);

  const load = useCallback(async () => {
    try {
      const sources = await sourceService.list();
      setState({ kind: 'ready', sources });
      /* 没指定也没选过时，默认选第一份 —— 让页面一进来就能用 */
      setPicked((prev) => prev ?? sources[0]?.id ?? null);
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : '读不出资料列表',
      });
    }
  }, [sourceService]);

  useEffect(() => {
    void load();
  }, [load]);

  /* 外部指定了资料时跟过去（从别处跳进来） */
  useEffect(() => {
    if (initialSourceId) setPicked(initialSourceId);
  }, [initialSourceId]);

  const sources = state.kind === 'ready' ? state.sources : [];
  /*
   * 能不能交给 MinerU。
   *
   * 只有 PDF 与图片需要它；docx / pptx / markdown / text 的正文
   * 我们自己的解析器早就取好了 —— 交给 MinerU 没有意义，
   * 而且会写出一批错页号的内容（实测把一份 2 页的 docx 写成 36 段）。
   */
  const eligibleKind = (kind: string) => kind === 'pdf' || kind === 'image';

  /**
   * 重名消歧（2026-11-11）。
   *
   * 实测用户库里有**两份同名 PDF**（内容不同：一份 36 页、一份只有 1-2 页），
   * 列表里两行字一模一样，用户只能靠猜 —— 已经因此把分片解析写错过一次。
   *
   * `disambiguateTitles` 只给重名的那几份加「（1）」「（2）」，
   * 不重名的保持干净。
   */
  const titleById = useMemo(() => disambiguateTitles(sources), [sources]);
  /** 有没有重名 —— 有的话在每行补上导入时间，进一步帮用户区分 */
  const hasDuplicates = useMemo(() => {
    const seen = new Set<string>();
    for (const s of sources) {
      const k = s.title.trim();
      if (seen.has(k)) return true;
      seen.add(k);
    }
    return false;
  }, [sources]);

  const current = useMemo(() => {
    const s = sources.find((x) => x.id === picked);
    if (!s) return null;
    /* 选中了不支持的种类 → 不当作 current，页面上给一句说明 */
    return eligibleKind(s.kind) ? s : null;
  }, [sources, picked]);

  /**
   * 排序：**还没解析完的排前面**。
   *
   * 这一页的主要用途就是「补正文」，所以待办的应该在最上面。
   * 已经 ready 的排后面（它们只是「想再解析几页」时才会用到）。
   *
   * ## ⚠️ 只列 MinerU 能处理的资料（2026-11-11 实测 bug）
   *
   * 实测发现用户库里一份 **docx** 也被列了出来，而且被解析了 3-4 页 ——
   * 结果那份 2 页的 docx 被写成 36 段，前两页清空、3-4 页塞进了 PDF 的内容。
   *
   * 根因：这一页原来列**全部**资料。但 MinerU 只处理 PDF 与图片；
   * docx / pptx / markdown / text 的正文我们自己的解析器早就取好了，
   * 根本不需要也不应该交给 MinerU。
   *
   * 所以按 kind 过滤：只留 pdf 与 image。
   */
  const ordered = useMemo(() => {
    const eligible = sources.filter((s) => eligibleKind(s.kind));
    const pending = eligible.filter((s) => needsConversion(s.textStatus, s.kind));
    const done = eligible.filter((s) => !needsConversion(s.textStatus, s.kind));
    return [...pending, ...done];
  }, [sources]);

  /** 当前选中是否在可解析列表里 —— 不在就说明是 docx 之类，给一句说明 */
  const pickedUnsupported =
    picked !== null &&
    sources.some((s) => s.id === picked) &&
    !ordered.some((s) => s.id === picked);

  if (state.kind === 'loading') {
    return (
      <div className="parse-page">
        <p className="pp-hint">正在读资料…</p>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="parse-page">
        <p className="pp-error">{state.message}</p>
      </div>
    );
  }

  return (
    <div className="parse-page">
      <header className="pp-head">
        <h1 className="pp-title">文档解析</h1>
        <p className="pp-lead">
          把 PDF 或图片里的文字识别成正文。解析后的正文可以整理成知识点、逐页对照原文。
          大书可以分几次解析 —— 新解析的页会合并进来，已解析的不会丢。
        </p>
      </header>

      {sources.length === 0 ? (
        <EmptyCard
          icon={<IconSources size={22} />}
          title="还没有资料"
          hint="先到「资料」页导入一份 PDF 或图片，再回来这里解析。"
        />
      ) : (
        <>
          {/* ---- 选资料 ---- */}
          <fieldset className="pp-field">
            <legend className="pp-legend">选资料</legend>
            <div className="pp-sources">
              {ordered.map((s) => {
                const needs = needsConversion(s.textStatus, s.kind);
                const on = s.id === picked;
                /* 重名的加「（1）」「（2）」，不重名的就是原标题 */
                const shown = titleById.get(s.id) ?? s.title;
                const importedAt = formatImportedAt(s.createdAt);
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={`pp-source${on ? ' pp-source--on' : ''}`}
                    onClick={() => setPicked(s.id)}
                    title={
                      (needs ? '还没有正文，需要解析' : '已有正文') +
                      (importedAt ? ` · 导入于 ${importedAt}` : '')
                    }
                  >
                    <span className="pp-source__name">{shown}</span>
                    <span className="pp-source__meta">
                      {/*
                        只有存在重名时才显示导入时间（2026-11-11）。
                        没有歧义时每行都拖着日期只是噪音。
                      */}
                      {hasDuplicates && importedAt ? (
                        <span className="pp-source__when">{importedAt}</span>
                      ) : null}
                      {needs ? (
                        <span className="pp-badge pp-badge--todo">待解析</span>
                      ) : (
                        <span className="pp-badge pp-badge--done">
                          {s.segmentCount ?? 0} 段
                        </span>
                      )}
                      {s.pageCount ? <span className="pp-source__pages">{s.pageCount} 页</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* ---- 解析面板 ---- */}
          {/*
            选中了不该用 MinerU 解析的资料（如 docx）时给一句说明（2026-11-11）。
            不显示空面板 —— 也不静默什么都不显示。
          */}
          {pickedUnsupported ? (
            <p className="pp-note">
              这份资料的正文不需要 MinerU 解析 —— 它的文字导进来时就已经取出来了。
              这一页只处理 PDF 和图片；docx / pptx / 纯文本请直接去「整理知识点」。
            </p>
          ) : null}

          {current ? (
            <div className="pp-panel">
              {/*
                引擎选择（2026-11-15，用户要求）。
                「本地 MinerU」与「DeepSeek 云 OCR」并列，各有取舍，
                代价写在选项上（尤其云端不出插图这条）。
                只在云端真的可用时才显示两个选项 ——
                没有云 OCR 的环境不该看到一条永远点不了的选项。
              */}
              {cloudOcr ? (
                <EnginePicker
                  value={engine}
                  onChange={setEngine}
                  {...(cloudOcr.reason ? { cloudDisabledReason: cloudOcr.reason } : {})}
                />
              ) : null}

              {engine === 'deepseek' && cloudErr ? (
                <p className="pp-note pp-note--bad">
                  {engineLabel('deepseek')}现在用不了：{cloudErr}
                </p>
              ) : null}

              {/*
                alwaysShow：即使已有正文也要显示面板。
                这正是用户报的那个问题的修法 ——
                解析过 2 页之后仍然要能接着解析。
              */}
              <ConvertPanel
                source={current}
                sourceService={sourceService}
                alwaysShow
                engine={engine}
                onConverted={() => void load()}
                {...(onOpenReader
                  ? { onOpenPage: () => onOpenReader(current.id) }
                  : {})}
                /*
                 * 选云端时注入云 runner（ConvertPanel 的 runner 是注入式的，
                 * 所以「换引擎」在这里就是「换一个 runner 实例」，
                 * 面板内部一行都不用改）。
                 * 不传 runner = 面板自己取本地 MinerU 实现。
                 */
                {...(engine === 'deepseek' && cloudRunner ? { runner: cloudRunner } : {})}
              />
            </div>
          ) : null}

          {/* ---- 下一步 ---- */}
          {current ? (
            <div className="pp-next">
              <p className="pp-next__lead">
                {needsConversion(current.textStatus, current.kind)
                  ? '解析出正文之后，就可以去整理知识点了。'
                  : '正文已就绪，可以去看原文，或整理成知识点。'}
              </p>
              <div className="pp-next__actions">
                {onOpenReader ? (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => onOpenReader(current.id)}
                  >
                    看原文
                  </button>
                ) : null}
                {onOpenOrganize ? (
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => onOpenOrganize(current.id)}
                  >
                    去整理知识点
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

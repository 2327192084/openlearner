/**
 * MinerU 一键安装面板（2026-11-11 晚）。
 *
 * ## 它解决什么
 *
 * 原来的做法是给用户五段 pip 命令，让他自己装 Python、配环境变量。
 * 用户原话：「要是用户不知道怎么安装python，不懂配置环境怎么办」。
 *
 * 现在：选一次盘 → 点一下 → 剩下去做别的事。
 *
 * ## 三条设计约束（都来自用户明确要求）
 *
 * 1. **选盘只选一次**。venv 建好之后不能搬 —— pyvenv.cfg 与 Scripts 下的
 *    exe 启动器都写死绝对路径（实测 mineru-kit.exe 里能 grep 到完整路径）。
 *    所以装完再想换盘等于重装，界面必须把这点写清楚。
 * 2. **空间不够的盘直接置灰**，不让用户装了半路发现磁盘满。
 * 3. **要有卸载按钮**，能移除 MinerU 而不碰学习库。
 *
 * ## A 方案（用户选的）
 *
 * 机器上已经有一份可用的 MinerU 时**不再装第二份**。
 * 原因不是省事：MinerU 的 server 是全局单例，装第二份会和已有那份
 * 抢服务、token 打架（实测 `invalid_doclib_token`）。
 * 所以这里先探测，找到就直接告知「用那个」。
 *
 * ## 为什么独立成文件
 *
 * 硬约束：`MineruSetupPanel.tsx` 已 265 行、`SettingsPage.tsx` 1440+ 行，
 * 新增 UI 一律独立文件。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import './mineru-install.css';
import {
  INSTALL_STEPS,
  panelView,
  stepLabel,
  progressPercent,
  formatGb,
  type StepState,
} from './mineru-install-view.ts';

/* -------------------------------------------------------------------------- */
/* 与主进程的约定（preload 暴露，浏览器里没有）                                  */
/* -------------------------------------------------------------------------- */

interface Drive {
  root: string;
  letter: string;
  freeBytes: number;
  totalBytes: number;
  enough: boolean;
}

interface DetectResult {
  ok: boolean;
  found: boolean;
  exePath?: string;
  home?: string | null;
  source?: string;
  error?: string;
}

interface InstallEvent {
  type: 'step' | 'line' | 'progress';
  id?: string;
  state?: 'running' | 'done' | 'failed' | 'skipped';
  error?: string;
  line?: string;
  downloaded?: number;
  total?: number | null;
}

interface InstallResult {
  ok: boolean;
  reused?: boolean;
  exePath?: string;
  home?: string | null;
  root?: string | null;
  message?: string;
  error?: string;
  hint?: string;
  failedStep?: string;
}

interface InstallerBridge {
  drives: () => Promise<{ ok: boolean; drives: Drive[]; error?: string }>;
  detect: () => Promise<DetectResult>;
  pickDir: (defaultPath?: string) => Promise<
    | null
    | { ok: boolean; dir: string; target: string; freeBytes: number | null; enough: boolean }
  >;
  start: (root: string, force?: boolean) => Promise<InstallResult>;
  uninstall: (root: string) => Promise<{ ok: boolean; error?: string; hint?: string }>;
  onEvent: (cb: (e: InstallEvent) => void) => () => void;
}

function installer(): InstallerBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { openleaner?: { mineruInstaller?: InstallerBridge } }).openleaner
    ?.mineruInstaller;
}

/* -------------------------------------------------------------------------- */
/* 组件                                                                        */
/* -------------------------------------------------------------------------- */

export function MineruInstallPanel() {
  const bridge = installer();

  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [drives, setDrives] = useState<Drive[]>([]);
  const [chosen, setChosen] = useState<{ dir: string; target: string } | null>(null);

  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Record<string, StepState>>({});
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null } | null>(null);
  const [lastLine, setLastLine] = useState<string | null>(null);
  const [result, setResult] = useState<InstallResult | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /* 卸载的二次确认：删了要重下 2.7GB，不能一点就没 */
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /** 刷新「已有 MinerU」与磁盘列表 */
  const refresh = useCallback(async () => {
    if (!bridge) return;
    const [d, dr] = await Promise.all([bridge.detect(), bridge.drives()]);
    if (!aliveRef.current) return;
    setDetect(d);
    setDrives(dr.ok ? dr.drives : []);
    if (!dr.ok) setNote(dr.error ?? null);
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* 订阅安装事件（组件卸载时取消，避免往已卸载组件写状态） */
  useEffect(() => {
    if (!bridge) return;
    const off = bridge.onEvent((e) => {
      if (!aliveRef.current) return;
      if (e.type === 'step' && e.id) {
        setSteps((prev) => ({ ...prev, [e.id!]: (e.state ?? 'running') as StepState }));
        /* 新阶段开始时清掉上一段的进度，避免张冠李戴 */
        if (e.state === 'running') setProgress(null);
      } else if (e.type === 'progress') {
        setProgress({ downloaded: e.downloaded ?? 0, total: e.total ?? null });
      } else if (e.type === 'line' && e.line) {
        /* 只留「有信息量」的行，避免把 pip 的刷屏塞进界面 */
        const t = e.line.trim();
        if (/error|failed|拒绝|denied|Downloading|Installing|Resolved/i.test(t)) {
          setLastLine(t.slice(0, 160));
        }
      }
    });
    return off;
  }, [bridge]);

  const pickDir = useCallback(async () => {
    if (!bridge) return;
    setNote(null);
    const r = await bridge.pickDir();
    if (!r) return; /* 用户取消 */
    setChosen({ dir: r.dir, target: r.target });
    if (!r.enough) {
      setNote(
        `这个位置只剩 ${formatGb(r.freeBytes)}，` +
          '装 MinerU 需要约 3 GB。建议换一个空间更大的磁盘。',
      );
    }
  }, [bridge]);

  const start = useCallback(
    async (force?: boolean) => {
      if (!bridge || !chosen) return;
      setBusy(true);
      setResult(null);
      setSteps({});
      setProgress(null);
      setLastLine(null);
      setNote(null);
      try {
        const r = await bridge.start(chosen.target, force);
        if (!aliveRef.current) return;
        setResult(r);
        if (r.ok) void refresh();
      } catch (e) {
        if (!aliveRef.current) return;
        setResult({ ok: false, error: e instanceof Error ? e.message : '安装失败' });
      } finally {
        if (aliveRef.current) setBusy(false);
      }
    },
    [bridge, chosen, refresh],
  );

  const doUninstall = useCallback(async () => {
    if (!bridge) return;
    /*
     * 卸载要删哪个目录：优先用探测到的 root；
     * 没有的话用用户选的那个（可能装到一半）。
     */
    const target = chosen?.target ?? null;
    if (!target) {
      setNote('不知道 MinerU 装在哪，无法卸载。可以用上面的「选择目录」指到它。');
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const r = await bridge.uninstall(target);
      if (!aliveRef.current) return;
      if (r.ok) {
        setResult({ ok: true, message: '已卸载 MinerU。已解析的资料不受影响。' });
        setSteps({});
        setConfirmUninstall(false);
        void refresh();
      } else {
        setNote(r.error ?? '卸载失败');
      }
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [bridge, chosen, refresh]);

  /* 浏览器里没有这个桥 —— 如实说，不摆一个点了没反应的按钮 */
  if (!bridge) {
    return (
      <div className="set-section">
        <h2 className="set-section__title">一键安装 MinerU</h2>
        <p className="set-hint">
          一键安装要在桌面版里用（浏览器里没有文件与进程权限）。
        </p>
      </div>
    );
  }

  /*
   * 所有「该显示什么 / 能不能点」的判断都走 panelView ——
   * 那边有单测（mineru-install-view.test.ts），组件只管画。
   */
  const view = panelView({
    hasBridge: true,
    alreadyInstalled: Boolean(detect?.found),
    hasChosenDir: Boolean(chosen),
    busy,
    steps,
  });
  const running = view.showRunning;

  return (
    <>
      <div className="set-section">
        <h2 className="set-section__title">一键安装 MinerU</h2>
        <p className="set-section__lead">
          扫描件、拍照、截图里的字是「图片」而不是「文本」，软件自己读不到。
          MinerU 能把图里的字转成正文，之后就能整理知识点、出题、搜索。
          <strong>不装也不影响普通 PDF / Word / PPT / Markdown 的导入。</strong>
        </p>

        {/* ---- A 方案：已有就用那个 ---- */}
        {view.showDetected ? (
          <div className="mineru-inst-detect mineru-inst-detect--found">
            <p className="mineru-inst-detect__title">
              这台机器上已经装好 MinerU 了，直接用就行
            </p>
            <code className="mineru-inst-detect__path">{detect?.exePath}</code>
            <p className="set-hint">
              来源：{detect?.source}。不需要再装一份 ——
              MinerU 的服务同时只能有一个实例，装第二份反而会和它抢。
            </p>
          </div>
        ) : (
          <>
            {/* ---- 第一步：选盘（只选一次）---- */}
            <div className="mineru-inst-block">
              <div className="mineru-inst-block__head">
                <span className="mineru-inst-step-no">1</span>
                <span className="set-label">选择安装位置</span>
              </div>
              <p className="set-hint">
                装完之后<strong>不能搬家</strong>（运行环境会记录绝对路径），
                所以现在选好。MinerU 会装在所选目录下的 <code>mineru</code> 文件夹里。
              </p>

              <div className="mineru-inst-pick">
                <code className="mineru-inst-pick__value">
                  {chosen ? chosen.target : '（还没选）'}
                </code>
                <button
                  type="button"
                  className="mineru-btn"
                  onClick={() => void pickDir()}
                  disabled={running}
                >
                  选择目录
                </button>
              </div>

              {/* 磁盘一览：空间不够的置灰（用户要求「直接置灰」） */}
              {drives.length > 0 ? (
                <ul className="mineru-inst-drives">
                  {drives.map((d) => (
                    <li
                      key={d.root}
                      className={`mineru-inst-drive${d.enough ? '' : ' mineru-inst-drive--off'}`}
                    >
                      <span className="mineru-inst-drive__letter">{d.letter}:</span>
                      <span className="mineru-inst-drive__free">{formatGb(d.freeBytes)} 可用</span>
                      <span className="mineru-inst-drive__tag">
                        {d.enough ? '可选' : '空间不足'}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            {/* ---- 第二步：安装 ---- */}
            <div className="mineru-inst-block">
              <div className="mineru-inst-block__head">
                <span className="mineru-inst-step-no">2</span>
                <span className="set-label">开始安装</span>
              </div>
              <p className="set-hint">
                总共约 <strong>3 GB</strong>（其中识别模型占 2 GB），
                按网速要几分钟到几十分钟。中途断了可以重来，已完成的步骤不会重做。
              </p>

              <div className="mineru-inst-actions">
                <button
                  type="button"
                  className="btn-fill btn-fill--sm"
                  onClick={() => void start()}
                  disabled={!view.canStart}
                >
                  {view.showRunning ? '正在安装…' : '开始安装'}
                </button>
                {result && !result.ok ? (
                  <button
                    type="button"
                    className="mineru-btn"
                    onClick={() => void start(true)}
                    disabled={running}
                  >
                    重新安装
                  </button>
                ) : null}
              </div>

              {/* ---- 进度 ---- */}
              {Object.keys(steps).length > 0 ? (
                <ol className="mineru-inst-steps">
                  {INSTALL_STEPS.map((s) => {
                    const st = steps[s.id] ?? 'idle';
                    const lab = stepLabel(st);
                    return (
                      <li key={s.id} className={`mineru-inst-step mineru-inst-step--${st}`}>
                        <span className="mineru-inst-step__mark" aria-hidden="true">
                          {lab.mark}
                        </span>
                        <span className="mineru-inst-step__title">{s.title}</span>
                        {lab.note ? (
                          <span className="mineru-inst-step__note">{lab.note}</span>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              ) : null}

              {progress ? (
                <div className="mineru-inst-progress">
                  <div className="mineru-inst-progress__bar">
                    {/*
                      拿不到总大小时不画百分比，改画一条不确定态的斜纹。
                      原来这里写死 30% —— 那是在编数字，用户会以为快好了。
                    */}
                    {progressPercent(progress.downloaded, progress.total) === null ? (
                      <div className="mineru-inst-progress__fill mineru-inst-progress__fill--indeterminate" />
                    ) : (
                      <div
                        className="mineru-inst-progress__fill"
                        style={{
                          width: `${progressPercent(progress.downloaded, progress.total)!.toFixed(1)}%`,
                        }}
                      />
                    )}
                  </div>
                  <span className="mineru-inst-progress__text">
                    {(progress.downloaded / 1048576).toFixed(1)} MB
                    {progress.total ? ` / ${(progress.total / 1048576).toFixed(0)} MB` : ''}
                  </span>
                </div>
              ) : null}

              {lastLine ? <p className="mineru-inst-line">{lastLine}</p> : null}
            </div>
          </>
        )}

        {/* ---- 结果 ---- */}
        {result ? (
          <div
            className={`mineru-inst-result${result.ok ? ' mineru-inst-result--ok' : ' mineru-inst-result--bad'}`}
          >
            {result.ok ? (
              <>
                <p className="mineru-inst-result__title">
                  {result.reused ? '已找到现有的 MinerU' : '安装完成，已经能用了'}
                </p>
                {result.message ? <p className="set-hint">{result.message}</p> : null}
                {result.exePath ? (
                  <code className="mineru-inst-detect__path">{result.exePath}</code>
                ) : null}
              </>
            ) : (
              <>
                <p className="mineru-inst-result__title">
                  安装没成功{result.failedStep ? `（卡在「${result.failedStep}」）` : ''}
                </p>
                <p className="set-hint">{result.error}</p>
                {result.hint ? <p className="mineru-hint-box">{result.hint}</p> : null}
                <p className="set-hint">
                  已下载的内容都还在，点「重新安装」会从断点继续，不会从头再来。
                </p>
              </>
            )}
          </div>
        ) : null}

        {note ? <p className="mineru-note">{note}</p> : null}

        {/* ---- 卸载 ---- */}
        <div className="mineru-inst-danger">
          <div className="mineru-inst-danger__head">
            <span className="set-label">卸载 MinerU</span>
          </div>
          <p className="set-hint">
            只删除 MinerU 自己（程序、运行环境、模型），
            <strong>不会碰你的学习库</strong> —— 资料、知识点、题目、复习记录都在别的地方。
            卸载后已经解析好的正文和插图也不受影响。
          </p>

          {confirmUninstall ? (
            <div className="mineru-inst-danger__confirm">
              <p className="mineru-inst-danger__warn">
                确定要删掉 <code>{chosen?.target ?? '（未选择目录）'}</code> 吗？
                以后要用得重新下载约 3 GB。
              </p>
              <div className="mineru-inst-actions">
                <button
                  type="button"
                  className="mineru-btn mineru-btn--danger"
                  onClick={() => void doUninstall()}
                  disabled={running}
                >
                  确认卸载
                </button>
                <button
                  type="button"
                  className="mineru-btn"
                  onClick={() => setConfirmUninstall(false)}
                  disabled={running}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <div className="mineru-inst-actions">
              <button
                type="button"
                className="mineru-btn"
                onClick={() => setConfirmUninstall(true)}
                disabled={!view.canUninstall}
              >
                卸载 MinerU
              </button>
              {!chosen ? (
                <span className="set-hint">
                  先用上面的「选择目录」指到 MinerU 装在哪。
                </span>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

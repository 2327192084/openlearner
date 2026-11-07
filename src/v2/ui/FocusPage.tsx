/**
 * 专注（番茄钟）。
 *
 * ## 为什么单独一页，而不是塞进待办
 *
 * 用户 2026-11-08 明确说：「如果要加番茄钟的话是不是新开一个功能栏最好，
 * 例如学习/专注模式，或者就叫番茄钟」。
 *
 * 想清楚这个判断是对的：待办是**回顾与规划**（我该做什么），
 * 专注是**执行**（我现在只做这一件）。两种状态互斥 ——
 * 专注的时候最不该看到的就是一列「还有 8 件事没做」。
 * 塞在一页里，用户一点开始计时就被自己的待办列表压住了。
 *
 * ## 计时为什么用时间戳而不是累加
 *
 * `setInterval(1000)` 累计会漂移：标签页被切走、系统卡顿都会丢秒，
 * 一小时后能差出几分钟。这里每一帧都用 `Date.now() - startedAt` 重算，
 * 所以无论中间卡多久，显示的永远是真实经过的时间。
 *
 * ## 为什么切走/失焦不暂停
 *
 * 专注期间切走是用户自己的选择（查个资料很正常）。
 * 自动暂停会让人以为自己一直在计时，回来发现只走了 3 分钟 —— 那更糟。
 * 时间照走，界面在回来时如实显示已经过了多久。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FocusService, FocusStats } from '@/core/focus.ts';
import type { FocusSession } from '@/core/model.ts';

export interface FocusPageProps {
  focus: FocusService;
}

/** 预设时长（分钟） */
const PRESETS = [15, 25, 45, 60];

export function FocusPage({ focus }: FocusPageProps) {
  const [minutes, setMinutes] = useState(25);
  const [task, setTask] = useState('');
  const [running, setRunning] = useState(false);
  /**
   * 开始时刻（毫秒）。用时间戳而不是「剩余秒数」，
   * 原因见文件头：累加会漂移。
   */
  const [startedAt, setStartedAt] = useState<number | null>(null);
  /** 中止的一轮：结束后用来告知「只专注了 X 分钟，不算一轮」 */
  const [notice, setNotice] = useState<string | null>(null);

  const [stats, setStats] = useState<FocusStats | null>(null);
  const [recent, setRecent] = useState<FocusSession[]>([]);
  const [err, setErr] = useState<string | null>(null);

  /** 每秒重算一次，只为了让界面刷新；真实时间来自 Date.now() */
  const [, forceTick] = useState(0);
  const timerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([focus.stats(), focus.list()]);
      setStats(s);
      setRecent([...list].reverse().slice(0, 8));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '读不出专注记录');
    }
  }, [focus]);

  useEffect(() => {
    void load();
  }, [load]);

  /* 计时器：只在运行时挂 */
  useEffect(() => {
    if (!running) {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    timerRef.current = window.setInterval(() => forceTick((n) => n + 1), 500);
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [running]);

  const totalSec = minutes * 60;

  /** 已经过的秒数（运行中实时算） */
  const elapsedSec = running && startedAt !== null ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  const remainSec = Math.max(0, totalSec - elapsedSec);

  const pct = useMemo(() => {
    if (totalSec === 0) return 0;
    return Math.min(100, (elapsedSec / totalSec) * 100);
  }, [elapsedSec, totalSec]);

  /*
   * 走完的那一瞬间要自动收尾。
   *
   * 为什么在这里判断而不是在 interval 回调里：
   * interval 只是触发重渲染，真正的状态判断放在渲染期更可靠 ——
   * 标签页被挂起时 interval 会暂停，回到前台立刻就能补上这次收尾。
   */
  useEffect(() => {
    if (!running || remainSec > 0) return;
    void finish(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, remainSec]);

  async function start() {
    setNotice(null);
    setErr(null);
    setRunning(true);
    setStartedAt(Date.now());
  }

  async function finish(completed: boolean) {
    if (startedAt === null) return;
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);

    setRunning(false);
    setStartedAt(null);

    /*
     * 不到 1 分钟的中止不记录。
     *
     * 为什么：点了就关掉的那一下没有任何意义，
     * 记下来只会在「最近几轮」里堆一串「0 分钟 · 中止」，
     * 把真正专注过的记录挤下去。
     */
    if (!completed && elapsed < 60) {
      setNotice('这一轮不到 1 分钟，没有记录。');
      return;
    }

    try {
      await focus.record({
        task,
        plannedSec: totalSec,
        elapsedSec: elapsed,
        completed,
      });
      await load();
      if (completed) {
        setNotice(`完成一轮 ${minutes} 分钟专注。`);
      } else {
        setNotice(
          `中止了，实际专注 ${Math.floor(elapsed / 60)} 分钟。这段算进总时长，但不算「一轮」。`,
        );
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '记录失败');
    }
    setTask('');
  }

  function fmt(min: number): string {
    if (min < 60) return `${min} 分钟`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
  }

  const mm = String(Math.floor(remainSec / 60)).padStart(2, '0');
  const ss = String(remainSec % 60).padStart(2, '0');

  return (
    <div className="focus-page">
      <header className="focus-head">
        <h1 className="focus-title">专注</h1>
        <p className="focus-lead">
          选一段时间，只做一件事。走完一轮会记下来；中途停下也如实记录实际时长。
        </p>
      </header>

      {err ? <p className="focus-error">{err}</p> : null}

      {/* ---------- 计时区 ---------- */}
      <div className={`focus-card${running ? ' focus-card--running' : ''}`}>
        <div className="focus-ring" aria-hidden="true">
          <span className="focus-ring__fill" style={{ width: `${pct}%` }} />
        </div>

        <div className="focus-time" role="timer" aria-live="off">
          {running ? (
            <>
              {mm}:{ss}
            </>
          ) : (
            <>{minutes}:00</>
          )}
        </div>

        {running ? (
          <>
            <p className="focus-task">
              {task.trim() ? task : '（没写这一轮做什么）'}
            </p>
            <div className="focus-actions">
              <button type="button" className="btn-fill" onClick={() => void finish(false)}>
                提前结束
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="focus-taskfield">
              <span className="focus-taskfield__label">这一轮做什么（可不填）</span>
              <input
                className="focus-input"
                type="text"
                placeholder="例如：复习第三章、整理错题"
                value={task}
                onChange={(e) => setTask(e.target.value)}
              />
            </label>

            <div className="focus-presets" role="group" aria-label="时长">
              {PRESETS.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`focus-preset${minutes === m ? ' focus-preset--on' : ''}`}
                  aria-pressed={minutes === m}
                  onClick={() => setMinutes(m)}
                >
                  {m} 分钟
                </button>
              ))}
            </div>

            <div className="focus-actions">
              <button type="button" className="btn-fill" onClick={() => void start()}>
                开始专注
              </button>
            </div>
          </>
        )}

        {notice ? (
          <p className="focus-notice" role="status">
            {notice}
          </p>
        ) : null}
      </div>

      {/* ---------- 统计 ---------- */}
      {stats ? (
        <div className="focus-stats">
          <span className={`focus-stat${stats.todayRounds > 0 ? ' focus-stat--on' : ''}`}>
            <span className="focus-stat__n">{stats.todayRounds}</span>
            <span className="focus-stat__label">今天完成轮数</span>
          </span>
          <span className="focus-stat">
            <span className="focus-stat__n">{fmt(Math.floor(stats.todaySec / 60))}</span>
            <span className="focus-stat__label">今天专注时长</span>
          </span>
          <span className={`focus-stat${stats.streakDays > 0 ? ' focus-stat--on' : ''}`}>
            <span className="focus-stat__n">{stats.streakDays}</span>
            <span className="focus-stat__label">连续天数</span>
          </span>
          <span className="focus-stat">
            <span className="focus-stat__n">{stats.totalRounds}</span>
            <span className="focus-stat__label">累计轮数</span>
          </span>
        </div>
      ) : null}

      {/* ---------- 最近记录 ---------- */}
      <section className="focus-history">
        <h2 className="focus-h2">最近几轮</h2>
        {recent.length === 0 ? (
          <p className="focus-empty">还没有专注记录。选个时长，开始第一轮。</p>
        ) : (
          <ul className="focus-list">
            {recent.map((s) => (
              <li key={s.id} className="focus-row">
                <span className={`focus-row__dot${s.completed ? ' focus-row__dot--done' : ''}`} aria-hidden="true" />
                <span className="focus-row__task">{s.task || '（未写内容）'}</span>
                <span className="focus-row__time">
                  {Math.floor(s.elapsedSec / 60)} 分钟
                  {!s.completed ? ' · 中止' : ''}
                  {s.manual ? ' · 补记' : ''}
                </span>
                <span className="focus-row__day">{s.localDay}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="focus-foot">
          「轮数」只数完整走完的；中止的那一段仍计入时长 ——
          那几分钟确实专注了，只是没走完一整轮。
        </p>
      </section>
    </div>
  );
}

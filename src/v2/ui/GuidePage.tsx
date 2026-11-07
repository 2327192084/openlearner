/**
 * 功能导览：一页说清「这个软件能做什么、每一页在哪、还没做什么」。
 *
 * ## 为什么这一页必须自动生成，不能手写
 *
 * 手写的说明文会**立刻开始腐烂**：改了页面名、加了一页、
 * 把某页从占位变成能用 —— 导览里那句「还没做」就会变成谎言。
 * 这个项目已经因为「说去 X 页面做 Y，而 X 根本没有那功能」踩过好几次。
 *
 * 所以内容全部从 `pages.ts`（导航注册表，界面的唯一真源）推导：
 *  - 有哪些页 → `PAGES` + `OFF_NAV`
 *  - 每页干什么 → `PageDef.purpose`
 *  - 哪些还没做 → `PageDef.ready` 不为 true
 * 页面的增删改会立刻反映到这里，不需要记得同步。
 *
 * ## 为什么把「还没做」单独列一块
 *
 * 用户最需要知道的是**边界**：哪些点了会有反应、哪些是占位。
 * 混在一张长表里看不出重点，所以分成「现在能用」和「还没做」两块。
 */

import { useMemo } from 'react';
import type { PageId } from './pages.ts';
import { GROUPS, PAGES, pageById, pagesInGroup } from './pages.ts';

export interface GuidePageProps {
  /** 点某一项 → 直接去那一页（只对能用的开放） */
  onNavigate: (id: PageId) => void;
}


export function GuidePage({ onNavigate }: GuidePageProps) {
  /**
   * 按分组整理出「现在能用」的页面。
   *
   * `ready === true` 才算能用。占位页（没有 ready 或 ready: false）
   * 归到下面的「还没做」区块 —— 这一条判断是这一页可信的基础。
   */
  const sections = useMemo(
    () =>
      GROUPS.map((g) => ({
        group: g.label,
        ready: pagesInGroup(g.id).filter((p) => p.ready === true),
        pending: pagesInGroup(g.id).filter((p) => p.ready !== true),
      })),
    [],
  );

  /**
   * 从侧栏摘掉的页（`show: false` 且未实现）。
   *
   * 为什么单独列：这些不是「忘了做」，而是**明确决定现在不做**，
   * 并且原因具体（缺引擎、缺数据源）。把它们藏在代码里不说明，
   * 用户以后翻到会以为是漏掉的；列出来并写清前置条件，
   * 一是诚实，二是给自己留一份「做这件事先要解决什么」的备忘。
   *
   * 注意不列 `generate / organize / reader / practice / guide` 这些
   * 「有别的入口、不需要进侧栏」的页 —— 它们不是缺条件。
   */
  const shelved = useMemo(
    () =>
      PAGES.filter(
        (p) =>
          !p.show &&
          p.ready !== true &&
          /* 排除只是「没有侧栏入口」的正常页 */
          !['generate', 'organize', 'reader', 'practice', 'guide', 'study', 'review'].includes(p.id),
      ),
    [],
  );

  /**
   * 不在分组导航里、但确实能用的页（做题、整理、阅读原文等）。
   *
   * 这些页没有侧栏入口，用户找不到它们的存在理由 ——
   * 导览正好是说明「它们从哪进」的地方。
   */
  const offNavUsable = useMemo(
    () =>
      (
        [
          ['review', '从顶部「开始学习」→「开始做题」进入'],
          ['practice', '选完模式后自动进入'],
          ['organize', '从「资料」某一行点「整理」进入'],
          ['reader', '从「资料」点某一行、或从知识点点「第 N 页」进入'],
        ] as [PageId, string][]
      ).map(([id, how]) => ({ def: pageById(id), how })),
    [],
  );

  const totalReady =
    sections.reduce((n, s) => n + s.ready.length, 0) + offNavUsable.length;
  const totalPending = sections.reduce((n, s) => n + s.pending.length, 0);

  return (
    <div className="guide-page">
      <header className="gd-head">
        <h1 className="gd-title">功能导览</h1>
        <p className="gd-lead">
          这一页说明现在能做什么、从哪里进、以及哪些还没做。
          内容直接来自导航注册表，所以不会和实际界面对不上。
        </p>
      </header>

      {/* ---------- 概览 ---------- */}
      <div className="gd-stats">
        <span className="gd-stat">
          <span className="gd-stat__n">{totalReady}</span>
          <span className="gd-stat__label">项现在能用</span>
        </span>
        <span className="gd-stat gd-stat--dim">
          <span className="gd-stat__n">{totalPending}</span>
          <span className="gd-stat__label">项还没做</span>
        </span>
      </div>

      {/* ---------- 能用的 ---------- */}
      <h2 className="gd-h2">现在能用</h2>
      {sections.map((s) =>
        s.ready.length === 0 ? null : (
          <section key={s.group} className="gd-group">
            <h3 className="gd-group__title">{s.group}</h3>
            <ul className="gd-list">
              {s.ready.map((p) => (
                <li key={p.id} className="gd-item">
                  <button
                    type="button"
                    className="gd-item__btn"
                    onClick={() => onNavigate(p.id)}
                  >
                    <span className="gd-item__name">{p.label}</span>
                    <span className="gd-item__purpose">{p.purpose}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ),
      )}

      {/* ---------- 没有侧栏入口但能用的 ---------- */}
      <section className="gd-group">
        <h3 className="gd-group__title">没有侧栏入口，但真能用</h3>
        <ul className="gd-list">
          {offNavUsable.map(({ def, how }) => (
            <li key={def.id} className="gd-item gd-item--static">
              <span className="gd-item__name">{def.label}</span>
              <span className="gd-item__purpose">{def.purpose}</span>
              <span className="gd-item__how">进法：{how}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* ---------- 还没做 ---------- */}
      <h2 className="gd-h2 gd-h2--pending">还没做</h2>
      <p className="gd-hint">
        下面这些点了会进到一个占位页，上面写清「还在重做中」。
        它们不会假装能用 —— 按钮点了没反应比没有按钮更糟。
      </p>
      {sections.map((s) =>
        s.pending.length === 0 ? null : (
          <section key={s.group} className="gd-group">
            <h3 className="gd-group__title">{s.group}</h3>
            <ul className="gd-list">
              {s.pending.map((p) => (
                <li key={p.id} className="gd-item gd-item--pending">
                  <span className="gd-item__name">
                    {p.label}
                    <span className="gd-badge">还没做</span>
                  </span>
                  <span className="gd-item__purpose">{p.purpose}</span>
                </li>
              ))}
            </ul>
          </section>
        ),
      )}

      {/* ---------- 需要条件才能做 ---------- */}
      {shelved.length > 0 ? (
        <>
          <h2 className="gd-h2 gd-h2--pending">现在没做，也没放进侧栏</h2>
          <p className="gd-hint">
            下面几项不是漏掉的，是**现在做不了**：差一个外部条件。
            侧栏里没有它们的入口 —— 摆一个点了没反应的入口比不摆更糟。
          </p>
          <section className="gd-group">
            <ul className="gd-list">
              {shelved.map((p) => (
                <li key={p.id} className="gd-item gd-item--pending">
                  <span className="gd-item__name">
                    {p.label}
                    <span className="gd-badge">缺条件</span>
                  </span>
                  <span className="gd-item__purpose">{p.purpose}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}

      {/* ---------- 操作要点 ---------- */}
      <section className="gd-tips">
        <h2 className="gd-h2">几条要点</h2>
        <ul className="gd-tip-list">
          <li>
            <strong>做题有三种模式。</strong>
            今日题组按遗忘曲线排；自由练习不受到期限制，想练就练；
            错题巩固只做最近答错的。
          </li>
          <li>
            <strong>做错会自动进错题集。</strong>
            不弹评分面板直接进下一题。重做答对后它就从错题集消失。
          </li>
          <li>
            <strong>评分按用时判。</strong>
            四个档位给出的复习间隔各不相同，按钮上直接写着下次什么时候再见。
            切到别的窗口会自动暂停计时，也能手动暂停。
          </li>
          <li>
            <strong>每道题都能点回原文。</strong>
            阅读器里能定位到具体那一句，也能切换看 PDF 原图对照。
          </li>
          <li>
            <strong>数据只存在本机。</strong>
            全在 IndexedDB 里，不联网、不回传。记得定期到设置里导出备份。
          </li>
        </ul>
      </section>

    </div>
  );
}

/**
 * 功能导览：一页说清「这个软件能做什么、每一页在哪」。
 *
 * ## 为什么这一页必须自动生成，不能手写
 *
 * 手写的说明文会**立刻开始腐烂**：改了页面名、加了一页 ——
 * 导览里那句话就会变成谎言。
 * 这个项目已经因为「说去 X 页面做 Y，而 X 根本没有那功能」踩过好几次。
 *
 * 所以内容全部从 `pages.ts`（导航注册表，界面的唯一真源）推导：
 *  - 有哪些页 → `pagesInGroup` / `OFF_NAV`
 *  - 每页干什么 → `PageDef.purpose`
 * 页面的增删改会立刻反映到这里，不需要记得同步。
 *
 * ## 2026-11-16：删掉「还没做」「缺条件」两块
 *
 * 用户原话：「这些还没有做的功能无论是描述还是按钮都删掉。」
 *
 * 改动前这里会列出三类东西：`ready !== true` 的占位页、
 * 以及从侧栏摘掉但保留说明的「缺条件」页（备考补习 / 音频转写 / 课堂实录）。
 * 那几页的描述（「需要先支持导入考纲，暂未做」之类）本身就是**承诺的清单**，
 * 而承诺一直没兑现，用户看到的是「这软件还有一堆没做完」。
 *
 * 现在那些页已经从 `pages.ts` 里整个删掉（PageId、label、purpose 一起），
 * 这一页也就不再有可列的东西 —— 只列真能用的。
 *
 * ⚠️ 别把「列出来才诚实」当成理由再把这两块加回来：
 * 页面都不存在了，导览里留一句说明只是噪音。
 * 以后真要做这些功能，是在 `pages.ts` 里新增一页（带 ready: true），
 * 它会自动出现在下面的「现在能用」里。
 */

import { useMemo } from 'react';
import type { PageId } from './pages.ts';
import { GROUPS, pageById, pagesInGroup } from './pages.ts';

export interface GuidePageProps {
  /** 点某一项 → 直接去那一页（只对能用的开放） */
  onNavigate: (id: PageId) => void;
}


export function GuidePage({ onNavigate }: GuidePageProps) {
  /**
   * 按分组整理出「现在能用」的页面。
   *
   * `ready === true` 才算能用 —— 不满足的**根本不列**，
   * 不列成「还没做」。这一页只负责说「有什么」，
   * 不负责说「还缺什么」。
   */
  const sections = useMemo(
    () =>
      GROUPS.map((g) => ({
        group: g.label,
        ready: pagesInGroup(g.id).filter((p) => p.ready === true),
      })),
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

  return (
    <div className="guide-page">
      <header className="gd-head">
        <h1 className="gd-title">功能导览</h1>
        <p className="gd-lead">
          这一页说明现在能做什么、从哪里进。
          内容直接来自导航注册表，所以不会和实际界面对不上。
        </p>
      </header>

      {/* ---------- 概览 ---------- */}
      <div className="gd-stats">
        <span className="gd-stat">
          <span className="gd-stat__n">{totalReady}</span>
          <span className="gd-stat__label">项现在能用</span>
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

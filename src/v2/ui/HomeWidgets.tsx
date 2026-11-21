/**
 * 首页右侧的小组件区（2026-11-08）。
 *
 * ## 为什么要有这个组件
 *
 * 原来那个位置是一张固定的「下一步」纸卡，显示「10 张没学过」+
 * 「去我的题组挑一组」—— 而左侧主区**已经在说同一件事**
 * （「今天没有到期的，还有 10 张新卡没学过」/「在『我的题组』里挑一组开始」）。
 * 同一屏两组数字说同一件事，还都是 10。
 *
 * 改成用户自定义：座右铭、每日单词、待办、番茄钟都能放。
 * 配置在设置页改（见 SettingsPage 的「首页小组件」）。
 *
 * ## 为什么默认是「每日一句」而不是空的
 *
 * 用户原话：「我们默认设置是放一个每日鸡汤」。空着的话首页右侧会显得像坏了。
 *
 * ## 联网
 *
 * 这一版**不联网**：每日一句用内置语料（见 home-widgets.ts 的 DAILY_QUOTES），
 * 每天按本地日期轮换。理由写在那里 —— 主要是离线可用、不给首页增加失败点。
 */

import { useMemo } from 'react';
import type { Todo } from '@/core/model.ts';
import {
  DEFAULT_WIDGET_TITLE,
  pickDailyQuote,
  type HomeWidget,
} from './home-widgets.ts';
import type { TodayPlan } from './today-plan.ts';
import { examCountdown, type ExamCountdown } from '@/v2/core/exam-countdown.ts';
import { todayLocal } from '@/v2/core/srs.ts';
import { MathText } from './MathText.tsx';
import './exam-badge.css';

export interface HomeWidgetsProps {
  widgets: HomeWidget[];
  /** 待办小组件用：未完成的几件 */
  todos?: Todo[];
  /** 今日学习小组件用的汇总（到期/薄弱分开） */
  plan?: TodayPlan | null;
  /**
   * 最近一场考期（2026-11-21）。
   *
   * ## 为什么由上层传，不在这里算
   *
   * 这个组件是**纯展示**的（文件头写着理由：展示组件不该有副作用）。
   * 要自己算就得在这里 `await storage.getAll('todos')` ——
   * 首页每次重渲染发一次异步读，数字会落在不同快照上。
   *
   * 上层已经拿到了 `todos` 全量；不给的话组件就用 `todos` 这个 prop
   * **同步**算一次（见下面的 `examOf`），仍然是纯计算、不读库。
   * 显式传 `null` 表示「确定没有考期」，此时不渲染那一行。
   */
  exam?: ExamCountdown | null;
  /**
   * 每日一句的远程内容（2026-11-08）。
   *
   * 上层用 daily-quote.ts 取，**失败会回落到内置语料**，
   * 所以这里 null 也不影响显示（组件自己还会再兜一次底）。
   */
  quote?: { text: string; author: string | null } | null;
  /** 点「去待办」 */
  onOpenTodos?: () => void;
  /** 点番茄钟小组件 */
  onStartFocus?: () => void;
  /** 点今日学习卡的按钮（复习 / 练薄弱 / 开始学） */
  onStartReview?: () => void;
  onDrillWeak?: () => void;
  onLearnNew?: () => void;
  /** 打开设置页去编辑这些小组件 */
  onOpenSettings?: () => void;
}

export function HomeWidgets({
  widgets,
  todos = [],
  plan = null,
  quote = null,
  exam,
  onOpenTodos,
  onStartFocus,
  onStartReview,
  onDrillWeak,
  onLearnNew,
  onOpenSettings,
}: HomeWidgetsProps) {
  /**
   * 传了 `exam` 就用传的；没传（undefined）就从 `todos` 同步算一次。
   *
   * 这里刻意**不是**异步读库：`todos` 是上层已经拿到并传下来的快照，
   * `examCountdown` 是纯函数（见 exam-countdown.ts）。所以两条路
   * 都不会让这个组件产生副作用，也不会出现「组件里再开一次读、
   * 数字落在另一个快照上」的分裂。
   *
   * 传 `null` 表示上层明确说了「没有考期」，此时不再从 todos 推 ——
   * 让调用方能覆盖（比如某天只想显示学习量）。
   */
  const examOf = useMemo<ExamCountdown | null>(
    () => (exam !== undefined ? exam : examCountdown(todos, todayLocal())),
    [exam, todos],
  );

  return (
    <div className="home-widgets">
      {widgets.map((w) => (
        <WidgetCard
          key={w.id}
          widget={w}
          todos={todos}
          plan={plan}
          quote={quote}
          exam={examOf}
          onOpenTodos={onOpenTodos}
          onStartFocus={onStartFocus}
          onStartReview={onStartReview}
          onDrillWeak={onDrillWeak}
          onLearnNew={onLearnNew}
        />
      ))}

      {/*
        编辑入口放在列表最后，而不是每个组件上挂一个小齿轮：
        右侧栏窄，齿轮会挤掉正文；而且用户是偶尔改一次，
        不需要每次都看到。
      */}
      {onOpenSettings ? (
        <button type="button" className="home-widgets__edit" onClick={onOpenSettings}>
          自定义这块区域
        </button>
      ) : null}
    </div>
  );
}

function WidgetCard({
  widget,
  todos,
  plan,
  quote,
  exam,
  onOpenTodos,
  onStartFocus,
  onStartReview,
  onDrillWeak,
  onLearnNew,
}: {
  widget: HomeWidget;
  todos: Todo[];
  plan: TodayPlan | null;
  quote: { text: string; author: string | null } | null;
  exam: ExamCountdown | null;
  onOpenTodos?: () => void;
  onStartFocus?: () => void;
  onStartReview?: () => void;
  onDrillWeak?: () => void;
  onLearnNew?: () => void;
}) {
  const title = widget.title.trim() || DEFAULT_WIDGET_TITLE[widget.kind];

  /*
   * 今日学习（2026-11-08 新增）。
   *
   * 把「到期」和「薄弱」分开显示 —— 这是用户看完 StudyHub 视频后
   * 提的第一个诉求，也是我判断最该补的一块：原来的首页只说
   * 「还有 N 张新卡没学过」，用户看不出这 N 张里在考什么。
   *
   * 数字全部来自 today-plan.ts 的 summarizeToday（有 18 个单测），
   * 与首页左侧「今天的安排」用同一套口径 —— 不会出现两处数字打架。
   */
  if (widget.kind === 'plan') {
    if (!plan) {
      return (
        <div className="paper home-widget">
          <div className="paper__eyebrow">{title}</div>
          <p className="home-widget__empty">正在统计…</p>
        </div>
      );
    }

    /*
     * 主按钮跟着 focus 走。这与左侧「今天的安排」里的按钮是**同一个动作**，
     * 但两处显示是刻意的：左侧是说明，右侧是快捷入口。
     * 只要数字同源，就不算「同一屏说两遍」——那种问题是数字对不上。
     */
    const action =
      plan.focus === 'review'
        ? { label: '开始复习', onClick: onStartReview }
        : plan.focus === 'drill-weak'
          ? { label: '练薄弱', onClick: onDrillWeak ?? onStartReview }
          : plan.focus === 'learn-new'
            ? { label: '开始学新题', onClick: onLearnNew ?? onStartReview }
            : null;

    return (
      <div className="paper home-widget">
        <div className="paper__eyebrow">{title}</div>
        <div className="home-widget__plan">
          <div className="home-widget__big">{plan.due + plan.weak + plan.fresh}</div>
          <div className="home-widget__unit">题待学</div>
        </div>
        <ul className="home-widget__buckets">
          {plan.due > 0 ? (
            <li>
              <span className="home-widget__n">{plan.due}</span> 题到期
            </li>
          ) : null}
          {plan.weak > 0 ? (
            <li>
              <span className="home-widget__n">{plan.weak}</span> 题薄弱
            </li>
          ) : null}
          {plan.fresh > 0 ? (
            <li>
              <span className="home-widget__n">{plan.fresh}</span> 题没学过
            </li>
          ) : null}
          {plan.total > 0 && plan.due + plan.weak + plan.fresh === 0 ? (
            <li className="home-widget__done">今天的都练熟了</li>
          ) : null}
        </ul>
        {/*
          考试倒计时（2026-11-21，用户要求「后续可以通过小组件放在学习库首页」）。

          ## 只在真有未来考期时渲染

          `exam` 为 null 时**整行不出现** —— 不摆「距 -- 天」这类假行。
          用户没有设考期，这块区域就该只有「今天练多少」，
          多一行空壳会让人以为功能坏了（项目里「假开关」的教训）。

          ## 为什么放在这一张卡里，而不是新开一个小组件类型

          现在说的是「学什么、学多少」，考期回答的是「为什么现在要学这么多」。
          两句话在同一张卡里才读得通。新开一种组件类型意味着：
          `WidgetKind` 加一档、`DEFAULT_WIDGET_TITLE` 加一条、
          `HomeWidgetsEditor` 加一个可选项、`widgetsFromSettings` 兼容旧配置 ——
          而用户能得到的只是把这一行搬到另一张卡上。

          ## 话术

          「距 14 天」在纸面上读作副词，所以这里写成完整的一句：
          距离 + 考试名。今天考时说「今天」，不说「距 0 天」。
        */}
        {exam ? (
          <p
            className={`home-widget__exam${exam.daysLeft <= 1 ? ' home-widget__exam--soon' : ''}`}
          >
            <span className="home-widget__exam-n">
              {exam.daysLeft === 0 ? '今天' : `${exam.daysLeft} 天后`}
            </span>
            <span className="home-widget__exam-title" title={exam.title}>
              {exam.title}
            </span>
            <span>开考</span>
          </p>
        ) : null}
        {action ? (
          <button type="button" className="home-widget__go" onClick={action.onClick}>
            {action.label} →
          </button>
        ) : null}
      </div>
    );
  }

  if (widget.kind === 'quote') {
    /*
     * 用户自己写了内容（body 非空）就用他的；否则用「每日一句」。
     *
     * 每日一句支持远程（2026-11-08，用户要求联网）：
     * 由上层传进来的 `quote` 决定显示什么。上层的取法见 daily-quote.ts ——
     * **远程失败会静默回落到本地语料**，所以这里永远有东西可显示。
     *
     * 为什么不在这个组件里发请求：展示组件不该有副作用，
     * 而且首页每次重渲染都发一次请求会很难查。取数据放在上层。
     */
    const text = widget.body.trim() || quote?.text || pickDailyQuote();
    const author = widget.body.trim() ? null : (quote?.author ?? null);
    return (
      <div className="paper home-widget">
        <div className="paper__eyebrow">{title}</div>
        <p className="home-widget__quote">
          <MathText text={text} />
        </p>
        {author ? <p className="home-widget__author">—— {author}</p> : null}
      </div>
    );
  }

  if (widget.kind === 'text') {
    return (
      <div className="paper home-widget">
        <div className="paper__eyebrow">{title}</div>
        {widget.body.trim() ? (
          <p className="home-widget__text">
            <MathText text={widget.body} />
          </p>
        ) : (
          <p className="home-widget__empty">
            还没写内容。到「设置 → 首页小组件」里填一句。
          </p>
        )}
      </div>
    );
  }

  if (widget.kind === 'todo') {
    const pending = todos.filter((t) => !t.done).slice(0, 4);
    return (
      <div className="paper home-widget">
        <div className="paper__eyebrow">{title}</div>
        {pending.length === 0 ? (
          <p className="home-widget__empty">现在没有未完成的待办。</p>
        ) : (
          <ul className="home-widget__todos">
            {pending.map((t) => (
              <li key={t.id}>
                <span className="home-widget__dot" aria-hidden="true" />
                <span className="home-widget__todo-text">{t.title}</span>
                {t.dueAt ? <span className="home-widget__due">{t.dueAt.slice(5)}</span> : null}
              </li>
            ))}
          </ul>
        )}
        {onOpenTodos ? (
          <button type="button" className="home-widget__link" onClick={onOpenTodos}>
            全部待办 →
          </button>
        ) : null}
      </div>
    );
  }

  // focus
  return (
    <div className="paper home-widget">
      <div className="paper__eyebrow">{title}</div>
      <p className="home-widget__empty">一段 25 分钟的专注，从这里开始。</p>
      {onStartFocus ? (
        <button type="button" className="home-widget__go" onClick={onStartFocus}>
          开始专注 →
        </button>
      ) : null}
    </div>
  );
}

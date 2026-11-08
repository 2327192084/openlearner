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

import type { Todo } from '@/core/model.ts';
import {
  DEFAULT_WIDGET_TITLE,
  pickDailyQuote,
  type HomeWidget,
} from './home-widgets.ts';
import { MathText } from './MathText.tsx';

export interface HomeWidgetsProps {
  widgets: HomeWidget[];
  /** 待办小组件用：未完成的几件 */
  todos?: Todo[];
  /** 点「去待办」 */
  onOpenTodos?: () => void;
  /** 点番茄钟小组件 */
  onStartFocus?: () => void;
  /** 打开设置页去编辑这些小组件 */
  onOpenSettings?: () => void;
}

export function HomeWidgets({
  widgets,
  todos = [],
  onOpenTodos,
  onStartFocus,
  onOpenSettings,
}: HomeWidgetsProps) {
  return (
    <div className="home-widgets">
      {widgets.map((w) => (
        <WidgetCard
          key={w.id}
          widget={w}
          todos={todos}
          onOpenTodos={onOpenTodos}
          onStartFocus={onStartFocus}
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
  onOpenTodos,
  onStartFocus,
}: {
  widget: HomeWidget;
  todos: Todo[];
  onOpenTodos?: () => void;
  onStartFocus?: () => void;
}) {
  const title = widget.title.trim() || DEFAULT_WIDGET_TITLE[widget.kind];

  if (widget.kind === 'quote') {
    /*
     * 用户自己写了内容（body 非空）就用他的；否则用内置语料当天那句。
     * 这样「每日一句」既能自动换，也能被用户覆盖成自己想要的固定句子。
     */
    const text = widget.body.trim() || pickDailyQuote();
    return (
      <div className="paper home-widget">
        <div className="paper__eyebrow">{title}</div>
        <p className="home-widget__quote">
          <MathText text={text} />
        </p>
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

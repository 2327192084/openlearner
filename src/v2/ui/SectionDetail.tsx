/**
 * 小节详情面板（2026-11-22，树状地图第 5 步）。
 *
 * ## 用户确认过的口径（方案第一节的表格，不重新发明）
 *
 * | 问题 | 用户选择 |
 * |---|---|
 * | 每小节任务 | 网课/资料 + 闪卡 + 习题，三项做完算完成 |
 * | 完成判定 | **交给用户自己勾**，不做自动判定 |
 * | 额外任务 | 支持用户自定义 |
 *
 * 所以这个面板**不显示任何"你学得怎么样"的判断**，
 * 只有三行任务和一组用户自己加的任务。勾了就是完成。
 *
 * ## ⚠️ 为什么必须如实说"算不出来"
 *
 * 用户库「信号与系统」10 道题的锚点全失效（实测
 * `anchorMatchedToThisSource: 0`）。照常算会显示「0 道题」，
 * 用户会以为他一题都没做。
 *
 * 所以 `SectionStats` 有三态（见 `section-stats.ts`），
 * 这里三种文案分明。**stale 绝不显示成 0**。
 * 这与 `RouteBoard` 里已做的 `anchorHealth` 是同一套处理。
 *
 * ## 为什么面板里不直接改存储
 *
 * 与项目一贯分工一致：这一层是纯展示 + 回调，
 * 存储写入由 App 做（`onTasksChange` 往上抛）。
 */

import { useState } from 'react';
import type { ChapterNode, SectionNode, SectionTasks } from '@/v2/core/source-tree.ts';
import { isSectionDone } from '@/v2/core/source-tree.ts';
import { hasReal, statText, type SectionStats } from './section-stats.ts';
import type { SourceResource } from '@/v2/core/resource-store.ts';
import { ResourcePanel } from './ResourcePanel.tsx';
import { BindingPanel } from './BindingPanel.tsx';

export interface SectionDetailProps {
  section: SectionNode;
  chapter: ChapterNode;
  /** 统计；缺省时如实说"算不出来"，不显示 0 */
  stats?: SectionStats;
  onTasksChange?: (sectionId: string, next: SectionTasks) => void;
  onGoFlashcards?: (section: SectionNode) => void;
  onGoPractice?: (section: SectionNode) => void;
  onClose: () => void;
  /**
   * 挂在这一节上的外部资源（2026-11-22，方案第 7 步）。
   *
   * 与 `tasks.resources` 的区别：
   *  - `tasks.resources`：规划时随路线存下来的（只读展示）
   *  - 这里：**资料级资源表**里 sectionId 指向这一节的（可增删）
   *
   * 两者都在任务一里显示，但只有后者能编辑 —— 前者是 AI 给的，
   * 后者是用户自己的。分开是为了不让人误删 AI 搜来的依据。
   */
  resources?: readonly SourceResource[];
  onAddResource?: (r: SourceResource) => void;
  onRemoveResource?: (id: string) => void;
  /** 资料 id（新资源归属） */
  sourceId?: string;
  /*
   * 绑定闪卡/题组（2026-11-22）。
   *
   * 用户原话：
   * > 这个绑定资源功能主要是自动的，可以调用后端 ai 自主审查已有资源进行绑定，
   * > 但要留个给用户手工绑定的入口
   *
   * 自动绑定在建图时做（`autoBindTree`）。这里是**手工入口**：
   * 用户在详情里挑几张卡/几个题组绑到这一节。
   */
  bindings?: {
    /** 这一节已绑的闪卡 id */
    cardIds: readonly string[];
    /** 这一节已绑的题组 id */
    deckIds: readonly string[];
    /** 库里可选的全部闪卡（用于挑） */
    availableCards: readonly { id: string; front: string }[];
    /** 库里可选的全部题组 */
    availableDecks: readonly { id: string; title: string; questionCount: number }[];
    onChange: (next: { cardIds: string[]; deckIds: string[] }) => void;
  };
  /** 让 AI 帮我挑（手工入口里的辅助按钮）；不给就隐藏 */
  onAskAiBind?: () => void;
  aiBindBusy?: boolean;
  /** 用这一节正文生成闪卡（2026-11-22） */
  onGenerateCards?: () => void;
  generateCardsBusy?: boolean;
  /**
   * 跳页选取（2026-11-23，用户待办第 1 项）：把「加闪卡/加题组」
   * 从内嵌列表改成跳到功能页挑。不给就不显示跳转按钮。
   */
  onPickCards?: () => void;
  onPickDecks?: () => void;
}

export function SectionDetail(props: SectionDetailProps) {
  const {
    section,
    chapter,
    stats,
    onTasksChange,
    onGoFlashcards,
    onGoPractice,
    onClose,
    resources,
    onAddResource,
    onRemoveResource,
    sourceId,
    bindings,
    onAskAiBind,
    aiBindBusy,
    onGenerateCards,
    generateCardsBusy,
    onPickCards,
    onPickDecks,
  } = props;
  const [newTask, setNewTask] = useState('');

  const t = section.tasks;
  const done = isSectionDone(section);

  /** 改一项布尔 */
  const setFlag = (key: 'resourceDone' | 'flashcardsDone' | 'exerciseDone', value: boolean) => {
    onTasksChange?.(section.id, { ...t, [key]: value });
  };

  /** 加一条自定义任务 */
  const addCustom = () => {
    const text = newTask.trim();
    if (text.length === 0) return;
    onTasksChange?.(section.id, {
      ...t,
      custom: [
        ...t.custom,
        { id: 'cus_' + Math.random().toString(36).slice(2, 10), text, done: false },
      ],
    });
    setNewTask('');
  };

  const toggleCustom = (id: string) => {
    onTasksChange?.(section.id, {
      ...t,
      custom: t.custom.map((c) => (c.id === id ? { ...c, done: !c.done } : c)),
    });
  };

  const removeCustom = (id: string) => {
    onTasksChange?.(section.id, { ...t, custom: t.custom.filter((c) => c.id !== id) });
  };

  return (
    <section className="rsdetail">
      <header className="rsdetail__head">
        <div className="rsdetail__head-main">
          <span className="rsdetail__chapter">
            第 {chapter.number || '—'} 章 {chapter.title}
          </span>
          <h4 className="rsdetail__title">{section.title}</h4>
        </div>
        <button type="button" className="rsdetail__close" onClick={onClose} aria-label="关闭小节详情">
          ✕
        </button>
      </header>

      {/* 整章退化时如实说明 —— 别让它看起来像真的小节结构 */}
      {section.origin === 'whole-chapter' ? (
        <p className="rsdetail__note">
          这一章在正文里没有可用的标题结构（切不出两个以上小节），
          所以按<b>整章</b>来学。下面三项任务对整章生效。
        </p>
      ) : null}
      {section.origin === 'ai' ? (
        <p className="rsdetail__note">
          这一章的小节是 AI 按内容拆的（正文没有标题），可能和老师讲的顺序不完全一致。
        </p>
      ) : null}

      {/* ==================== 任务一：外部资料 ==================== */}
      <div className="rsdetail__task">
        <label className="rsdetail__task-head">
          <input
            type="checkbox"
            className="rsdetail__check"
            checked={t.resourceDone}
            onChange={(e) => setFlag('resourceDone', e.target.checked)}
          />
          <span className="rsdetail__task-num">1</span>
          <span className="rsdetail__task-name">看网课 / 查资料</span>
        </label>

        {/* 规划时随路线存下来的资源（只读 —— 那是 AI 给的依据，别让人误删） */}
        {t.resources.length > 0 ? (
          <ul className="rsdetail__res-list">
            {t.resources.map((r) => (
              <li key={r.id} className="rsdetail__res">
                <span className="rsdetail__res-title">{r.title}</span>
                <span className="rsdetail__res-src">
                  {r.source === 'search' ? '联网收集' : '人工整理'}
                </span>
                <span className="rsdetail__res-ro">规划时带的</span>
              </li>
            ))}
          </ul>
        ) : null}

        {/*
          * 用户自己加的资源（2026-11-22，方案第 7 步）。
          * 与小节详情同一位置 —— 用户在这一节看到的所有资料都在一起。
          */}
        {sourceId && resources && onAddResource && onRemoveResource ? (
          <div className="rsdetail__resources">
            <ResourcePanel
              sourceId={sourceId}
              sectionId={section.id}
              resources={resources}
              onAdd={onAddResource}
              onRemove={onRemoveResource}
              title="这一节的资料"
              emptyHint="还没有这一节专属的资料。可以加网课、文档、视频的链接。"
            />
          </div>
        ) : null}
      </div>

      {/* ==================== 任务二：闪卡 ==================== */}
      <div className="rsdetail__task">
        <label className="rsdetail__task-head">
          <input
            type="checkbox"
            className="rsdetail__check"
            checked={t.flashcardsDone}
            onChange={(e) => setFlag('flashcardsDone', e.target.checked)}
          />
          <span className="rsdetail__task-num">2</span>
          <span className="rsdetail__task-name">学完闪卡</span>
        </label>
        <div className="rsdetail__task-body">
          <span className="rsdetail__stat">
            {stats ? statText(stats.flashcards, '张卡') : '算不出来'}
            {/*
              * 来源标注（2026-11-22）：绑定 vs 自动反查。
              * 两者可信度不同，用户要知道这个数字是怎么来的。
              */}
            {stats?.origin === 'bound' && stats.boundCards > 0 ? (
              <span className="rsdetail__stat-src">（你绑定的）</span>
            ) : stats?.origin === 'auto' ? (
              <span className="rsdetail__stat-src">（按原文出处自动找到的）</span>
            ) : null}
          </span>
          {stats && hasReal(stats.flashcards) && onGoFlashcards ? (
            <button
              type="button"
              className="btn-ghost btn-ghost--sm"
              onClick={() => onGoFlashcards(section)}
            >
              去学这些卡 →
            </button>
          ) : null}
        </div>
      </div>

      {/* ==================== 任务三：习题 ==================== */}
      <div className="rsdetail__task">
        <label className="rsdetail__task-head">
          <input
            type="checkbox"
            className="rsdetail__check"
            checked={t.exerciseDone}
            onChange={(e) => setFlag('exerciseDone', e.target.checked)}
          />
          <span className="rsdetail__task-num">3</span>
          <span className="rsdetail__task-name">做完习题</span>
        </label>
        <div className="rsdetail__task-body">
          <span className="rsdetail__stat">
            {stats ? statText(stats.questions, '道题') : '算不出来'}
            {stats?.origin === 'bound' && stats.boundDecks > 0 ? (
              <span className="rsdetail__stat-src">
                （{stats.boundDecks} 个题组，你绑定的）
              </span>
            ) : null}
          </span>

          {/*
           * ⚠️ 锚点失效时如实解释原因（用户库真实存在的情形）。
           * 不显示「0 道题」让他以为没做过。
           *
           * 文案只写在这里一处：`statText` 已经说了「10 道题，但原文
           * 出处已失效」，下面这点补充说清**为什么**和**还能不能做**。
           * 原来两处都把"失效"说了一遍，读起来重复。
           */}
          {stats?.questions.kind === 'stale' ? (
            <span className="rsdetail__stat-why">
              重新整理知识点时换过段落，题目的锚点没跟着更新，所以算不出这一节有几道。
              题本身还在，去「做题」里能看到。
            </span>
          ) : null}

          {stats && hasReal(stats.questions) && onGoPractice ? (
            <button
              type="button"
              className="btn-ghost btn-ghost--sm"
              onClick={() => onGoPractice(section)}
            >
              去练这些题 →
            </button>
          ) : null}
        </div>
      </div>

      {/* ==================== 绑定闪卡 / 题组（2026-11-22） ==================== */}
      {bindings ? (
        <div className="rsdetail__task">
          <div className="rsdetail__custom-head">
            <span className="rsdetail__task-name">这一节用哪些卡和题</span>
            <span className="rsdetail__hint-inline">（AI 自动绑，也可以自己改）</span>
          </div>
          <BindingPanel
            cardIds={bindings.cardIds}
            deckIds={bindings.deckIds}
            availableCards={bindings.availableCards}
            availableDecks={bindings.availableDecks}
            onChange={bindings.onChange}
            {...(onAskAiBind ? { onAskAi: onAskAiBind } : {})}
            {...(aiBindBusy !== undefined ? { aiBusy: aiBindBusy } : {})}
            {...(onGenerateCards ? { onGenerateCards } : {})}
            {...(generateCardsBusy !== undefined ? { generateBusy: generateCardsBusy } : {})}
            {...(onPickCards ? { onPickCards } : {})}
            {...(onPickDecks ? { onPickDecks } : {})}
          />
        </div>
      ) : null}

      {/* ==================== 自定义任务 ==================== */}
      <div className="rsdetail__task rsdetail__task--custom">
        <div className="rsdetail__custom-head">
          <span className="rsdetail__task-name">我自己加的</span>
          <span className="rsdetail__hint-inline">（勾完才算这一节完成）</span>
        </div>

        {t.custom.length > 0 ? (
          <ul className="rsdetail__custom-list">
            {t.custom.map((c) => (
              <li key={c.id} className={'rsdetail__custom' + (c.done ? ' rsdetail__custom--done' : '')}>
                <label className="rsdetail__custom-label">
                  <input
                    type="checkbox"
                    className="rsdetail__check"
                    checked={c.done}
                    onChange={() => toggleCustom(c.id)}
                  />
                  <span className="rsdetail__custom-text">{c.text}</span>
                </label>
                <button
                  type="button"
                  className="rsdetail__custom-del"
                  onClick={() => removeCustom(c.id)}
                  aria-label={`删除任务「${c.text}」`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="rsdetail__add">
          <input
            className="rsdetail__add-input"
            type="text"
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addCustom();
              }
            }}
            placeholder="如：把这节的例题手推一遍"
            aria-label="新任务内容"
          />
          <button
            type="button"
            className="btn-ghost btn-ghost--sm"
            onClick={addCustom}
            disabled={newTask.trim().length === 0}
          >
            + 加一条
          </button>
        </div>
      </div>

      {/* ==================== 完成汇总 ==================== */}
      <footer className={'rsdetail__foot' + (done ? ' rsdetail__foot--done' : '')}>
        {done ? (
          <>这一节完成了 ✓ <span className="rsdetail__foot-why">（你自己勾满的，不是系统猜的）</span></>
        ) : (
          <>
            还差
            {' '}
            {[
              !t.resourceDone ? '任务一' : null,
              !t.flashcardsDone ? '任务二' : null,
              !t.exerciseDone ? '任务三' : null,
              t.custom.some((c) => !c.done) ? `${t.custom.filter((c) => !c.done).length} 条自定义任务` : null,
            ]
              .filter(Boolean)
              .join('、')}
          </>
        )}
      </footer>
    </section>
  );
}
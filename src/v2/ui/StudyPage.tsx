import { useCallback, useEffect, useState } from 'react';
import type { ReviewService } from '@/v2/core/review-service.ts';
import { IconBook, IconGenerate, IconStats, IconWrongbook } from './icons.tsx';

/**
 * 「开始学习」导览页 —— 点顶部按钮后先到这里，再选干什么。
 *
 * ## 为什么需要这一层
 *
 * 原来点「开始学习」直接掉进做题界面（复习队列），用户没有选择权：
 * 想先把知识点过一遍、或者想专门刷错题，都得另找入口。
 * 现在这一页把「学什么」摊开成四件事，用户自己挑。
 *
 * ## 四个选项的现状（如实标注，不摆假按钮）
 *
 * | 选项 | 状态 |
 * | --- | --- |
 * | 开始做题 | ✅ 真能跳去做题 |
 * | 学习知识 | 🚧 按钮在，功能后续补 |
 * | 开始复习 | 🚧 按钮在，功能后续补 |
 * | 错题闪卡 | 🚧 按钮在，功能后续补 |
 *
 * 三个未做的**不伪装成可用**：点了会明说「还没做」，并说明现在能用什么。
 * 这符合项目一贯的规矩（不做的功能就明说，不摆点了没反应的按钮）。
 */

export interface StudyPageProps {
  service: ReviewService;
  /** 去做题（复习队列） */
  onStartQuiz: () => void;
  /** 去我的题组（挑题组做） */
  onOpenDecks: () => void;
  /** 当前题库里有到期卡片吗 —— 用来决定「开始做题」旁边的提示 */
  dueCount: number | null;
}

type OptionId = 'knowledge' | 'quiz' | 'review' | 'wrong';

interface Option {
  id: OptionId;
  title: string;
  desc: string;
  /** 能不能真的用 */
  ready: boolean;
  /** 与 icons.tsx 的 IconProps 对齐：都接受 size / className */
  icon: (p: { size?: number; className?: string }) => React.ReactElement;
}

const OPTIONS: Option[] = [
  {
    id: 'knowledge',
    title: '学习知识',
    desc: '把整理好的知识点一条条过一遍，看原文出处',
    ready: false,
    icon: IconBook,
  },
  {
    id: 'quiz',
    title: '开始做题',
    desc: '做题库里已发布的题；每道题都能点回原文那一页',
    ready: true,
    icon: IconGenerate,
  },
  {
    id: 'review',
    title: '开始复习',
    desc: '按遗忘曲线，只做今天该复习的卡片',
    ready: false,
    icon: IconStats,
  },
  {
    id: 'wrong',
    title: '错题闪卡',
    desc: '专门刷做错过的题，直到它们不再错',
    ready: false,
    icon: IconWrongbook,
  },
];

export function StudyPage({ service, onStartQuiz, onOpenDecks, dueCount }: StudyPageProps) {
  const [overview, setOverview] = useState<{
    due: number;
    learnable: number;
    doneToday: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const o = await service.todayOverview([]);
      setOverview({ due: o.dueCount, learnable: o.freshCount, doneToday: o.doneToday });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不出今天的学习情况');
    }
  }, [service]);

  useEffect(() => {
    void load();
  }, [load]);

  function pick(opt: Option) {
    if (opt.id === 'quiz') {
      onStartQuiz();
      return;
    }
    /*
     * 还没做的三样：**不跳转**，就地说明。
     * 跳到一个占位页再让用户退回来是更差的选择 —— 那等于骗了他一次。
     */
    setNotice(`「${opt.title}」还没做。现在能用的是「开始做题」和「我的题组」。`);
  }

  const due = dueCount ?? overview?.due ?? null;

  return (
    <div className="study-page">
      <header className="study-head">
        <h1 className="study-title">开始学习</h1>
        <p className="study-lead">先选一件事做。四种都在这里，不用去别处找。</p>
      </header>

      {error ? <div className="study-error">{error}</div> : null}
      {notice ? (
        <div className="study-notice" role="status">
          {notice}
        </div>
      ) : null}

      <div className="study-options">
        {OPTIONS.map((opt) => {
          const Icon = opt.icon;
          const isQuiz = opt.id === 'quiz';
          return (
            <button
              key={opt.id}
              type="button"
              className={`study-option${isQuiz ? ' study-option--primary' : ''}${
                opt.ready ? '' : ' study-option--soon'
              }`}
              onClick={() => pick(opt)}
              aria-disabled={!opt.ready}
            >
              <span className="study-option__icon" aria-hidden="true">
                <Icon size={22} />
              </span>
              <span className="study-option__text">
                <span className="study-option__title">
                  {opt.title}
                  {opt.ready ? null : <span className="study-option__badge">还没做</span>}
                </span>
                <span className="study-option__desc">{opt.desc}</span>
                {/* 只有做题这一项带实时数字 —— 用户最关心的就是这个 */}
                {isQuiz && due !== null ? (
                  <span className="study-option__meta">
                    {due > 0 ? `今天有 ${due} 张卡片可以做` : '今天暂时没有到期卡片，也可以自己挑题组做'}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>

      <p className="study-hint">
        做题时每道题都带原文出处，答错也能点回去看。
        <button type="button" className="btn-text study-hint__link" onClick={onOpenDecks}>
          去「我的题组」挑题
        </button>
      </p>
    </div>
  );
}

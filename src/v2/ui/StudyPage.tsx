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
  /**
   * 题库里所有卡的 id（用于统计「今天有多少可以做」）。
   *
   * 不传就会算出 0 —— `todayOverview` 只统计池子里的卡，
   * 传空数组等于告诉它「一张卡都没有」。
   */
  cardPool?: readonly string[];
  /** 去做题（复习队列） */
  onStartQuiz: () => void;
  /**
   * 去「复习巩固」栏目（2026-11-13 深夜改）。
   *
   * 原来是 `onStartReview: () => boolean` —— 点了就地起一轮翻面复习。
   * 用户要求改成「跳转到复习巩固栏目的按钮」，因为那个翻面界面
   * 与新的闪卡功能在交互上撞车了。
   *
   * 不再返回 boolean：带路不需要知道「今天有没有到期」，
   * 那个判断挪回复习巩固页自己去说。
   */
  onOpenReviewBook: () => void;
  /** 去「闪卡管理」页（2026-11-13 深夜新增） */
  onOpenFlashcards: () => void;
  /** 去知识库看知识点 */
  onOpenKnowledge: () => void;
  /** 去我的题组（挑题组做） */
  onOpenDecks: () => void;
  /** 当前题库里有到期卡片吗 —— 用来决定「开始做题」旁边的提示 */
  dueCount: number | null;
}

type OptionId = 'knowledge' | 'quiz' | 'review' | 'flashcards';

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
    /*
     * 措辞按实际能力写（2026-11-08 修）。
     *
     * 原文是「把整理好的知识点一条条过一遍」，但点了去的是**知识库列表** ——
     * 按文件归类、能搜、能点回原文，并不是「一条条过」的浏览流。
     * 一句做不到的承诺比不说更糟：用户会以为有个逐条学习的功能，找不到。
     *
     * 逐条过的浏览流确实还没做。要做的话是另一件事（带「下一条」、
     * 记忆进度），不是改这句话能解决的。所以这里先把话说准。
     */
    desc: '按文件翻看整理好的知识点，能搜、能点回原文那一页',
    ready: true,
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
    desc: '去复习巩固：按遗忘曲线，只做今天该复习的',
    /*
     * 2026-11-13 深夜按用户要求改：**不再直接起一轮翻面复习**，
     * 改成跳转到「复习巩固」栏目。
     *
     * 用户原话：「开始复习功能不用这种翻面闪卡样式了，
     * 就做成一个跳转到复习巩固栏目的按钮吧」。
     *
     * 那个「翻面 + 1-4 自评」的界面（ReviewToday）本来就是照着
     * Anki 闪卡做的，和下面要做的「闪卡」在交互上撞车 ——
     * 用户明确区分：复习该是「去那一页看」，闪卡才是翻面。
     *
     * 因此这一项现在与「开始做题」一样只是导航，不再自己判断
     * 「今天有没有到期」；那个数字由复习巩固页自己说明。
     */
    ready: true,
    icon: IconStats,
  },
  {
    /*
     * 「错题闪卡」改名并移出这一页（2026-11-13 深夜）。
     *
     * 用户原话：「错题闪卡改名为闪卡管理。然后在课程准备与管理的
     * 栏目下新开一个闪卡管理栏目」。
     *
     * 它现在是一个独立页面（侧栏「课程准备与管理 → 闪卡管理」），
     * 不再挤在「开始学习」这四个「今天做什么」的选项里 ——
     * 管理闪卡不是「今天学什么」，放这里名不副实。
     */
    id: 'flashcards',
    title: '闪卡管理',
    desc: '统一管知识点闪卡与错题闪卡',
    ready: true,
    icon: IconWrongbook,
  },
];

export function StudyPage({
  service,
  cardPool,
  onStartQuiz,
  onOpenReviewBook,
  onOpenFlashcards,
  onOpenKnowledge,
  onOpenDecks,
  dueCount,
}: StudyPageProps) {
  const [overview, setOverview] = useState<{
    /** 到期且有复习记录的卡 */
    due: number;
    /** 还没做过的新卡 */
    fresh: number;
    /** 池子里一共多少张 */
    total: number;
    doneToday: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      /*
       * 必须传真实卡片池。传 [] 时 todayOverview 一个卡都不会数，
       * 于是「今天有 N 张可以做」永远是 0 —— 而题库里明明有题。
       */
      const o = await service.todayOverview(cardPool ?? []);
      setOverview({
        due: o.dueCount,
        fresh: o.freshCount,
        total: o.totalCards,
        doneToday: o.doneToday,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读不出今天的学习情况');
    }
  }, [service, cardPool]);

  useEffect(() => {
    void load();
  }, [load]);

  function pick(opt: Option) {
    if (opt.id === 'quiz') {
      onStartQuiz();
      return;
    }
    if (opt.id === 'review') {
      /*
       * 「开始复习」= 跳到「复习巩固」栏目（2026-11-13 深夜改）。
       *
       * 用户原话：「开始复习功能不用这种翻面闪卡样式了，
       * 就做成一个跳转到复习巩固栏目的按钮吧」。
       *
       * 所以这里不再起一轮翻面复习、也不再自己判断「今天有没有到期」——
       * 那两件事都由复习巩固页负责，用户到了那一页能看见到期数、
       * 能自己决定是做今日复习还是自测。这里只负责带路。
       */
      onOpenReviewBook();
      return;
    }
    if (opt.id === 'knowledge') {
      onOpenKnowledge();
      return;
    }
    if (opt.id === 'flashcards') {
      onOpenFlashcards();
      return;
    }
    /*
     * 兜底：出现没接好入口的新选项时**不假装能点**，就地说明。
     * 跳到一个占位页再让用户退回来是更差的选择 —— 那等于骗了他一次。
     */
    setNotice(`「${opt.title}」还没接好入口。`);
  }

  /*
   * 可以做 = 到期的 + 还没做过的新卡。
   *
   * dueCount 只统计**已有复习记录且到期**的卡；
   * 从来没做过的新卡算在 freshCount 里。只看 dueCount 会让
   * 「题库里有 2 道新题」被显示成「今天没有卡片」。
   */
  const available =
    overview !== null ? overview.due + overview.fresh : dueCount ?? null;

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
                {isQuiz && available !== null ? (
                  <span className="study-option__meta">
                    {available > 0
                      ? `题库里有 ${available} 道题可以做`
                      : '题库里还没有可做的题，先到「我的题组」发布一个题组'}
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

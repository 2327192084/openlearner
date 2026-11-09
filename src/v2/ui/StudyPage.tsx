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
   * 开始复习：直接进「今日到期」队列（2026-11-09 加）。
   *
   * 返回 true 表示真的开始了；false 表示今天没有到期的卡，
   * 调用方（本页）据此就地说明，而不是跳到一个空界面。
   *
   * 为什么需要它与 onStartQuiz 分开：
   * 原来两者都只跳选题页，用户看不出区别 —— 那等于复习功能不存在。
   */
  onStartReview: () => boolean;
  /** 去知识库看知识点 */
  onOpenKnowledge: () => void;
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
    desc: '按遗忘曲线，只做今天该复习的卡片',
    /*
     * 2026-11-09 修：这个按钮以前和「开始做题」跳同一个页面，
     * 等于复习功能不存在（用户实测指出）。现在它直接进「今日到期」
     * 队列，跳过选题页 —— 两个按钮的行为真正分开了。
     *
     * 判据也不再是「点进去看看」：这里读 overview.due，
     * 今天没有到期的卡就当场说明，不跳空页面。
     */
    ready: true,
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

export function StudyPage({
  service,
  cardPool,
  onStartQuiz,
  onStartReview,
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
       * 「开始复习」真的按遗忘曲线开始，不再借道选题页（2026-11-09）。
       *
       * 返回 false = 今天没有到期的卡。这时**不跳转**，就地说明，
       * 并给出下一步（去做题 / 去看知识点）—— 不做「跳过去看到空白」。
       */
      const started = onStartReview();
      if (!started) {
        setNotice(
          overview && overview.fresh > 0
            ? `今天没有到期的卡。题库里还有 ${overview.fresh} 道没做过，去「开始做题」挑一组。`
            : '今天没有到期的卡，题库里也没有新题。先去「资料」导入内容或整理知识点。',
        );
      }
      return;
    }
    if (opt.id === 'knowledge') {
      onOpenKnowledge();
      return;
    }
    /*
     * 还没做的三样：**不跳转**，就地说明。
     * 跳到一个占位页再让用户退回来是更差的选择 —— 那等于骗了他一次。
     */
    setNotice(`「${opt.title}」还没做。现在能用的是「开始做题」和「我的题组」。`);
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

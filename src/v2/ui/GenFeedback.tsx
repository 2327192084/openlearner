import type { QuestionKind } from '@/core/model.ts';
import { kindLabel } from '@/core/questions/kinds.ts';
import { COGNITIVE_LEVEL_LABEL } from '@/core/cognitive-levels.ts';
import type { GenerateQuestionsOutput } from '@/core/questions/service.ts';

/**
 * 出题反馈条：进行中 / 失败 / 成功。
 *
 * ## 为什么要抽成独立文件（2026-11-13）
 *
 * 用户报的原话是「变式出题还有一个问题是点击出题按钮后没有题出现，
 * 无论有没有产出都没有任何反馈」。
 *
 * 根因不是出题坏了，而是**反馈块挂错了地方**：出错提示和成功提示
 * 原来都写在「用资料出题」那块表单里面（`{mode === 'from-source' ? ... : null}`
 * 内部），而变式模式下那块根本不渲染 —— 用户点了「开始变式」，
 * 无论成功失败，界面上一个字都不会变，看起来就是假按钮。
 *
 * 现在把它挪到所有模式共用的位置，并加上「进行中」这一态：
 * 模型一次要跑十几秒到一分钟，只把按钮文字改成「正在生成…」太弱，
 * 用户不知道到底在跑还是卡死了。
 *
 * 放在独立文件而不是塞进 GeneratePage：那个文件已经 940 行，
 * 项目对「往大文件里插代码」有过教训。
 */

export interface GenProgress {
  /** 已经落库拿到手的题数 */
  produced: number;
  /** 这一批打算出多少 */
  total: number;
}

export interface GenDone {
  deck: string;
  deckId: string;
  questions: number;
  /** 实际出了哪些题型（用于如实告知「你勾的里有几种没出成」） */
  kinds: Record<string, number>;
  /**
   * 认知层级筛选的实际结果（2026-11-19）。
   *
   * 勾了层级、而那一层没有素材时，服务层会退回全部素材并把这件事报上来。
   * 不显示的话，用户会以为「只出 apply 层」生效了，实际拿到的题散在各层 ——
   * 那是和「勾了没反应」一样的假开关，只是更难发现。
   *
   * null（没勾层级）时不显示任何东西。
   */
  levelFilter?: GenerateQuestionsOutput['levelFilter'];
}

export interface GenFeedbackProps {
  busy: boolean;
  progress: GenProgress | null;
  error: string | null;
  errorHint: string | null;
  done: GenDone | null;
  /** 用户勾选的题型，用来算「哪几种没出成」 */
  kinds: QuestionKind[];
  onOpenDecks: (deckId: string) => void;
}

export function GenFeedback({
  busy,
  progress,
  error,
  errorHint,
  done,
  kinds,
  onOpenDecks,
}: GenFeedbackProps) {
  /*
   * 三样都没有就整块不渲染。
   * 否则会留下一个空的 div 把下面的表单推下去一段空白。
   */
  if (!busy && !error && !done) return null;

  return (
    <div className="gen-feedback" aria-live="polite">
      {/*
        进行中：先给一句「在跑」，再给已经出来的题数。
        没有这一条，用户只能盯着没变化的按钮猜。
      */}
      {busy ? (
        <div className="gen-progress" role="status" aria-live="polite">
          {progress && progress.produced > 0 ? (
            <>
              正在出题… 已经出来 {progress.produced} 道
              {progress.total > 0 ? `（计划 ${progress.total} 道）` : ''}
            </>
          ) : (
            <>正在等模型回话… 通常要十几秒到一分钟，别关这个页面。</>
          )}
        </div>
      ) : null}

      {error ? (
        <div className="gen-error">
          <span>{error}</span>
          {errorHint ? <span className="gen-error__hint">{errorHint}</span> : null}
        </div>
      ) : null}

      {done ? (
        <div className="gen-done">
          <p className="gen-done__text">
            ✓ 已生成「{done.deck}」，共 {done.questions} 道题。
          </p>
          {/*
            如实列出「实际出了哪些题型」。
            为什么必须有这段：勾了三种题型，模型可能只给出两种 ——
            不说的话用户以为都生效了，去列表里才发现少了。
            这是本项目反复强调的「不撒谎」在生成结果上的体现。
          */}
          <p className="gen-done__kinds">
            实际题型：
            {Object.entries(done.kinds)
              .map(([k, n]) => `${kindLabel(k)} ${n} 道`)
              .join(' · ')}
            {(() => {
              const missing = kinds.filter((k) => !done.kinds[k]);
              if (missing.length === 0) return null;
              return (
                <span className="gen-done__missing">
                  （{missing.map(kindLabel).join('、')} 这次没出成 ——
                  模型不一定每次都按要求分配题型，可以再生成一次）
                </span>
              );
            })()}
          </p>
          {/*
            认知层级筛选的结果（2026-11-19）。
            与上面「实际题型」同一个理由：勾了什么、实际用了什么，必须对得上。
          */}
          {done.levelFilter?.fellBack ? (
            <p className="gen-done__missing">
              你只勾了
              {done.levelFilter.requested.map((l) => COGNITIVE_LEVEL_LABEL[l]).join('、')}
              层，但这次的素材里一条都不属于这一层 —— 已退回用全部素材出题，
              所以这次的题可能包含其他层级。想只要这一层，得先整理出这一层的知识点。
            </p>
          ) : done.levelFilter ? (
            <p className="gen-done__hint">
              已按认知层级筛选：只用了
              {done.levelFilter.requested.map((l) => COGNITIVE_LEVEL_LABEL[l]).join('、')}
              层的 {done.levelFilter.used} 条素材。
            </p>
          ) : null}
          {/*
            说清「待审核 vs 已发布」——生成出来是待审核，要先检查再发布才进复习。
            原来只写「可以去复习里做了」，而当时题组是待审核、界面又没有题组列表，
            用户照着做只会扑空。
          */}
          <p className="gen-done__hint">
            它现在是<strong>待审核</strong>，先检查一遍题，发布之后才会进入复习。
          </p>
          {done.questions > 0 ? (
            <button
              type="button"
              className="btn-fill btn-fill--sm"
              onClick={() => onOpenDecks(done.deckId)}
            >
              去看这 {done.questions} 道题
            </button>
          ) : (
            /*
              一道题都没出成：不给「去看这 0 道题」这种死按钮。
              模型这一批没解析出题是真实会发生的情况，必须说清楚而不是装作成功。
            */
            <p className="gen-done__hint">
              这一批一道题都没出成，题组是空的。可以再点一次，或者换个题型/范围。
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

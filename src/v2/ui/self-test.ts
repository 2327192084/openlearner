/**
 * 复习巩固页的「自测」状态机（2026-11-09）。
 *
 * ## 为什么需要这一层
 *
 * 这一页原来只是**读**：题目、答案、解析都摊在那里。
 * 但「读一遍」和「考自己一遍」对记忆的效果差得很远
 * （测试效应 / retrieval practice，项目里已引过这个结论）。
 *
 * 所以加一个「遮住答案、逐题作答」的模式。状态逻辑抽成纯函数：
 * 它决定「这题算对了吗」「下一题去哪」这类**容易写错又难肉眼发现**
 * 的东西 —— 比如多选题顺序不同应当算对，填空的引号空格应当忽略。
 *
 * ## 与做题页的区别
 *
 * 做题页（PracticePage / ReviewPage）会**写复习记录**、影响间隔安排。
 * 这里的自测是**就地翻看**，不写任何数据：
 * 用户在书里随手过一遍，不该改变他真实的学习进度。
 * 这也让它可以随时进入、随时退出，没有「做完这一轮」的压力。
 */

import type { Question } from '@/core/model.ts';

/** 一次自测的作答 */
export interface SelfTestAnswer {
  questionId: string;
  /** 用户的原始输入（选择题是选项 key，填空/问答是文本） */
  raw: string;
  /** 判对了吗。问答题为 null（需自评） */
  correct: boolean | null;
}

/** 自测会话状态 */
export interface SelfTestState {
  /** 正在自测的题目 id 顺序 */
  queue: string[];
  /** 当前第几题（0 基） */
  index: number;
  /** 已作答的记录 */
  answers: Record<string, SelfTestAnswer>;
}

/** 新建一个自测会话 */
export function startSelfTest(questionIds: readonly string[]): SelfTestState {
  return { queue: [...questionIds], index: 0, answers: {} };
}

/**
 * 归一化答案文本，用于比较。
 *
 * 必须做的事（都是实际会遇到的）：
 *  - 去首尾空白、全角转半角标点、大小写不敏感
 *  - 去掉常见包裹标点：用户抄答案时爱加引号/句号
 *  - 折叠内部多余空白
 *
 * **不做**的事：同义词、数字格式换算、单位换算 ——
 * 那属于判分语义，做错会误判成「你答对了」，比不判更糟。
 */
export function normalizeAnswer(raw: string): string {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  /* 全角 → 半角（常见标点与字母数字） */
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/\u3000/g, ' ');
  s = s.toLowerCase();

  /*
   * 去掉**成对**包裹的引号/括号。
   *
   * ⚠️ 不能左右各用一条独立的正则：那样 `(信号)` 会把开括号和闭括号
   * 各自剥掉。但 `(a)(b)` 这种不该被剥成 `a)(b`。
   * 所以要求成对：先试「以某开符开头且以对应闭符结尾」。
   *
   * 只管引号与方头括号；**不剥圆括号**——圆括号在数学表达里是正文的一部分
   * （`f(x)`、`(n+1)`），剥掉会把不同答案判成同一个。
   */
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['「', '」'],
    ['『', '』'],
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of pairs) {
      if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
        s = s.slice(open.length, s.length - close.length).trim();
        changed = true;
      }
    }
  }

  /* 去掉句末标点（只去末尾，不去中间 —— 中间的点是正文） */
  s = s.replace(/[。．.，,；;：:！!？?]+$/, '');
  /* 折叠空白 */
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * 判定一道题答得对不对。
 *
 * 返回 null = 无法自动判定（问答题），界面要给「我答对了 / 我答错了」
 * 两个按钮让用户自评 —— 不猜，也不默认算对。
 */
export function judgeAnswer(question: Question, raw: string): boolean | null {
  const input = normalizeAnswer(raw);

  /*
   * 问答题先返回 null，再判空。
   *
   * 顺序很重要：如果先判空，用户点开一道还没作答的问答题就会看到
   * 「错」—— 而他只是还没开始写。null 表示「等你自己说」。
   */
  if (question.kind === 'essay') return null;

  if (!input) return false;

  switch (question.kind) {
    case 'single': {
      const want = normalizeAnswer(question.answer);
      return input === want;
    }
    case 'multiple': {
      /*
       * 多选题：把两边都拆成集合比较。
       * 顺序不同应当算对 —— 用户勾「C,A」和「A,C」是同一件事。
       */
      const want = splitKeys(question.answer);
      const got = splitKeys(raw);
      if (want.length === 0 || got.length === 0) return false;
      const ws = new Set(want);
      const gs = new Set(got);
      if (ws.size !== gs.size) return false;
      for (const k of ws) if (!gs.has(k)) return false;
      return true;
    }
    case 'truefalse': {
      /*
       * 判断题：选项 key 固定 T / F（见 model.ts 的 QuestionKind 注释）。
       * 用户可能勾选项，也可能自己敲「对/错」「是/否」—— 都要认，
       * 否则判断题会被判得一塌糊涂而用户以为自己记错了。
       */
      const want = normalizeTf(question.answer);
      const got = normalizeTf(raw);
      if (!want || !got) return false;
      return want === got;
    }
    case 'blank': {
      const want = normalizeAnswer(question.answer);
      return input === want;
    }
    default:
      return null;
  }
}

/**
 * 把判断题的答案归一成 'T' / 'F'。
 *
 * 认这些写法（都是实际会遇到的）：T/F、True/False、对/错、
 * 正确/错误、是/否、√/×、1/0。
 * 认不出返回空串 —— 那就判 false，而不是猜一个。
 */
function normalizeTf(raw: string): 'T' | 'F' | '' {
  const s = normalizeAnswer(raw);
  if (!s) return '';
  if (['t', 'true', '对', '正确', '是', '√', '1'].includes(s)) return 'T';
  if (['f', 'false', '错', '错误', '否', '×', 'x', '0'].includes(s)) return 'F';
  return '';
}

/** 把 "A,C" / "A C" / "ac" 拆成大写 key 列表 */
function splitKeys(raw: string): string[] {
  return raw
    .split(/[,，\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

/** 记录一次作答并返回新状态 */
export function answerQuestion(
  state: SelfTestState,
  question: Question,
  raw: string,
): SelfTestState {
  const correct = judgeAnswer(question, raw);
  return {
    ...state,
    answers: { ...state.answers, [question.id]: { questionId: question.id, raw, correct } },
  };
}

/** 手动改判（问答自评，或用户纠正自动判定） */
export function overrideAnswer(
  state: SelfTestState,
  questionId: string,
  correct: boolean,
): SelfTestState {
  const prev = state.answers[questionId];
  if (!prev) return state;
  return {
    ...state,
    answers: { ...state.answers, [questionId]: { ...prev, correct } },
  };
}

/** 下一题；已是最后一题返回 false（不改状态） */
export function nextQuestion(state: SelfTestState): SelfTestState | null {
  if (state.index >= state.queue.length - 1) return null;
  return { ...state, index: state.index + 1 };
}

/** 上一题；已是第一题返回 null */
export function prevQuestion(state: SelfTestState): SelfTestState | null {
  if (state.index <= 0) return null;
  return { ...state, index: state.index - 1 };
}

/** 自测统计 */
export interface SelfTestScore {
  /** 已作答的题数 */
  answered: number;
  /** 其中自动/自评判对的 */
  correct: number;
  /** 判错的 */
  wrong: number;
  /** 还没作答的 */
  unanswered: number;
  /** 正确率（0~1）。没作答时为 null —— 不显示 0% 那种假数据 */
  accuracy: number | null;
}

export function selfTestScore(state: SelfTestState): SelfTestScore {
  let answered = 0;
  let correct = 0;
  let wrong = 0;
  for (const id of state.queue) {
    const a = state.answers[id];
    if (!a) continue;
    answered += 1;
    if (a.correct === true) correct += 1;
    else if (a.correct === false) wrong += 1;
    /* correct === null（待自评）既不算对也不算错 */
  }
  return {
    answered,
    correct,
    wrong,
    unanswered: state.queue.length - answered,
    accuracy: answered > 0 && correct + wrong > 0 ? correct / (correct + wrong) : null,
  };
}

/** 当前该显示的题 id；队列空则为 null */
export function currentQuestionId(state: SelfTestState): string | null {
  if (state.queue.length === 0) return null;
  return state.queue[state.index] ?? null;
}

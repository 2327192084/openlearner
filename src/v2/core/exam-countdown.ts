/**
 * 考期倒计时：从待办里挑出「最近一场还没过的考试」。
 *
 * ## 为什么考试归待办，不归学习地图
 *
 * 用户原话（2026-11-21）：
 *
 * > 考期这个概念可以和已有的待办功能融合
 * > 学习库页面不是有插件功能吗？可以放在待办那，后续可以通过小组件放在学习库首页
 *
 * 考期和待办本来就同形：一个名字、一个日期、做完了打勾。
 * 待办页已经有添加、勾选、截止日、优先级、标签 —— 另起一张表意味着
 * 同一个日期要在两处各维护一遍，两个界面上的「距考试几天」迟早对不上。
 * 项目反复踩过「同一屏的两组数字来自不同池子」这类坑（见 `study-map.ts`
 * 的文件头），所以这里直接复用待办：`Todo.isExam === true` 就是考期。
 *
 * ## 为什么是纯函数、不在这里读库
 *
 * 现在有两个地方要用它：待办页的列表徽标、首页「今日学习」小组件里的
 * 倒计时行。如果各自 `await storage.getAll('todos')` 一遍，就会：
 *  - 同一个页面里出现两次异步读，数字可能落在两次快照上（对不上）
 *  - 组件里带 side effect，测试只能靠渲染整棵树
 * 所以这里只收一个数组，出参是个普通对象。上层读一次库，传给需要的人。
 *
 * ## 为什么差几天不用 `Date` 相减
 *
 * `(new Date(b) - new Date(a)) / 86400000` 在两种情况下会错：
 *  - 跨夏令时的日期差 23 或 25 小时，除下来是 0.96 / 1.04 天，
 *    `Math.round` 能兜住一半，但 `Math.floor` 会整整差一天
 *  - `new Date('YYYY-MM-DD')` 按 **UTC** 解析，再取本地日期字段时
 *    在西半球会退到前一天
 *
 * 这里照 `srs.ts` 的做法：把 `YYYY-MM-DD` 解析成「自 epoch 起的天序号」
 * （`Date.UTC` 只用来算这个整数），用两个整数相减，全程不碰本地时区。
 * 注意 **只处理既已存储的日期串本身**，「今天」由调用方用
 * `todayLocal()` 取（本地日历日），这一点与 `srs.ts` 一致。
 */

import type { Todo } from '@/core/model.ts';

/** 一条待办的考期信息（倒计时行与概览都读它） */
export interface ExamCountdown {
  /** 同一条待办的 id（界面拿来高亮/跳转） */
  id: string;
  /** 考试名（就是待办的标题） */
  title: string;
  /** 考期 YYYY-MM-DD。到这里来的一定非空 */
  dueAt: string;
  /** 距考期还有几天：0 = 今天，1 = 明天 */
  daysLeft: number;
}

/**
 * 解析 `YYYY-MM-DD` 成「自 1970-01-01 起的天序号」；格式不对返回 null。
 *
 * 为什么自己解析而不用 `Date.parse`：后者接受一大堆格式
 * （`2026-1-1`、`2026-01-01T00:00`…），而这里的入参只应该是
 * `TodoService` 用 `normalizeDue` 存下的严格格式。宽进会让
 * 「库里有一条脏数据」这件事悄悄变成「倒计时差了几天」。
 */
function toDayNumber(dateStr: string): number | null {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(dateStr);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  if (Number.isNaN(ms)) return null;
  /*
   * 校验「回读等于原值」：`Date.UTC(2026, 1, 31)` 会静默进位到 3 月 3 日。
   * 2 月 30 日这种不存在的日期必须判成坏数据，而不是被算成 3 月 2 日。
   */
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return Math.floor(ms / 86400000);
}

/**
 * 一段日期差（天）。两个字符串任一不合法则返回 null。
 *
 * 导出是为了让「跨夏令时」这件事能被一个直接的单测钉住 ——
 * 断言 2026-03-07 到 2026-03-09 相差 2 天，而不管跑测试的机器在哪个时区、
 * 那几个星期里有没有 DST 切换。
 */
export function daysBetween(from: string, to: string): number | null {
  const a = toDayNumber(from);
  const b = toDayNumber(to);
  if (a === null || b === null) return null;
  return b - a;
}

/**
 * 这一条能不能算「未来的考期」（含今天）；能的话返回它的天序号与日期串。
 *
 * 拆成独立小函数而不是写进 `examCountdown` 的循环里：
 * 徽标那条路（`examBadgeFor`）需要判断同一批条件里的几个，
 * 两处各写一遍 if 的话，「今天算 0 天」这种规则迟早会有一处改漏。
 *
 * 返回 `{ dueAt, dueDay }`（而不是 boolean）是为了让调用方不用再解析一遍、
 * 也不用写 `t.dueAt as string` —— 类型断言会掩盖将来有人把判据改松的失误。
 */
function upcomingExam(t: Todo, todayDay: number): { dueAt: string; dueDay: number } | null {
  /*
   * 已完成的不算：考完了还把「距高数期末 3 天」挂在首页，
   * 是在提醒一件已经结束的事 —— 用户第一反应是「软件坏了」。
   */
  if (t.done) return null;
  /* 只有严格 true 才算考试（见 todos.ts 的 normalizeExam 注释） */
  if (t.isExam !== true) return null;
  /* 没有截止日的考期无法倒计时：算不出「距几天」，就不冒充 */
  if (t.dueAt === null) return null;
  const dueAt = t.dueAt;
  const dueDay = toDayNumber(dueAt);
  if (dueDay === null) return null;
  /* 今天到期 = 0 天，要算；过去的（< 今天）不算 */
  if (dueDay < todayDay) return null;
  return { dueAt, dueDay };
}

/**
 * 最近一场**未来或今天**的考期；没有则 null。
 *
 * @param todos 待办全量（不要求排好序）
 * @param today 今天的本地日期串 `YYYY-MM-DD`，用 `todayLocal()` 取
 *
 * 多条同一天到期时按**标题**兜底排序，保证同一份数据每次调用得到
 * 同一场考试 —— 界面上这个数字不该在两次渲染之间跳。
 */
export function examCountdown(todos: Todo[], today: string): ExamCountdown | null {
  const todayDay = toDayNumber(today);
  if (todayDay === null) return null;

  let best: ExamCountdown | null = null;
  let bestDay = Number.POSITIVE_INFINITY;

  for (const t of todos) {
    const hit = upcomingExam(t, todayDay);
    if (!hit) continue;

    if (hit.dueDay < bestDay) {
      best = { id: t.id, title: t.title, dueAt: hit.dueAt, daysLeft: hit.dueDay - todayDay };
      bestDay = hit.dueDay;
      continue;
    }
    /*
     * 同一天的两场考试：先来的那条留下，除非标题更短更好认。
     * 用标题比较而不是用 id —— id 是随机串，会让「显示哪一场」
     * 在不同机器/不同库里完全随机，截图验收时看起来像 bug。
     */
    if (hit.dueDay === bestDay && best !== null && t.title < best.title) {
      best = { id: t.id, title: t.title, dueAt: hit.dueAt, daysLeft: hit.dueDay - todayDay };
    }
  }

  return best;
}

/**
 * 单条考期的展示用语（待办列表的徽标用）。
 *
 * 三档：今天 / 距 N 天 / 已过期。
 * - `daysLeft === 0` → 「今天」（不是「距 0 天」，那读起来像出错）
 * - `daysLeft > 0`   → 「距 N 天」
 * - `daysLeft < 0`   → 「已过期」（考期过了但还没勾掉）
 *
 * 导出成纯函数是为了让它进单测：徽标文字是用户唯一能看到的东西，
 * 而「今天」写成「距 0 天」这种错误，光看界面上那一小行很容易看漏。
 */
export function examBadgeLabel(daysLeft: number): string {
  if (daysLeft === 0) return '今天';
  if (daysLeft > 0) return `距 ${daysLeft} 天`;
  return '已过期';
}

/**
 * 任意一条待办的考期徽标；不是考期 / 没有日期 / 日期坏掉 / 已完成 都返回 null。
 *
 * - 已完成的不给徽标：勾掉了还挂着「已过期」是在指责一件已经做完的事。
 *   已完成区块自己会显示 `doneAt`，那里已经有时间信息了。
 * - 没有截止日的考期也不给徽标：说不上「距几天」，不如不摆一个空壳。
 *
 * @param today 今天的本地日期串 `YYYY-MM-DD`
 */
export function examBadgeFor(
  t: Todo,
  today: string,
): { label: string; daysLeft: number } | null {
  if (t.isExam !== true) return null;
  if (t.dueAt === null) return null;
  if (t.done) return null;
  const diff = daysBetween(today, t.dueAt);
  if (diff === null) return null;
  return { label: examBadgeLabel(diff), daysLeft: diff };
}

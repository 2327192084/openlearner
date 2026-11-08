/**
 * 首页右侧「便签」区的小组件（2026-11-08）。
 *
 * ## 为什么改这一块
 *
 * 原来右侧那张纸只显示一件事：「下一步」+「10 张没学过」+「挑一组开始」。
 * 而左侧主区**已经在说同一件事**（「今天没有到期的，还有 10 张新卡没学过」
 * 「在『我的题组』里挑一组开始」）。同一屏说两遍，而且是同一组数字。
 *
 * 改成用户可自定义的小组件区：可以写座右铭、待办、每日单词，
 * 也可以把已有功能（番茄钟等）做成小组件放进来。
 *
 * ## 关于联网（用户 2026-11-08 问过，这里记下结论）
 *
 * 用户说「可以联网，后续可能有拓展功能」，但没决定用哪个源。
 * 所以这一版**只做本地能力**：
 *  - 座右铭 / 待办 / 单词 / 任意文本 → 用户自己填，零联网
 *  - 每日一句（默认「鸡汤」）→ **内置语料库**，每天按日期轮换
 *
 * 为什么不接远程：这个应用是离线优先的（KaTeX 字体都打进包、
 * MinerU 本地跑）。为一句鸡汤引入网络依赖，断网就空一块，
 * 而它本来是首页最显眼的位置。用户如果后面要真联网，
 * 换掉 `pickDailyQuote` 的来源即可，接口已经留好。
 */

import type { AppSettings } from '@/core/model.ts';

/**
 * 小组件类型。
 *
 * `quote` 与 `text` 的区别：前者每天自动换（内置语料），后者固定不变。
 * 分开是因为用户写座右铭时不想被"每天自动换掉"。
 */
export type WidgetKind = 'quote' | 'text' | 'todo' | 'focus' | 'plan';

/** 一个小组件实例 */
export interface HomeWidget {
  /** `w_<uuid>` */
  id: string;
  kind: WidgetKind;
  /**
   * 用户给的标题。空则由渲染层按 kind 给默认标题
   * （不在这里硬编码中文，方便以后改文案或做多语言）。
   */
  title: string;
  /** 文本内容（kind 为 text / quote 时用；quote 时是用户自己写的那句） */
  body: string;
}

/**
 * 默认配置（2026-11-08 改）。
 *
 * 用户反馈「学习库右侧界面太空了」，所以从「只放一个每日一句」
 * 改成三个，把右侧填满但不堆砌：
 *
 *  1. **今日学习** —— 到期 / 薄弱分开的数字，回答了「今天干什么」
 *  2. **待办** —— 最近 3 件没完成的，回答「还有什么没做」
 *  3. **每日一句** —— 用户原本要求的默认项，保留
 *
 * 为什么是这三个而不是更多：右侧栏 340px 宽，四个以上会变成一列
 * 挤在一起的卡片，反而比空着更乱。用户可以在设置里自己增删（上限 6）。
 */
export const DEFAULT_WIDGETS: HomeWidget[] = [
  { id: 'w_default_plan', kind: 'plan', title: '今日学习', body: '' },
  { id: 'w_default_todo', kind: 'todo', title: '待办', body: '' },
  { id: 'w_default_quote', kind: 'quote', title: '每日一句', body: '' },
];

/** 上限：超过这个数右侧栏会滚不到底，体验反而更差 */
export const MAX_WIDGETS = 6;

/**
 * 内置语料库（每日一句）。
 *
 * 选的都是「考研/长期学习会反复撞上」的句子，不放成功学。
 * 每天按日期取一条，同一天看到的是同一句（不会刷新就变）。
 *
 * 为什么放本地而不是请求接口：
 *  - 断网可用。这是桌面学习工具，用户可能在没网的自习室里用。
 *  - 不增加失败点。首页一块区域因为网络挂了而空白，比没有这块还糟。
 *  - 零成本、零延迟。
 */
export const DAILY_QUOTES: string[] = [
  '不积跬步，无以至千里；不积小流，无以成江海。',
  '锲而舍之，朽木不折；锲而不舍，金石可镂。',
  '业精于勤，荒于嬉；行成于思，毁于随。',
  '合抱之木，生于毫末；九层之台，起于累土。',
  '学而不思则罔，思而不学则殆。',
  '知之者不如好之者，好之者不如乐之者。',
  '路虽远行则将至，事虽难做则必成。',
  '天下之难事必作于易，天下之大事必作于细。',
  '博学之，审问之，慎思之，明辨之，笃行之。',
  '君子藏器于身，待时而动。',
  '志不强者智不达。',
  '千淘万漉虽辛苦，吹尽狂沙始到金。',
  '宝剑锋从磨砺出，梅花香自苦寒来。',
  '纸上得来终觉浅，绝知此事要躬行。',
  '问渠那得清如许，为有源头活水来。',
  '会当凌绝顶，一览众山小。',
  '长风破浪会有时，直挂云帆济沧海。',
  '沉舟侧畔千帆过，病树前头万木春。',
  '山重水复疑无路，柳暗花明又一村。',
  '莫等闲，白了少年头，空悲切。',
  '少年易学老难成，一寸光阴不可轻。',
  '读书破万卷，下笔如有神。',
  '敏而好学，不耻下问。',
  '温故而知新，可以为师矣。',
  '三人行，必有我师焉。',
  '工欲善其事，必先利其器。',
  '不患人之不己知，患不知人也。',
  '胜人者有力，自胜者强。',
  '知人者智，自知者明。',
  '慎终如始，则无败事。',
];

/**
 * 按「本地日期」取当天那一句。
 *
 * ## 为什么用本地日期而不是 UTC
 *
 * 这条项目里踩过（dueAt 那次）：东八区下 UTC 的 0-8 点算「昨天」，
 * 于是凌晨还在学习的用户会看到「昨天的那句」，
 * 而第二天早上 8 点又突然跳回。用本地日期就没有这个断层。
 *
 * @param day 形如 `2026-11-08` 的本地日期串；不传则取今天
 */
export function pickDailyQuote(day?: string): string {
  const key = day ?? todayLocalYmd();
  return DAILY_QUOTES[dayIndex(key, DAILY_QUOTES.length)]!;
}

/**
 * 把 `YYYY-MM-DD` 折成 `[0, size)` 的下标，且**相邻日期一定不同**。
 *
 * ## 为什么不用 hash —— 第一版就是那样，被测试抓出来了
 *
 * 最初写的是 `h = h*31 + c` 然后 `h * 2654435761 % size`。
 * 结果实测「连续 30 天只取到 7 个不同的句子」：
 * 两个乘数在 JS 里都会溢出成 32 位整数（`| 0` 与位运算），
 * 乘法后的低位被大量抹平，`% 30` 几乎失去分辨力。
 *
 * 这种 bug 肉眼看不出来 —— 界面每天有一句可显示，只是反复重复。
 * 是「连续 30 天不重复」那条测试把它揪出来的。
 *
 * ## 现在：日期串直接映射成「天数」，再取模
 *
 * `2026-11-08` → 自 1970-01-01 起的天数 → `% size`。
 * 好处是**相邻两天必然差 1**，所以只要 size > 1 就不会连着两天同一句，
 * 而且 30 条语料正好轮完一圈，一个不漏。这比任何 hash 都符合这里的需求：
 * 我们要的不是「像随机」，而是「每天换、不重样」。
 */
function dayIndex(key: string, size: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (m) {
    const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isFinite(utc)) {
      const days = Math.floor(utc / 86400000);
      /* 取绝对值后再取模：1970 年之前会是负数，别让下标变负 */
      return Math.abs(days) % size;
    }
  }
  /*
   * 认不出日期（用户传了怪字符串）：退回按字符和取模。
   * 这时不保证「每天不同」，但至少同一天稳定、不越界。
   */
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h + key.charCodeAt(i)) % size;
  return h;
}

/** 本地日期 `YYYY-MM-DD`。用本地而不是 ISO（UTC）——理由见 pickDailyQuote */
export function todayLocalYmd(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * 读配置：把 settings 里的原始值规整成可信的组件列表。
 *
 * 为什么容忍坏数据：这个字段来自 `settings` 分区，可能被手工改过，
 * 也可能来自旧备份。一个格式不对的组件不该让整个首页白屏 ——
 * 按 kind 白名单过滤掉即可。
 */
export function normalizeWidgets(raw: unknown): HomeWidget[] {
  if (!Array.isArray(raw)) return [...DEFAULT_WIDGETS];

  const valid: HomeWidget[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const kind = o.kind;
    if (kind !== 'quote' && kind !== 'text' && kind !== 'todo' && kind !== 'focus' && kind !== 'plan') continue;
    const id = typeof o.id === 'string' && o.id ? o.id : `w_${valid.length}`;
    valid.push({
      id,
      kind,
      title: typeof o.title === 'string' ? o.title : '',
      body: typeof o.body === 'string' ? o.body : '',
    });
    if (valid.length >= MAX_WIDGETS) break;
  }

  /*
   * 空数组也要给默认值。
   *
   * 「用户把组件全删了」与「还没配过」在存储里都是空数组，
   * 但后者应该看到默认的每日一句。区分不了就按「还没配过」处理：
   * 首页总得有点东西，而且用户想清空可以逐个删 —— 删到最后
   * 我们会再补一个默认的，这一点在设置页文案里说明。
   */
  return valid.length > 0 ? valid : [...DEFAULT_WIDGETS];
}

/** 写回前的校验（保存时用） */
export function clampWidgets(list: HomeWidget[]): HomeWidget[] {
  return list.slice(0, MAX_WIDGETS);
}

/**
 * 从 AppSettings 里取组件配置。
 *
 * 单开一个类型而不是直接往 AppSettings 塞 `widgets`：
 * 这样 settings 里那个字段可以是 `unknown`（旧备份可能是任何形状），
 * 而这一层负责把它变成可信的结构。
 */
export function widgetsFromSettings(settings: AppSettings | null | undefined): HomeWidget[] {
  const raw = (settings as unknown as { homeWidgets?: unknown } | null | undefined)?.homeWidgets;
  return normalizeWidgets(raw);
}

/** 给渲染层用的默认标题（kind → 文案） */
export const DEFAULT_WIDGET_TITLE: Record<WidgetKind, string> = {
  plan: '今日学习',
  todo: '待办',
  quote: '每日一句',
  text: '便签',
  focus: '专注',
};

/** 给设置页用的类型说明 */
export const WIDGET_KIND_LABEL: Record<WidgetKind, string> = {
  plan: '今日学习（到期 / 薄弱分开显示）',
  todo: '待办提醒（显示最近要做的几件）',
  quote: '每日一句（内置语料，每天自动换）',
  text: '固定便签（座右铭、每日单词、任何文字）',
  focus: '番茄钟（直接开始专注）',
};

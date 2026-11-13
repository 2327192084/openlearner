/**
 * 改名（2026-11-13 傍晚，用户要求）。
 *
 * ## 用户原话
 *
 * > 「建议：加个更名功能，可以更名资料库的资料，题组。」
 *
 * 截图里那些名字都是从 PDF 文件名自动带出来的，例如
 * 「信号与系统（第二版）第1章 信号与系统 正文（不含习题）」——
 * 又长又不可读，用户想改成「第1章 信号与系统」。
 *
 * ## 服务层早就能改，只是没人接
 *
 * `SourceService.update(id, { title })` 与
 * `QuestionService.updateDeck(id, { title })` 都早就实现了
 * （后者注释里写着「没有这个方法时，界面上那个『改名』按钮只能撤掉」），
 * 但全仓没有一处界面调用它们。这又是「做出来」与「用户能用上」的差别。
 *
 * 所以这个模块只管**界面这一侧的规则**：什么算合法的新名字。
 * 落库仍然走那两个现成的方法，不改它们的语义。
 *
 * ## 为什么不在这里写落库
 *
 * 两个实体的字段与存储分区不同（sources / decks），
 * 且它们都会顺带刷 `updatedAt`（这是对的：改名就是用户改属性）。
 * 把这些搬进纯逻辑模块，只会让「到底谁在写库」变模糊。
 */

/** 校验结果：要么给出可用的标题，要么给出**能照着改**的原因 */
export type RenameCheck =
  | { ok: true; title: string }
  | { ok: false; reason: string };

/**
 * 标题的最大长度。
 *
 * 为什么是 80：资料名来自文件名，长的一百多字很常见；
 * 但侧栏、卡片、导出都按单行显示，超长会被截断成
 * 「信号与系统（第二版）第1章 信号与…」，用户仍然分不清。
 * 80 足够写清楚「第1章 信号与系统 · 正文」，又不至于撑爆布局。
 */
export const MAX_TITLE_LENGTH = 80;

/**
 * 校验用户输入的新名字。
 *
 * @param raw 用户在输入框里打的原文（**不要预先 trim**，让这里统一处理）
 * @param current 当前标题，用于判断「没改」与给出提示
 */
export function checkNewTitle(raw: string, current: string): RenameCheck {
  /*
   * 先 trim 再判空：用户很容易只打了几个空格（尤其是全选后误敲）。
   * 若直接存下去，界面上就出现一个看不见名字的资料 ——
   * 比不改更糟。服务层遇到空串会退回原标题，但那样用户会以为
   * 「点了保存却没反应」，所以这里就明确告诉他。
   */
  const title = raw.trim();

  if (title.length === 0) {
    return { ok: false, reason: '名字不能是空的' };
  }

  if (title.length > MAX_TITLE_LENGTH) {
    return {
      ok: false,
      reason: `太长了（${title.length} 字），最多 ${MAX_TITLE_LENGTH} 字`,
    };
  }

  /*
   * 名字里带换行/制表符会把单行布局撑坏（侧栏、列表、导出都用单行）。
   * 浏览器不会在 <span> 里视觉换行，但会留下一个看不见的字符，
   * 之后在任何地方复制这个名字都会带上它。
   */
  if (/[\r\n\t]/.test(title)) {
    return { ok: false, reason: '名字里不能有换行或制表符' };
  }

  if (title === current) {
    /*
     * 「没改动」不是错误，但也不该写库（会无谓刷 updatedAt，
     * 让资料看起来「刚被编辑过」）。调用方据此直接关闭输入框。
     */
    return { ok: false, reason: '和原来的名字一样' };
  }

  return { ok: true, title };
}

/**
 * 这个校验失败要不要当成「错误」显示成红色。
 *
 * 「和原来一样」是用户最常见的操作（打开输入框看一眼又回车），
 * 把它当错误弹红字会很吵。其它原因（空、太长、带换行）才值得提示。
 */
export function isRenameError(check: RenameCheck): boolean {
  return !check.ok && check.reason !== '和原来的名字一样';
}

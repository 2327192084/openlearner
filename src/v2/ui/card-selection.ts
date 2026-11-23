/**
 * 闪卡导出的「挑几张」选择模型（2026-11-23 晚，用户要求）。
 *
 * 用户原话：
 * > 导出到obsidian的功能需要优化，有时需要选取几个特定的文件而不是全部文件，
 * > 应该加个多选或是全选的按钮。
 *
 * 追问后用户选了**两者都要**：组头能整组勾，卡片也能单独勾。
 *
 * ## 为什么单独一个文件而不是塞进 FlashcardsPage
 *
 * 那个页面已经 1158 行（硬约束 8 的基线是 844），再往里加选择逻辑
 * 就没法读了。而且选择是纯数据变换，可以脱离 React 单测 ——
 * 「全选后又是全选」这类关系错误靠断言行，不靠点。
 *
 * ## 三条关系约束（这里每一条都有对应单测）
 *
 * 1. **勾上的东西必须真的会被导出**：`effectiveIds()` 只回当前 `visible`
 *    里还活着的 id。用户勾了 5 张、然后搜了个词只剩 2 张可见 ——
 *    导出就该是 2 张，而不是把不可见的 3 张也偷偷带上
 *    （那是「界面上看到的和实际发生的不一样」）。
 * 2. **组头三态要准**：整组都在选择里才算 `all`，一个都没有才 `none`，
 *    其余是 `some`。二态实现会让「勾了组里 2/5」显示成未勾选，
 *    用户以为没勾上。
 * 3. **空组不能算「全选」**：`every()` 对空数组返回 true，
 *    照抄会让空文件夹的组头显示成已全选。
 */

/** 一个组在选择里的状态（组头勾选框的三态） */
export type GroupPickState = 'none' | 'some' | 'all';

/** 勾/取消一张卡（返回新的 Set，不改原对象 —— React state 要新引用） */
export function toggleCard(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * 整组勾/取消：**整组都已选中就整组取消，否则整组选中**。
 *
 * 这是多选列表的通行手感（QuestionPicker.toggleDeckAll 同款）：
 * 部分选中时点组头，用户的意图是"把这组都选上"，不是"清空这组"。
 */
export function toggleGroup(selected: ReadonlySet<string>, groupIds: readonly string[]): Set<string> {
  const next = new Set(selected);
  const all = groupIds.length > 0 && groupIds.every((id) => next.has(id));
  for (const id of groupIds) {
    if (all) next.delete(id);
    else next.add(id);
  }
  return next;
}

/** 组头该显示什么状态（见文件头第 2、3 条约束） */
export function groupPickState(
  selected: ReadonlySet<string>,
  groupIds: readonly string[],
): GroupPickState {
  if (groupIds.length === 0) return 'none';
  let hit = 0;
  for (const id of groupIds) if (selected.has(id)) hit++;
  if (hit === 0) return 'none';
  return hit === groupIds.length ? 'all' : 'some';
}

/**
 * 把选择收窄到「当前可见且仍存在」的卡，保持可见顺序。
 *
 * 导出的就应该是这个结果 —— 界面上说"导出 N 张"时 N 必须等于它的长度。
 */
export function effectiveIds(
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
): string[] {
  const out: string[] = [];
  for (const id of visibleIds) if (selected.has(id)) out.push(id);
  return out;
}

/**
 * 修剪：把已经不在库里的 id 从选择里去掉。
 *
 * 删除、批量删除、导入覆盖之后都会用到。不修剪的话选择集会越来越大，
 * 而且「已选 7 张」里混着 3 张早已不存在的卡，导出时数字对不上。
 */
export function pruneSelection(
  selected: ReadonlySet<string>,
  aliveIds: readonly string[],
): Set<string> {
  const alive = new Set(aliveIds);
  const next = new Set<string>();
  for (const id of selected) if (alive.has(id)) next.add(id);
  return next;
}

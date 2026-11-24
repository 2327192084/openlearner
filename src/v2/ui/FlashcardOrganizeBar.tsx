/**
 * 闪卡管理页的整理条与多选工具条（2026-11-23 晚）。
 *
 * 从 `FlashcardsPage.tsx` 拆出来的（硬约束 8：那个文件已 1158 行，基线 844）。
 * 这里只做"长什么样 + 点了给谁"，所有关系规则都在 `flashcard-organize.ts`，
 * 状态仍在页面里 —— 组件不自留数据副本，避免两处数字对不上。
 *
 * ## 为什么导出按钮**没**搬到这里
 *
 * 它在第一行筛选条上（`.fcx__bar`），既有 CDP 脚本
 * `verify-flashcard-cards.cjs:598` / `verify-flashcard-independent.cjs:267`
 * 都按 `.fcx__export` 取它并核对张数。搬到第二行不破选择器，
 * 但第二行是「有资料/有卡才出现」—— 依赖它的脚本会在别的状态下失效。
 * 少动既有锚点，只把**新**控件放这一行。
 */

import { useState } from 'react';
import type { FlashcardFolder } from '@/v2/core/flashcard-folders.ts';
import {
  GROUP_MODES,
  folderAssignLabel,
  newFolderProblem,
  pickSummary,
  type GroupMode,
} from './flashcard-organize.ts';

export interface FlashcardOrganizeBarProps {
  groupMode: GroupMode;
  onGroupMode: (m: GroupMode) => void;
  /** 宿主给了 sourceTitleOf 才可能按资料分组，否则那个选项灰掉并说明 */
  canGroupBySource: boolean;
  /** 用户建的文件夹（按文件夹模式才显示管理按钮） */
  folders: readonly FlashcardFolder[];
  busy?: boolean;
  onNewFolder: (name: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onRemoveFolder: (id: string) => void;
  /** 多选开关 */
  picking: boolean;
  onTogglePicking: () => void;
  /** 导出选项对话框 */
  onOpenExportOptions: () => void;
  /** 当前可见卡数（多选按钮的可用性用） */
  visibleCount: number;
}

export function FlashcardOrganizeBar(props: FlashcardOrganizeBarProps) {
  const {
    groupMode,
    onGroupMode,
    canGroupBySource,
    folders,
    busy,
    onNewFolder,
    onRenameFolder,
    onRemoveFolder,
    picking,
    onTogglePicking,
    onOpenExportOptions,
    visibleCount,
  } = props;

  /** 正在新建的文件夹名（null = 输入框没开） */
  const [draftName, setDraftName] = useState<string | null>(null);
  /** 正在改名的文件夹 */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const problem = draftName === null ? null : newFolderProblem(draftName, folders);

  const submitNew = () => {
    if (draftName === null || problem !== null) return;
    onNewFolder(draftName.trim());
    setDraftName('');
  };

  const submitRename = () => {
    if (!renaming) return;
    const t = renaming.name.trim();
    if (!t || folders.some((f) => f.name === t && f.id !== renaming.id)) return;
    onRenameFolder(renaming.id, t);
    setRenaming(null);
  };

  return (
    <>
      <div className="fcx__gmode" role="radiogroup" aria-label="分组方式">
        {GROUP_MODES.map((m) => {
          const blocked = m.id === 'source' && !canGroupBySource;
          return (
            <label
              key={m.id}
              /*
               * ⚠️ `fcx__groupsw` 这个类名必须留着：既有 CDP 脚本按
               * `.fcx__groupsw input` 判断"这页有没有分组开关"。
               * 三选一替换了原来的单勾选框，但锚点不能断。
               */
              className={`fcx__groupsw fcx__gmode-opt${groupMode === m.id ? ' fcx__gmode-opt--on' : ''}${blocked ? ' fcx__gmode-opt--off' : ''}`}
              title={blocked ? '这一页没拿到资料标题，分不了资料组' : m.title}
            >
              <input
                type="radio"
                name="fcx-groupmode"
                value={m.id}
                checked={groupMode === m.id}
                disabled={blocked}
                onChange={() => onGroupMode(m.id)}
              />
              {m.label}
            </label>
          );
        })}
      </div>

      {groupMode === 'folder' ? (
        <div className="fcx__folders" role="group" aria-label="文件夹">
          {folders.length === 0 && draftName === null ? (
            <span className="fcx__hint">还没有文件夹。建一个，再把卡勾起来归进去。</span>
          ) : null}
          {folders.map((f) =>
            renaming?.id === f.id ? (
              <span key={f.id} className="fcx__folderform">
                <input
                  className="fcx__folderinput"
                  value={renaming.name}
                  onChange={(e) => setRenaming({ id: f.id, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitRename();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  aria-label="文件夹新名字"
                  spellCheck={false}
                  autoFocus
                />
                <button type="button" className="fcx__act fcx__act--go" onClick={submitRename} disabled={busy}>
                  好
                </button>
                <button type="button" className="fcx__act" onClick={() => setRenaming(null)}>
                  取消
                </button>
              </span>
            ) : (
              <span key={f.id} className="fcx__folderchip">
                <button
                  type="button"
                  className="fcx__folderchip-name"
                  onClick={() => setRenaming({ id: f.id, name: f.name })}
                  title="点一下改名"
                  disabled={busy}
                >
                  {f.name}
                </button>
                <button
                  type="button"
                  className="fcx__folderchip-del"
                  onClick={() => onRemoveFolder(f.id)}
                  disabled={busy}
                  title={`删掉文件夹「${f.name}」（里面的卡不会删，只会变成未归入文件夹）`}
                  aria-label={`删掉文件夹 ${f.name}`}
                >
                  ×
                </button>
              </span>
            ),
          )}

          {draftName === null ? (
            <button
              type="button"
              className="fcx__foldernew"
              onClick={() => setDraftName('')}
              disabled={busy}
            >
              ＋ 新建文件夹
            </button>
          ) : (
            <span className="fcx__folderform">
              <input
                className="fcx__folderinput"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitNew();
                  if (e.key === 'Escape') setDraftName(null);
                }}
                placeholder="文件夹名，回车建好"
                aria-label="新文件夹名"
                spellCheck={false}
                autoFocus
              />
              <button type="button" className="fcx__act fcx__act--go" onClick={submitNew} disabled={problem !== null || busy}>
                建
              </button>
              <button type="button" className="fcx__act" onClick={() => setDraftName(null)}>
                取消
              </button>
              {problem ? <span className="fcx__hint fcx__hint--bad">{problem}</span> : null}
            </span>
          )}
        </div>
      ) : null}

      <span className="fcx__bar2-gap" />

      <button
        type="button"
        className={`fcx__pickbtn${picking ? ' fcx__pickbtn--on' : ''}`}
        onClick={onTogglePicking}
        disabled={busy || visibleCount === 0}
        aria-pressed={picking}
        title={picking ? '退出多选，导出变回"当前筛选全部"' : '勾几张卡：只导出它们，或归进某个文件夹'}
      >
        {picking ? '退出多选' : '多选'}
      </button>
      <button type="button" className="fcx__optbtn" onClick={onOpenExportOptions} disabled={busy}>
        导出选项
      </button>
    </>
  );
}

export interface FlashcardPickBarProps {
  selected: number;
  visible: number;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onAssign: (folderId: string | null) => void;
  folders: readonly FlashcardFolder[];
  /** 归入时目标文件夹（null = 未归入） */
  assignTarget: string | null;
  onAssignTarget: (id: string | null) => void;
  busy?: boolean;
}

/**
 * 多选模式下出现的工具条：全选 / 清空 / 归入文件夹。
 *
 * 「归入」的目标用下拉选，而不是弹窗 —— 文件夹就那几个，
 * 弹窗反而多点两下；选择器就在工具条上，改目标不用重新勾卡。
 */
export function FlashcardPickBar(props: FlashcardPickBarProps) {
  const { selected, visible, onSelectAll, onSelectNone, onAssign, folders, assignTarget, onAssignTarget, busy } = props;
  return (
    <div className="fcx__pickbar">
      <span className="fcx__pickn">{pickSummary(selected, visible)}</span>
      <button type="button" className="fcx__act" onClick={onSelectAll} disabled={busy || visible === 0}>
        全选
      </button>
      <button type="button" className="fcx__act" onClick={onSelectNone} disabled={busy || selected === 0}>
        清空
      </button>
      <select
        className="fcx__foldersel"
        value={assignTarget ?? ''}
        onChange={(e) => onAssignTarget(e.target.value === '' ? null : e.target.value)}
        aria-label="归入哪个文件夹"
        disabled={busy}
      >
        <option value="">未归入文件夹</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="fcx__act fcx__act--go"
        onClick={() => onAssign(assignTarget)}
        disabled={busy || selected === 0}
        title={folderAssignLabel(selected)}
      >
        {folderAssignLabel(selected)}
      </button>
    </div>
  );
}

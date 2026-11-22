/**
 * 选取模式横幅（2026-11-23，用户待办第 1 项）。
 *
 * 跳进闪卡管理页/我的题组页时，若带着「选取会话」，页面顶部出这条横幅：
 * 说清在为哪一节挑什么、已绑几个、怎么返回。
 *
 * 单独成文件是硬约束 9（别往 FlashcardsPage 844 行 / DecksPage 538 行里堆）。
 */

import { pickBannerText, type PickSession } from './pick-context.ts';
import './pick-banner.css';

export interface PickBannerProps {
  session: PickSession;
  /** 这一节当前已绑的数量（闪卡数或题组数）—— 必须来自真实绑定表 */
  boundCount: number;
  /** 返回地图（App 负责清会话 + 回 mapTree + 恢复小节详情） */
  onBack: () => void;
}

export function PickBanner(props: PickBannerProps) {
  const { session, boundCount, onBack } = props;
  return (
    <div className="pkb" role="status">
      <span className="pkb__icon" aria-hidden="true">
        🎯
      </span>
      <span className="pkb__text">{pickBannerText(session, boundCount)}</span>
      <button type="button" className="pkb__back" onClick={onBack}>
        返回地图
      </button>
    </div>
  );
}

/**
 * 条目行上的「选这个」按钮。
 *
 * 两页共用这一个组件：文案一致、禁用逻辑一致
 * （已绑的显示「已绑上」而不是消失 —— 用户要知道点了没反应是因为绑过了）。
 */
export interface PickButtonProps {
  picked: boolean;
  busy?: boolean;
  onPick: () => void;
}

export function PickButton(props: PickButtonProps) {
  const { picked, busy, onPick } = props;
  return (
    <button
      type="button"
      className={`pkb__pick${picked ? ' pkb__pick--done' : ''}`}
      onClick={onPick}
      disabled={picked || busy}
      title={picked ? '这一节已经绑上它了' : '绑到当前小节'}
    >
      {picked ? '已绑上' : '选这个'}
    </button>
  );
}

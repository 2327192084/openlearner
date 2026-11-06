import type { ReactElement } from 'react';

/**
 * 线描图标集（Phosphor Light 风格）。
 *
 * ## 为什么不用 emoji / unicode 字符
 *
 * 我先前用 `◈ ▤ ✦` 这类字符，问题很明显：
 *  - 不同字体下形状完全不同（用户机器上可能变成豆腐块）
 *  - 粗细无法统一，跟界面里的 1px 描边对不上
 *  - 无法着色（随文字色变化）
 *
 * StudyHub 的做法是所有图标走单一注册表、手绘 SVG、`currentColor` 描边。
 * 这里照做：24×24 画布，1.5px 描边，圆角端点。
 */

interface IconProps {
  size?: number;
  className?: string;
}

function svg(children: ReactElement, { size = 18, className }: IconProps = {}): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** 学习库 / 首页：一本翻开的书 */
export const IconLibrary = (p: IconProps) =>
  svg(
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a1.6 1.6 0 0 0-1.6-1.6H5.5A1.5 1.5 0 0 1 4 15.9Z" />
      <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a1.6 1.6 0 0 1 1.6-1.6h4.9A1.5 1.5 0 0 0 20 15.9Z" />
    </>,
    p,
  );

/** 资料：一叠纸 */
export const IconSources = (p: IconProps) =>
  svg(
    <>
      <path d="M6 3h8l4 4v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M14 3v5h5" />
      <path d="M8 13h6M8 17h4" />
    </>,
    p,
  );

/** 创建题组：加号在方框里 */
export const IconGenerate = (p: IconProps) =>
  svg(
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M12 8.5v7M8.5 12h7" />
    </>,
    p,
  );

/** 任务：清单 */
export const IconTasks = (p: IconProps) =>
  svg(
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
    </>,
    p,
  );

/** 错题：旗子 */
export const IconWrongbook = (p: IconProps) =>
  svg(
    <>
      <path d="M6 21V4" />
      <path d="M6 4.5h9.5l-1.8 3.5 1.8 3.5H6" />
    </>,
    p,
  );

/** 学习流：曲线箭头 */
export const IconFlow = (p: IconProps) =>
  svg(
    <>
      <path d="M4 16c3.5 0 4-8 7.5-8S16 16 20 16" />
      <path d="M17 13l3 3-3 3" />
    </>,
    p,
  );

/** 学习笔记：翻开的笔记本 */
export const IconNotes = (p: IconProps) =>
  svg(
    <>
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d="M8 9h8M8 13h8M8 17h5" />
    </>,
    p,
  );

/** 待办：看板 */
export const IconBoard = (p: IconProps) =>
  svg(
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9 4.5v15M15 4.5v15" />
    </>,
    p,
  );

/** 模拟考试：试卷 + 勾 */
export const IconExam = (p: IconProps) =>
  svg(
    <>
      <path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
      <path d="M8.5 13.5l2 2 4-4" />
    </>,
    p,
  );

/** 备考补习：靶心 */
export const IconTarget = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.6" fill="currentColor" />
    </>,
    p,
  );

/** 复习全书：书脊带书签 */
export const IconBook = (p: IconProps) =>
  svg(
    <>
      <path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2Z" />
      <path d="M5 4v14" />
      <path d="M15 4v6l-2-1.5L11 10V4" />
    </>,
    p,
  );

/** 统计：柱状图 */
export const IconStats = (p: IconProps) =>
  svg(
    <>
      <path d="M4 20h16" />
      <rect x="6" y="11" width="3" height="6" rx="1" />
      <rect x="11" y="7" width="3" height="10" rx="1" />
      <rect x="16" y="13" width="3" height="4" rx="1" />
    </>,
    p,
  );

/** 知识骨架：节点连线 */
export const IconSkeleton = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="5" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M12 7v5M12 12l-4.5 4.5M12 12l4.5 4.5" />
    </>,
    p,
  );

/** 音频转写：声波 */
export const IconAudio = (p: IconProps) =>
  svg(
    <>
      <path d="M4 12v0M7 9v6M10 6.5v11M13 9v6M16 7.5v9M19 11v2" />
    </>,
    p,
  );

/** 课堂实录：摄像机 */
export const IconRecord = (p: IconProps) =>
  svg(
    <>
      <rect x="3" y="7" width="12" height="10" rx="2" />
      <path d="M15 11l5-3v8l-5-3Z" />
    </>,
    p,
  );

/** 语言：地球 */
export const IconGlobe = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4c2.5 2.6 2.5 13.4 0 16M12 4c-2.5 2.6-2.5 13.4 0 16" />
    </>,
    p,
  );

/** 功能导览：问号圈 */
export const IconHelp = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.2 2.4c-.6.2-1 .8-1 1.4v.3" />
      <path d="M12 16.5h.01" />
    </>,
    p,
  );

/** 设置：齿轮 */
export const IconSettings = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.8l1.9 1.1M17.2 15.1l1.9 1.1M4.9 16.2l1.9-1.1M17.2 8.9l1.9-1.1" />
    </>,
    p,
  );

/** 回到题目：返回箭头 */
export const IconBack = (p: IconProps) =>
  svg(
    <>
      <path d="M10 7l-5 5 5 5" />
      <path d="M5 12h14" />
    </>,
    p,
  );

/** 折叠 chevron（用旋转表示展开状态，不用三角符号） */
export const IconChevron = (p: IconProps) =>
  svg(<path d="M8 5l6 7-6 7" />, p);

/** 已连接状态点（实心） */
export const IconDot = ({ size = 8 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 8 8" aria-hidden="true" focusable="false">
    <circle cx="4" cy="4" r="3.2" fill="currentColor" />
  </svg>
);

/** 信封（顶栏右侧） */
export const IconMail = (p: IconProps) =>
  svg(
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M3.5 7l8.5 6 8.5-6" />
    </>,
    p,
  );

/** 上传（添加资料按钮） */
export const IconUpload = (p: IconProps) =>
  svg(
    <>
      <path d="M12 16V5" />
      <path d="M8 9l4-4 4 4" />
      <path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" />
    </>,
    p,
  );

/** 文档（空状态） */
export const IconDoc = (p: IconProps) =>
  svg(
    <>
      <path d="M7 3h7l5 5v13H7Z" />
      <path d="M14 3v5h5" />
    </>,
    p,
  );

/** 对勾（已连接提示） */
export const IconCheck = (p: IconProps) =>
  svg(<path d="M5 12.5l4.5 4.5L19 7.5" />, p);

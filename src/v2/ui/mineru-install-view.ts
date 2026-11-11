/**
 * 一键安装面板的**展示决策**（2026-11-11 晚）。
 *
 * ## 为什么抽出来
 *
 * 面板本身是 React 组件，而本项目的单测环境是 `node`（没有 DOM），
 * 也没有装 testing-library —— 为一个新面板引入浏览器测试环境
 * 不划算，还会让 `vitest run` 变慢。
 *
 * 但面板里真正容易出错、且用户能直接感知的判断，是可以抽成纯函数的：
 *
 *  - 「A 方案」到底该显示「直接用那个」还是「选盘安装」
 *  - 「开始安装」按钮什么时候该禁用
 *  - 卸载按钮什么时候该能点
 *  - 个别步骤显示成什么状态
 *
 * 这些抽出来就能用普通单测钉死，组件只负责把它们画出来。
 * 这也是本项目其它 v2 页面的做法（如 `today-plan.ts`、`practice-queue.ts`）。
 */

/** 与主进程约定的安装步骤顺序（引擎 planSteps 的顺序） */
export const INSTALL_STEPS: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'uv', title: '下载 uv 工具' },
  { id: 'python', title: '准备独立 Python' },
  { id: 'venv', title: '创建运行环境' },
  { id: 'packages', title: '安装 MinerU 程序' },
  { id: 'models', title: '下载识别模型' },
];

export type StepState = 'idle' | 'running' | 'done' | 'failed' | 'skipped';

export interface PanelInput {
  /** 有没有接到桌面端的桥（浏览器里没有） */
  hasBridge: boolean;
  /** 探测结果：机器上是否已有可用的 MinerU */
  alreadyInstalled: boolean;
  /** 是否选了安装目录 */
  hasChosenDir: boolean;
  /** 是否正在安装 */
  busy: boolean;
  /** 各步骤状态 */
  steps: Record<string, StepState>;
}

export interface PanelView {
  /** 整个面板能不能用（没桥就只能提示去桌面版） */
  usable: boolean;
  /** 显示「已经装好，直接用那个」那块 */
  showDetected: boolean;
  /** 显示选盘 + 安装那两块 */
  showInstall: boolean;
  /** 「开始安装」能不能点 */
  canStart: boolean;
  /** 卸载按钮能不能点 */
  canUninstall: boolean;
  /** 顶部/按钮上显示「正在安装…」 */
  showRunning: boolean;
}

/**
 * 决定面板该长什么样。
 *
 * ## 一条关键规则（A 方案）
 *
 * `alreadyInstalled` 为真时**不显示安装入口**。
 * 这不是排版偏好：MinerU 的服务是全局单例，装第二份会和已有那份抢服务、
 * token 打架（实测 `invalid_doclib_token`）。
 * 所以「已经装好」和「安装入口」在设计上就是互斥的。
 */
export function panelView(input: PanelInput): PanelView {
  const running = input.busy || Object.values(input.steps).some((s) => s === 'running');

  if (!input.hasBridge) {
    return {
      usable: false,
      showDetected: false,
      showInstall: false,
      canStart: false,
      canUninstall: false,
      showRunning: false,
    };
  }

  const showDetected = input.alreadyInstalled;
  const showInstall = !input.alreadyInstalled;

  return {
    usable: true,
    showDetected,
    showInstall,
    /* 必须选了目录才能装；安装中不能重复点 */
    canStart: showInstall && input.hasChosenDir && !running,
    /* 卸载也要知道目录在哪；安装中不让卸 */
    canUninstall: input.hasChosenDir && !running,
    showRunning: running,
  };
}

/** 单看一步该显示成什么（进度条的文案据此决定） */
export function stepLabel(state: StepState): { mark: string; note: string | null } {
  switch (state) {
    case 'done':
      return { mark: '✓', note: null };
    case 'failed':
      return { mark: '✕', note: null };
    case 'skipped':
      return { mark: '—', note: '已跳过' };
    case 'running':
      return { mark: '·', note: null };
    default:
      return { mark: '·', note: null };
  }
}

/**
 * 下载进度换算成 0~100。
 *
 * 拿不到总大小时**不给假百分比**，返回 null 让界面显示不确定态
 * （不能拿 30% 当真，那是在编数字）。
 */
export function progressPercent(downloaded: number, total: number | null): number | null {
  if (!total || total <= 0) return null;
  if (!Number.isFinite(downloaded) || downloaded < 0) return null;
  return Math.min(100, (downloaded / total) * 100);
}

/** 磁盘剩余空间的显示文案（1 位小数，与界面一致） */
export function formatGb(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '未知';
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

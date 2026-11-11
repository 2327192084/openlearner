/// <reference types="vite/client" />

/**
 * 全局类型补充。
 *
 * 1. CSS 导入：Vite 会把 .css 当作副作用模块，类型系统需要知道这一点，
 *    否则每个 `import './x.css'` 都会报「找不到模块」。
 * 2. Electron 预加载脚本暴露的接口声明（见 electron/preload.cjs）。
 */

declare module '*.css' {
  const content: string;
  export default content;
}

/** electron/preload.cjs 通过 contextBridge 暴露的最小接口 */
interface OpenLeanerBridge {
  /** 'win32' | 'darwin' | 'linux' */
  readonly platform: string;
  /** 恒为 true：能读到这个对象就说明在 Electron 壳里 */
  readonly isElectron: true;
  /**
   * 只暴露这三个版本号。
   * 完整 process.versions 故意不暴露 —— 精确的 Node/Chromium 版本
   * 会方便攻击者挑选已知漏洞。
   */
  readonly versions: {
    readonly app: string;
    readonly electron: string;
    readonly chrome: string;
  };
  /**
   * 模型 API 代理（仅桌面端）。
   *
   * 桌面端页面从 `file://` 加载，浏览器 CORS 会挡住大多数服务商；
   * 主进程发请求没有同源策略，所以由它转发。
   * 浏览器里没有这个方法，调用前必须判空 —— `createChatFetch()` 负责这件事。
   */
  readonly chat?: (request: {
    url: string;
    apiKey: string;
    body: string;
    timeoutMs?: number;
  }) => Promise<
    | { ok: true; status: number; text: string }
    | { ok: false; kind: string; message: string }
  >;

  /**
   * 本机 MinerU 转换（仅桌面端）。
   *
   * 浏览器里没有这个对象 —— 页面必须判空，并用「这台机器用不了 MinerU」
   * 的文案如实说明，而不是摆一个点了才报错的按钮。
   * 判空与降级集中在 `core/mineru/runner.ts` 的 getMinerURunner()。
   */
  readonly mineru?: {
    /** 主进程启动时探测的结果 */
    readonly available: boolean;
    readonly unavailableReason?: string;
    /** 取 File 在磁盘上的绝对路径；拿不到返回 null */
    pathOf: (file: File) => string | null;
    /** 登记「这份资料的原文件在哪」 */
    rememberPath: (sourceId: string, filePath: string) => Promise<boolean>;
    /** 按 sourceId 取回原文件路径；没登记或文件已不在返回 null */
    sourcePath: (sourceId: string) => Promise<string | null>;
    /**
     * 弹出系统文件选择框让用户指一次原文件。
     * 兜底：升级前导入的资料没有路径记录。用户取消返回 null。
     */
    pickSourceFile: (sourceId: string, title?: string) => Promise<string | null>;
    /** 跑一次转换 */
    run: (request: {
      filePath: string;
      exePath: string;
      outDir: string;
      tier?: string;
      /** 页范围（2026-11-11）：「all」或「3-15」。不传 = 整份 */
      pages?: string;
    }) => Promise<
      { ok: true; result: unknown } | { ok: false; message: string; trouble?: string }
    >;
    /** 订阅进度，返回取消订阅函数 */
    onProgress: (
      cb: (p: { phase: string; ratio: number | null; detail?: string | null; line?: string }) => void,
    ) => () => void;
    /**
     * 按 locator 取一张插图（2026-11-08）。
     *
     * 返回的 `dataUri` 可直接当 `<img src>` 用 —— 渲染进程没有 fs 权限，
     * 拿不到文件路径，只能走 data URI。
     *
     * ⚠️ locator 依赖 MinerU 自己的解析缓存，缓存被清就永久失效
     * （实测见 electron/mineru-figure.cjs 顶部）。所以必须在转换完成后
     * 立刻取，不能留到用户点开阅读器时。
     */
    readFigure: (locator: string) => Promise<
      | {
          ok: true;
          dataUri: string;
          mimeType: string;
          width: number;
          height: number;
          byteSize: number;
          /** 实际走的取图方式，如实记录便于排查 */
          via: 'http' | 'cli';
        }
      | { ok: false; error: string; trouble?: string }
    >;
  };
}

interface Window {
  /**
   * 只在 Electron 中由 preload 注入；浏览器里为 undefined。
   * 因此使用时必须判空 —— detectEnv() 就是靠它判断运行环境的。
   */
  readonly openleaner?: OpenLeanerBridge;
}

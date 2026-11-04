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
}

interface Window {
  /**
   * 只在 Electron 中由 preload 注入；浏览器里为 undefined。
   * 因此使用时必须判空 —— detectEnv() 就是靠它判断运行环境的。
   */
  readonly openleaner?: OpenLeanerBridge;
}

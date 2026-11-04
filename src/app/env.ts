/**
 * 运行环境探测。
 *
 * 目的不是「炫技式区分平台」，而是决定几件实际的事：
 *  - 桌面端可以后续用 IPC 做原生文件对话框与大文件存储（P1）
 *  - 浏览器端只能用 File API 与 IndexedDB
 *  - 界面上给用户看的说法要跟着变（「桌面端」而不是「浏览器」）
 */
export function detectEnv(): 'web' | 'desktop' | 'test' {
  if (typeof window === 'undefined') return 'test';
  // Electron 预加载脚本会挂上这个标记（见 electron/preload.cjs）。
  // 检查 isElectron 而不是只判断对象存在：万一将来有别人往 window 上挂了
  // 同名对象（插件、扩展），也不会把浏览器误判成桌面端。
  if (window.openleaner?.isElectron === true) return 'desktop';
  return 'web';
}

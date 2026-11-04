// ==========================================================================
// OpenLeaner · Electron preload
// ==========================================================================
// 为什么是 .cjs：主进程也是 CommonJS（package.json 里 "type": "module"）。
//
// 这个文件运行在「隔离的 preload 上下文」里：
//   - 能看到 Node 的少量 API（sandbox: true 时只能 require electron 等白名单模块）
//   - 通过 contextBridge 往页面注入 window.openleaner
//   - 页面脚本永远拿不到 require / ipcRenderer 本体，只能调用我们显式暴露的方法
//
// ---------------------------------------------------------------------------
// P0 现状：只暴露只读的运行环境信息，没有任何 IPC。
// 学习数据全部存在渲染进程的 IndexedDB 里，主进程不参与。
//
// ---------------------------------------------------------------------------
// P1 要加文件读写时，按这个顺序改（不要绕开 contextBridge 直接把 ipcRenderer 暴露出去）：
//
//   1) main.cjs 里注册 handler：
//        const { ipcMain } = require('electron');
//        ipcMain.handle('openleaner:import-material', async (event, { filters }) => {
//          // 校验参数 → 弹 dialog → 读文件 → 返回 { canceled, name, bytes }
//        });
//
//   2) 这个文件里加一个受控包装（下面已有 ipcRenderer 的按需引入示例）：
//        const { ipcRenderer } = require('electron');
//        importMaterial: (options) => ipcRenderer.invoke('openleaner:import-material', options),
//
//   3) 只暴露「语义化方法」（importMaterial / exportDeck），
//      不要暴露通用的 invoke(channel, ...)，否则等于把整个 IPC 面开给页面。
//
//   4) 面向页面的类型声明写在 src/ 里（例如 src/types/openleaner.d.ts），
//      不要在这个 .cjs 文件里写 TypeScript 语法 —— 它不经过 tsc 编译。
// ==========================================================================

const { contextBridge } = require('electron');

// --------------------------------------------------------------------------
// 运行环境信息：只读、无副作用。
// 页面用它做平台相关的细节（快捷键提示、窗口拖拽区、版本号展示）。
// --------------------------------------------------------------------------

/**
 * 应用版本号由主进程通过 webPreferences.additionalArguments 传进来。
 * 为什么不用 require('../package.json')：sandbox: true 的 preload 里没有 fs，
 * 读不了文件；而关掉 sandbox 只为了读一个版本号，不值得。
 *
 * 注意：沙箱里的 `process` 是精简版，argv 不一定存在，所以每一步都要能降级。
 */
function readAppVersion() {
  try {
    const flag = '--openleaner-app-version=';
    const argv = Array.isArray(process.argv) ? process.argv : [];
    const arg = argv.find((item) => typeof item === 'string' && item.startsWith(flag));
    return arg ? arg.slice(flag.length) : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 同上：沙箱里的 process 是精简版，取不到就给 'unknown'，不要抛。 */
function readVersion(name) {
  try {
    return process.versions?.[name] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const platform = (() => {
  try {
    return process.platform;
  } catch {
    return 'unknown';
  }
})(); // 'win32' | 'darwin' | 'linux'

const openleanerApi = Object.freeze({
  /** 'win32' | 'darwin' | 'linux'。页面用它区分 Ctrl / Cmd 的快捷键文案。 */
  platform,

  /** 是否运行在 Electron 壳里。浏览器里访问 window.openleaner 是 undefined。 */
  isElectron: true,

  /**
   * 版本号快照。
   * 只放这三个，不要把整个 process.versions 丢出去 ——
   * 暴露 Node/Chromium 的精确版本会方便攻击者挑选已知漏洞。
   */
  versions: Object.freeze({
    app: readAppVersion(),
    electron: readVersion('electron'),
    chrome: readVersion('chrome'),
  }),

  // ------------------------------------------------------------------------
  // P1 预留位（现在故意留空，避免页面误以为「还没有就是坏了」）
  // ------------------------------------------------------------------------
  // files: {
  //   importMaterial: (options) => ipcRenderer.invoke('openleaner:import-material', options),
  //   exportDeck: (options) => ipcRenderer.invoke('openleaner:export-deck', options),
  // },
});

// contextIsolation 打开时用 contextBridge；这里加一道保险，
// 万一将来有人把 contextIsolation 关掉，也不要静默地什么都不暴露。
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('openleaner', openleanerApi);
  } catch (error) {
    console.error('[openleaner] 暴露 preload API 失败:', error);
  }
} else {
  // 走到这里说明安全基线被破坏了，只记录不兜底 —— 兜底等于悄悄降级安全性
  console.error('[openleaner] contextIsolation 被关闭，preload 不会暴露 API');
}

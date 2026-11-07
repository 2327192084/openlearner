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

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 取一个 File 对象在磁盘上的绝对路径。
 *
 * ## 为什么需要它
 *
 * 渲染进程拿到的 `File` 对象只有名字和字节，**没有真实路径** ——
 * 这是浏览器的安全设计。但本机 MinerU 需要路径：它是个命令行程序，
 * 只能读文件，不能接收一个「页面里的 File」。
 *
 * Electron 在 32 版之后把 `File.path` 移除了，改成 `webUtils.getPathForFile`。
 * 这个 API 只在 preload 里可用，所以必须从这里暴露出去。
 *
 * ## 为什么返回路径是安全的
 *
 * 路径来自用户**自己在文件选择框里选的文件**（或拖进来的文件），
 * 页面对它没有凭空构造的能力。这不是把任意 fs 能力交给页面。
 */
function getPathForFile(file) {
  try {
    // 运行时才有 webUtils；打包后一定存在，dev 里可能没有就要降级
    const { webUtils } = require('electron');
    if (webUtils && typeof webUtils.getPathForFile === 'function') {
      return webUtils.getPathForFile(file) || null;
    }
  } catch {
    /* 降级到下面的老办法 */
  }
  // 老版本 Electron / 某些构建里 file.path 还在
  try {
    return typeof file?.path === 'string' && file.path ? file.path : null;
  } catch {
    return null;
  }
}

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

  /**
   * 模型 API 代理。
   *
   * 桌面端页面从 `file://` 加载，浏览器 CORS 会把大多数服务商挡在门外
   * （DeepSeek 放行任意 origin，智谱/通义/中转站基本不放行）。
   * 主进程发请求没有同源策略，所以走这里转发。
   *
   * 只暴露这一个语义化方法，不暴露通用 invoke ——
   * 通用 invoke 等于把整个 IPC 面交给页面。
   *
   * 参数与返回值都是纯数据（字符串进、字符串出），
   * 这样渲染进程不需要为 IPC 单独做序列化，core 层也能直接注入这个函数当 fetchImpl。
   */
  chat: (request) => ipcRenderer.invoke('openleaner:chat-completion', request),

  /**
   * 本机 MinerU 转换（扫描件 / 图片 → 带页码的正文）。
   *
   * ## 为什么必须走主进程
   *
   * 渲染进程没有 Node 权限（nodeIntegration: false，这条边界不能为省事关掉），
   * 而 MinerU 是一个 Python 可执行文件，必须 spawn 子进程。
   * 所以只有主进程能跑，页面通过这一个受限方法请求它。
   *
   * ## 为什么不是通用 invoke
   *
   * 通用 invoke 等于把整个 IPC 面交给页面 —— 任何被注入的脚本都能调
   * 任意 handler。这里只暴露两个语义化方法（run / onProgress），
   * 主进程侧再对路径与参数做一次校验。
   *
   * ## 进度
   *
   * MinerU 跑一本 628 页的教材要几分钟，没有进度用户会以为卡死了。
   * 主进程把 stderr 的行转成事件推过来；onProgress 返回取消订阅函数，
   * 组件卸载时必须调用，否则会往已卸载的组件里写状态。
   */
  mineru: Object.freeze({
    /** 主进程是否报告本机 MinerU 可用（启动时探测一次） */
    get available() {
      // 同步可用性以主进程启动探测结果为准；未探到时按「不可用」处理，
      // 由页面显示具体原因，而不是给一个点了才报错的按钮。
      return ipcRenderer.sendSync('openleaner:mineru-available-sync') === true;
    },

    get unavailableReason() {
      return ipcRenderer.sendSync('openleaner:mineru-reason-sync') ?? undefined;
    },

    /**
     * 取 File 在磁盘上的绝对路径。拿不到返回 null。
     *
     * 导入资料时把它连同 sourceId 一起登记给主进程，
     * 之后转换扫描件时主进程就能按 sourceId 找回原路径。
     */
    pathOf: (file) => getPathForFile(file),

    /** 登记「这份资料的原文件在哪个路径」。sourceId 由页面生成后传进来。 */
    rememberPath: (sourceId, filePath) =>
      ipcRenderer.invoke('openleaner:remember-source-path', { sourceId, filePath }),

    /** 取回某份资料的原文件路径。没有登记过就返回 null。 */
    sourcePath: (sourceId) => ipcRenderer.invoke('openleaner:source-path', sourceId),

    /**
     * 弹出系统文件选择框，让用户指一次原文件。
     *
     * 兜底用：升级前导入的资料没有路径记录，或原文件被移动过。
     * 挑完主进程会顺手登记，下次直接命中。
     * 用户取消返回 null（不当作错误）。
     */
    pickSourceFile: (sourceId, title) =>
      ipcRenderer.invoke('openleaner:pick-source-file', { sourceId, title }),

    /** 跑一次转换。返回值形状与主进程 handler 一致。 */
    run: (request) => ipcRenderer.invoke('openleaner:mineru-convert', request),

    /**
     * 订阅进度。返回取消订阅函数。
     *
     * 只转发带 taskId 属于自己的事件 —— 同一时刻可能有多份资料在排队，
     * 不过滤会把别人的进度显示进来。
     */
    onProgress: (cb) => {
      const listener = (_event, payload) => {
        try {
          cb(payload);
        } catch {
          /* 回调异常不该影响主进程 */
        }
      };
      ipcRenderer.on('openleaner:mineru-progress', listener);
      return () => ipcRenderer.removeListener('openleaner:mineru-progress', listener);
    },
  }),
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

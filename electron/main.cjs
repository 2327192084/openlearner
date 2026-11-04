// ==========================================================================
// OpenLeaner · Electron 主进程
// ==========================================================================
// 为什么是 .cjs：package.json 里 "type": "module"，Node 会把 .js 当 ESM 解析。
// Electron 主进程用 CommonJS（require/__dirname）最稳，所以显式用 .cjs。
//
// 职责边界（P0）：
//   - 只负责「开一个窗口把渲染进程装进去」，不做文件存储。
//   - 学习数据全在渲染进程的 IndexedDB 里，主进程不碰。
//   - P1 会需要「导入本地教材 / 导出 PPT」这类真实文件读写，那时候
//     在主进程加 IPC handler、在 preload 里加对应的 contextBridge 方法即可，
//     preload 里已经预留了位置和注释（见 preload.cjs）。
// ==========================================================================

const { app, BrowserWindow, Menu, shell, dialog, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// --------------------------------------------------------------------------
// 常量
// --------------------------------------------------------------------------

/** 开发模式：electron:dev 脚本里由 cross-env 注入。生产构建时为 undefined。 */
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

const IS_DEV = Boolean(DEV_SERVER_URL);

/** 构建产物入口。vite.config.ts 里 base: './'，所以 file:// 加载能正常解析相对资源。 */
const INDEX_HTML = path.join(__dirname, '..', 'dist', 'index.html');

/** 窗口尺寸：1280x820 是「一个屏幕放得下教材 + 习题」的舒适宽度。 */
const WINDOW_DEFAULTS = {
  width: 1280,
  height: 820,
  minWidth: 960,
  minHeight: 640,
};

/**
 * 窗口状态持久化：记住上次的尺寸与位置，关掉重开不会跳回默认大小。
 * 存到 userData 目录下，不污染项目目录。
 */
const STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

/** 允许用系统浏览器打开的外部协议白名单。只放 http/https，其它一律拒绝。 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);

// --------------------------------------------------------------------------
// 窗口状态读写（失败静默降级到默认值，不能因为一个坏 JSON 打不开软件）
// --------------------------------------------------------------------------

function loadWindowState() {
  try {
    const raw = fs.readFileSync(STATE_FILE(), 'utf-8');
    const parsed = JSON.parse(raw);
    const state = {};

    // 只接受合理数值，防止手改成 NaN / 负数导致窗口不可见
    for (const key of ['width', 'height']) {
      if (Number.isFinite(parsed[key]) && parsed[key] >= 400) {
        state[key] = Math.round(parsed[key]);
      }
    }
    for (const key of ['x', 'y']) {
      if (Number.isFinite(parsed[key])) {
        state[key] = Math.round(parsed[key]);
      }
    }
    if (typeof parsed.maximized === 'boolean') {
      state.maximized = parsed.maximized;
    }

    // 尺寸不能小于最小尺寸，否则拖到一半的窗口会卡死在不可用的大小
    if (state.width !== undefined) {
      state.width = Math.max(state.width, WINDOW_DEFAULTS.minWidth);
    }
    if (state.height !== undefined) {
      state.height = Math.max(state.height, WINDOW_DEFAULTS.minHeight);
    }

    return state;
  } catch {
    return {};
  }
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.getNormalBounds(); // maximized 时拿还原后的尺寸，不然下次开窗就是全屏
    const state = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: win.isMaximized(),
    };
    fs.writeFileSync(STATE_FILE(), JSON.stringify(state), 'utf-8');
  } catch {
    // 磁盘满 / 权限问题不该影响关窗，吞掉
  }
}

// --------------------------------------------------------------------------
// 安全策略
// --------------------------------------------------------------------------

/**
 * 把窗口内的一切导航关进笼子。
 * 规则：本窗口只允许停留在「自己的页面」上（file:// 的 dist，或开发服务器）；
 * 任何指向外部的跳转都交给系统浏览器，绝不在 Electron 窗口里打开。
 */
function lockDownNavigation(win) {
  const allowedOrigin = IS_DEV ? new URL(DEV_SERVER_URL).origin : 'file://';

  // 整窗跳转（点 <a href> 或 location.href = ...）
  win.webContents.on('will-navigate', (event, url) => {
    let allowed = false;
    try {
      const target = new URL(url);
      allowed = IS_DEV ? target.origin === allowedOrigin : target.protocol === 'file:';
    } catch {
      allowed = false;
    }

    if (!allowed) {
      event.preventDefault();
      openExternalSafely(url);
    }
  });

  // 新窗口（target="_blank"、window.open）。一律拒绝，改成外部浏览器。
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });

  // webview 一律不挂载（P0 用不到，攻击面上限比功能收益大）
  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

/**
 * 只允许 http/https 交给系统浏览器。
 * 拦截 javascript:、file:、以及自定义协议——这些是常见的逃逸手法。
 */
function openExternalSafely(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) return;
  void shell.openExternal(parsed.toString());
}

// --------------------------------------------------------------------------
// 菜单：精简版。保留「重载 / 开发者工具 / 缩放」，去掉用不到的一大堆项
// --------------------------------------------------------------------------

function buildMenu() {
  const isMac = process.platform === 'darwin';

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: '文件',
      submenu: [isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        // 开发者工具只在开发模式给入口；生产环境不暴露
        ...(IS_DEV ? [{ role: 'toggleDevTools', label: '开发者工具' }] : []),
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        ...(isMac
          ? [{ role: 'zoom', label: '缩放' }, { type: 'separator' }, { role: 'front', label: '前置全部窗口' }]
          : [{ role: 'close', label: '关闭' }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --------------------------------------------------------------------------
// 建窗
// --------------------------------------------------------------------------

/** @type {BrowserWindow | null} */
let mainWindow = null;

function createWindow() {
  const savedState = loadWindowState();

  mainWindow = new BrowserWindow({
    width: savedState.width ?? WINDOW_DEFAULTS.width,
    height: savedState.height ?? WINDOW_DEFAULTS.height,
    minWidth: WINDOW_DEFAULTS.minWidth,
    minHeight: WINDOW_DEFAULTS.minHeight,
    ...(savedState.x !== undefined && savedState.y !== undefined
      ? { x: savedState.x, y: savedState.y }
      : {}),
    // 先隐藏，等首帧画完再显示 —— 避免白屏闪一下再出现内容
    show: false,
    // 背景色对齐 --c-bg (#f7f8fa)，窗口出现时不会闪白/闪黑
    backgroundColor: '#f7f8fa',
    title: 'OpenLeaner',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      // 把版本号传给 preload：sandbox 下 preload 读不了 package.json，
      // 而为了一个版本号关掉沙箱不值得。
      additionalArguments: [`--openleaner-app-version=${app.getVersion()}`],
      // ---- 安全基线，这几个不要为了图方便改 ----
      contextIsolation: true, // preload 与页面脚本上下文隔离
      nodeIntegration: false, // 页面里没有 require / process
      sandbox: true, // 渲染进程跑在 Chromium 沙箱里
      webSecurity: true, // 保持同源策略
      allowRunningInsecureContent: false,
      webviewTag: false, // 禁用 <webview>
      // 渲染进程不需要连数据库/硬件，只开最基础的能力
      spellcheck: true,
    },
  });

  // 首帧就绪后再显示
  mainWindow.once('ready-to-show', () => {
    if (savedState.maximized) {
      mainWindow.maximize();
    }
    mainWindow.show();
  });

  // 开发模式下自动打开 DevTools（也方便无头环境确认页面真的加载了）
  if (IS_DEV) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  lockDownNavigation(mainWindow);

  // ---- 加载页面 ----
  // 开发：连 Vite dev server，有 HMR
  // 生产：loadFile 走 file://，vite 的 base: './' 保证资源相对路径可用
  if (IS_DEV) {
    void mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    if (!fs.existsSync(INDEX_HTML)) {
      // 没构建就来跑生产模式，给一个明确的中文提示而不是 blank 窗口
      void dialog.showMessageBox({
        type: 'error',
        title: '未找到构建产物',
        message: 'dist/index.html 不存在。',
        detail:
          '生产模式需要先执行 npm run build 生成 dist/。\n' +
          '如果你是想调试界面，用 npm run electron:dev。',
        buttons: ['好'],
      });
      app.quit();
      return;
    }
    void mainWindow.loadFile(INDEX_HTML);
  }

  // 加载失败时把真实原因写到控制台（不然只有一片白屏，没法排查）
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    // -3 = ERR_ABORTED，通常是导航被我们自己取消，不是错误
    if (errorCode === -3) return;
    console.error(`[openleaner] 页面加载失败 (${errorCode} ${errorDescription}): ${validatedURL}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[openleaner] 渲染进程崩溃:', details.reason, details.exitCode);
  });

  // 记住窗口状态：移动/缩放时防抖保存，关闭前再存一次
  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(mainWindow), 400);
  };
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('move', scheduleSave);

  mainWindow.on('closed', () => {
    if (saveTimer) clearTimeout(saveTimer);
    mainWindow = null;
  });
}

// --------------------------------------------------------------------------
// 应用生命周期
// --------------------------------------------------------------------------

// 单实例锁：双击第二次不要开第二个窗口，直接聚焦已存在的那个。
// 学习软件的状态在 IndexedDB 里，多个实例同时写同一个 profile 容易互相踩。
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // 明确设置 AppUserModelId，Windows 任务栏图标与通知才能正确归组
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.openleaner.app');
  }

  // 生产环境下禁用 Chromium 的某些自动化友好特性并不必要；
  // 但渲染进程的权限请求（摄像头/麦克风/通知）P0 用不到，一律拒绝。
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      // P0 只需要剪贴板写入（复制引用文本时可能用到）
      const allowed = new Set(['clipboard-sanitized-write']);
      callback(allowed.has(permission));
    });

    buildMenu();
    createWindow();

    // macOS：点 Dock 图标且没有窗口时重新开一个
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // macOS 的惯例是关窗不退出，其它平台退出
    if (process.platform !== 'darwin') app.quit();
  });

  // 关闭前保存最后一次窗口状态（closed 事件里 win 还在，可以取 bounds）
  app.on('before-quit', () => {
    saveWindowState(mainWindow);
  });
}

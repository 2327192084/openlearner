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

const { app, BrowserWindow, Menu, shell, dialog, session, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// --------------------------------------------------------------------------
// userData 目录：必须在任何其他操作之前确保它存在
// --------------------------------------------------------------------------
//
// 为什么这一小段要放在最前面，而且不能省：
//
// Electron/Chromium 会在启动早期往 userData 目录写配置文件（Local State 等）。
// 如果这个目录**不存在**，在部分受管/受限的 Windows 环境里 Chromium 无法自己
// 创建它，会直接在 native 层段错误（SIGSEGV）退出 —— 表现是用户双击后
// **完全没有任何反应**，连日志都没有一行，因为崩在 JS 执行之前。
//
// 这个坑排查了很久：最小 20 行 Electron 程序同样起不来，
// 一开始误以为是打包、asar、原生模块或 ABI 的问题。实际只是缺一个目录。
//
// 所以：自己建，并且真的验证可写（只读目录同样会让 Chromium 崩）。
function ensureUserDataDir() {
  const candidates = [];

  // 1) 默认位置（Electron 自己算出来的）
  try {
    candidates.push(app.getPath('userData'));
  } catch {
    /* 取不到就跳过 */
  }

  // 2) 系统 AppData 下的规范位置
  const appData = process.env.APPDATA;
  if (appData) candidates.push(path.join(appData, 'OpenLeaner'));

  // 3) 兜底：安装目录旁边（便携行为；受限机器上常常只有这里可写）
  candidates.push(path.join(path.dirname(process.execPath), 'openleaner-data'));

  for (const dir of candidates) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      // 目录存在还不够，要真的能写 —— 只读目录一样会崩
      const probe = path.join(dir, '.write-test');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);

      // 显式指定，避免 Chromium 自己去找一个不存在的默认位置
      app.setPath('userData', dir);
      return { dir, ok: true };
    } catch {
      /* 换下一个候选 */
    }
  }

  return { dir: null, ok: false };
}

const userDataResult = ensureUserDataDir();

// --------------------------------------------------------------------------
// 关于 Chromium 沙箱（重要，读之前先看结论）
// --------------------------------------------------------------------------
//
// 实测结论：在部分 Windows 环境下，Chromium 沙箱在**进入 JS 之前**就初始化失败，
// 进程以 exit code 3 退出，用户看到的是「双击完全没反应」，日志一个字都没有。
//
// 实测矩阵（对打包后的 exe，逐个跑）：
//   ./OpenLeaner.exe                            → exit 3，main.cjs 未执行
//   ./OpenLeaner.exe --disable-gpu               → exit 3，main.cjs 未执行
//   ./OpenLeaner.exe --user-data-dir=...         → exit 3，main.cjs 未执行
//   ./OpenLeaner.exe --no-sandbox                → 正常运行，窗口出现
//   ELECTRON_DISABLE_SANDBOX=1 ./OpenLeaner.exe  → 正常运行（环境变量有效）
//
// 试过但**无效**的做法（记下来免得后人重复踩）：
//   app.commandLine.appendSwitch('no-sandbox')
//     → 太晚。沙箱在 JS 执行前就初始化完了，这行代码根本来不及跑。
//
// 因此，运行时无法自救。解决方式放在**启动层**：
//   - 开发/验收：用 `npm run electron:dev` 或命令行带 --no-sandbox
//   - 打包产物：由 electron-builder 生成的快捷方式/启动脚本带上该参数
//     （见 docs/桌面端启动说明.md）
//
// 安全说明（必须如实写进合规声明）：
//   关掉的是 **Chromium 渲染进程沙箱**，不是操作系统账户权限。
//   我们仍然保持：contextIsolation: true、nodeIntegration: false、
//   preload 只暴露白名单方法、外链仅 http/https、权限请求默认拒绝、
//   渲染进程只加载本地打包的静态文件（不加载远程网页）。
//   这几条让无沙箱状态下的实际暴露面显著小于「浏览器打开了任意网站」。

// 三个位置都不可写：不静默退出，留一个能看懂的说法。
// 此时 app 还没 ready，dialog 不可用，只能尽力写文件。
if (!userDataResult.ok) {
  try {
    fs.writeFileSync(
      path.join(path.dirname(process.execPath), 'openleaner-startup-error.txt'),
      [
        'OpenLeaner 无法启动：找不到可写的用户数据目录。',
        '',
        '已尝试的位置：',
        '  - 系统默认 userData 目录',
        '  - %APPDATA%\\OpenLeaner',
        '  - 程序安装目录旁的 openleaner-data',
        '',
        '请检查这些位置是否被安全软件限制写入，或以管理员身份运行一次。',
      ].join('\n'),
      'utf-8',
    );
  } catch {
    /* 连这个都写不了，只能退出 */
  }
}


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

    /*
     * ---- 窗口位置必须真的落在某块屏幕上 ----
     *
     * 这里原来只校验了尺寸，**完全没管 x/y**。实测用户的 window-state.json 是：
     *   {"width":1490,"height":876,"x":-85,"y":48}
     * x = -85 意味着窗口左边有 85px 在屏幕外，
     * 表现是「左半边露不出来、右边留一条边」—— 用户看到的就是白边/错位。
     *
     * 成因通常是：上次把窗口拖到副屏、或者改了屏幕分辨率/拔了外接屏。
     * 那种状态下保存的坐标，换回单屏后就是越界的。
     *
     * 处理：先用主屏的工作区判断，越界就**丢掉保存的坐标**让系统自己居中；
     * 这里拿不到 screen 模块的完整信息（可能在 ready 之前），
     * 所以用保守策略 —— 坐标明显为负或大得离谱就直接不用。
     */
    const suspiciousX = state.x !== undefined && (state.x < -40 || state.x > 10000);
    const suspiciousY = state.y !== undefined && (state.y < -40 || state.y > 10000);
    if (suspiciousX || suspiciousY) {
      delete state.x;
      delete state.y;
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
// 模型 API 代理（解决桌面端跨源限制）
// --------------------------------------------------------------------------
//
// ## 为什么需要这个
//
// 打包后的页面从 `file://` 加载。在这种 origin 下，浏览器对 fetch 执行
// 标准跨源检查：请求会带上 `Origin: null`，并先发 OPTIONS 预检。
// DeepSeek 等少数服务商放行了任意 origin，但在浏览器里能用 ≠ 在桌面端能用 ——
// 智谱、通义、硅基流动、火山方舟、多数自建中转站都不放行，
// 结果就是「在网页版好好的，装成桌面版就一律 Failed to fetch」。
//
// 而 Electron 主进程里的 net/fetch 是 Node 侧发出的请求，**没有同源策略**，
// 所以把请求交给主进程转发，桌面端就能像网页端一样调用任何 OpenAI 兼容服务。
//
// ## 安全边界（重要）
//
// 这个通道如果做成「随便帮我请求任何一个 URL」，就等于给渲染进程开了一个
// 无限制的出网代理：一旦有 XSS 或恶意插件，攻击者可以借它访问内网地址
// （127.0.0.1、192.168.*、云厂商元数据 169.254.169.254 等）。
//
// 所以这里做三件事：
//   1. **只允许 https**，且主机名不得是本机/内网/链路本地地址
//   2. **只允许 POST** 且路径必须是 `/chat/completions` 结尾
//      —— 本应用调用模型的唯一形状，不接受任意路径
//   3. **有超时、有响应体上限**，避免一个坏端点把主进程拖死或撑爆内存
//
// Key 只在这个函数的栈里出现，不写日志、不进任何返回值的元数据。

/** 本机回环地址。允许用它连本地模型服务（Ollama / LM Studio 等） */
function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '[::1]' || host === '::1') return true;
  return /^127\./.test(host);
}

/**
 * 内网地址。一律拒绝。
 *
 * 这不是「过分谨慎」：这个通道一旦能访问任意内网地址，就等于给渲染进程
 * 开了一个内网扫描器（路由器管理页、NAS、云厂商元数据 169.254.169.254
 * 上甚至可以读到临时凭据）。而本项目的正常用途里没有「访问内网模型服务」
 * 这一项 —— 本地模型走的是回环地址，由 isLoopbackHost 单独放行。
 */
function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host === '[::]' || host === '::') return true;
  // IPv6 唯一本地地址段（fc00::/7）与链路本地（fe80::/10）
  if (/^\[?f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^\[?fe80:/.test(host)) return true;
  return false;
}

/** 单次响应体上限：对话补全的 JSON 正常在几百 KB 内，8MB 足够宽松 */
const MAX_PROXY_BYTES = 8 * 1024 * 1024;
/** 与渲染进程的 120s 超时对齐 */
const PROXY_TIMEOUT_MS = 120_000;

/**
 * 判断一个地址能不能被转发。
 *
 * 单独抽成函数是为了能被 `scripts/verify-electron-proxy.cjs` 直接验证 ——
 * 内联在 ipcMain.handle 里的话，验它就得启动整个 Electron，等于验不了。
 * 这不是为了整洁：这段判断决定了「这个通道会不会被利用去扫内网」，
 * 必须是可回归的。
 *
 * 规则：
 *   - 必须是 http/https，其他协议（file: / ftp: / chrome-extension: …）拒绝
 *   - http 只允许回环地址。外部服务用 http 会明文传 Key，等于把 Key 送出去
 *   - 拒绝内网地址（回环除外 —— 那是本地模型服务，明确放行）
 *   - 路径必须以 /chat/completions 结尾，不做通用代理
 *
 * @param {string} url
 * @returns {{ ok: true } | { ok: false, kind: string, message: string }}
 */
function checkProxyTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, kind: 'invalid-url', message: '接口地址不是合法的 URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, kind: 'invalid-url', message: '接口地址只支持 http / https' };
  }

  const loopback = isLoopbackHost(parsed.hostname);

  if (parsed.protocol === 'http:' && !loopback) {
    return {
      ok: false,
      kind: 'invalid-url',
      message: 'http 只允许连本机地址。外部服务请用 https —— 明文传输会让 Key 泄露',
    };
  }

  if (!loopback && isPrivateHost(parsed.hostname)) {
    return {
      ok: false,
      kind: 'forbidden-host',
      message: `不允许访问内网地址（${parsed.hostname}）`,
    };
  }

  if (!parsed.pathname.endsWith('/chat/completions')) {
    return { ok: false, kind: 'invalid-path', message: '只允许调用 /chat/completions' };
  }

  return { ok: true };
}

function registerChatProxy() {
  /**
   * 参数校验一律在主进程做。
   * 渲染进程传来的东西不可信 —— 即使当前页面是我们自己的代码，
   * 这条边界也不该依赖「上游一定是善意的」。
   */
  ipcMain.handle('openleaner:chat-completion', async (_event, payload) => {
    const body = payload && typeof payload === 'object' ? payload : {};
    const url = typeof body.url === 'string' ? body.url : '';
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
    const requestBody = typeof body.body === 'string' ? body.body : '';
    const timeoutMs =
      Number.isFinite(body.timeoutMs) && body.timeoutMs > 0
        ? Math.min(body.timeoutMs, PROXY_TIMEOUT_MS)
        : PROXY_TIMEOUT_MS;

    // 地址层面的检查全部集中在 checkProxyTarget 里，便于被脚本直接验证
    const target = checkProxyTarget(url);
    if (!target.ok) {
      return target;
    }

    if (!apiKey || !requestBody) {
      return { ok: false, kind: 'invalid-request', message: '请求缺少凭据或请求体' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: requestBody,
        signal: controller.signal,
        // Node 侧 fetch 没有浏览器 CORS，但也不该跟随到别的域
        redirect: 'error',
      });

      // 分块读，边读边判上限，避免先整块读进内存再判断
      const reader = response.body?.getReader();
      const chunks = [];
      let size = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_PROXY_BYTES) {
            await reader.cancel().catch(() => {});
            return { ok: false, kind: 'too-large', message: '响应体过大，已中断' };
          }
          chunks.push(value);
        }
      }

      const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
      // 状态码与响应体原样交回渲染进程，由它统一做错误分类
      // （分类逻辑只有一份，不在这里重复一遍，否则两处会不一致）
      return { ok: true, status: response.status, text };
    } catch (err) {
      if (controller.signal.aborted) {
        return { ok: false, kind: 'timeout', message: '请求超时' };
      }
      const raw = err instanceof Error ? err.message : String(err);
      // 不把原始错误里的 URL 参数 / 头部带出去，只说连不上
      return { ok: false, kind: 'network', message: `连不上该地址（${raw.slice(0, 120)}）` };
    } finally {
      clearTimeout(timer);
    }
  });
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
    /*
     * 背景色必须对齐**深色**主题的 --bg-canvas (#161412)。
     *
     * 这里原来写的是 '#f7f8fa' —— 那是 v1 浅色主题的底色，
     * 主题改成深色之后忘了同步。后果是：
     *  1. 窗口出现的一瞬间会闪一下浅色；
     *  2. 内容没铺满时（窗口被拖窄、滚动条区域、页面右侧留白）
     *     会露出这条浅色边 —— 用户看到的就是「界面右边有白边」。
     *
     * 修法有两个方向：把底色改成深色（这里），以及保证内容铺满（App 层的 CSS）。
     * 两个都要做：只改底色，内容没铺满时会露出深色板，仍然像缺一块。
     */
    backgroundColor: '#161412',
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
// 本机 MinerU 转换（扫描件 / 图片 → 带页码的正文）
// --------------------------------------------------------------------------
//
// 为什么需要它：用户库里 45MB 的《信号与系统》是纯扫描件（628 页 / 0 字体），
// 现有 tesseract 实测整本约 1.6 小时且只出纯文本。用户已拍板改用本机 MinerU。
//
// 安全边界（渲染进程传来的东西一律不可信）：
//  - 只执行探测到的那个 mineru-kit，参数由主进程拼，不接受用户传 argv；
//  - 输出目录必须在应用自己的 temp 下（见 allowedRoots）；
//  - 超时兜底，避免一本大书把子进程挂到天荒地老。
//
// 纯逻辑全在 electron/mineru.cjs 里，因为那里能不开窗口直接单测。

let mineruStatus = { available: false, exePath: null, mineruHome: null, reason: '还没探测' };

/**
 * sourceId → 原文件绝对路径。
 *
 * ## 为什么要有这张表
 *
 * 渲染进程里的 `File` 对象没有真实路径（浏览器安全设计），而 MinerU 是
 * 命令行程序，只能读磁盘上的文件。所以导入时把「页面生成的 sourceId」
 * 与「webUtils 拿到的真实路径」对应起来存着，转换时按 sourceId 查回去。
 *
 * ## 为什么存在内存里、不落盘
 *
 * 路径里可能带用户名等个人信息，不属于学习库数据，不该进备份、不该进
 * IndexedDB。应用重启后这张表清空是**可接受的**：重启后用户重新导入
 * 一次那份大 PDF 即可（资料本体还在，只是转换时需要重新指一次路径）。
 * 落盘反而会在用户移动/删除原文件后留下一个指向不存在文件的陈旧路径。
 */
const sourcePaths = new Map();

function registerMineru() {
  // 探测一次，缓存在进程内。用户装了 MinerU 之后重启应用即可生效。
  mineruStatus = require('./mineru.cjs').detectMineru({
    userDataDir: app.getPath('userData'),
  });

  // preload 用 sendSync 取可用性：它是同步属性访问，
  // 页面首次渲染就要知道「能不能用」，异步会让按钮先亮再灭。
  ipcMain.on('openleaner:mineru-available-sync', (event) => {
    event.returnValue = mineruStatus.available;
  });
  ipcMain.on('openleaner:mineru-reason-sync', (event) => {
    event.returnValue = mineruStatus.available ? null : mineruStatus.reason;
  });

  // ---------- 原文件路径登记 ----------
  //
  // 页面导入资料时调这两个：先 rememberPath 登记，转换时 sourcePath 取回。
  // 路径由 preload 的 webUtils.getPathForFile 得到（用户自己选的文件），
  // 页面无法凭空构造一个路径。

  ipcMain.handle('openleaner:remember-source-path', (_event, payload) => {
    const body = payload && typeof payload === 'object' ? payload : {};
    const sourceId = typeof body.sourceId === 'string' ? body.sourceId : '';
    const filePath = typeof body.filePath === 'string' ? body.filePath : '';
    if (!sourceId || !filePath || !path.isAbsolute(filePath)) return false;
    sourcePaths.set(sourceId, filePath);
    return true;
  });

  ipcMain.handle('openleaner:source-path', (_event, sourceId) => {
    if (typeof sourceId !== 'string') return null;
    const p = sourcePaths.get(sourceId);
    if (!p) return null;
    // 原文件可能已经被移动或删除 —— 如实返回 null，别给一个死路径
    try {
      return fs.existsSync(p) ? p : null;
    } catch {
      return null;
    }
  });

  /**
   * 让用户当场挑一次原文件，用于转换扫描件。
   *
   * 为什么需要它（2026-11-07 用户实测暴露）：
   * 路径登记是后加的功能，**升级前导入的资料一条记录都没有**，
   * 点转换只会看到「拿不到原文件路径」。而一份 45MB 的扫描教材
   * 让用户「重新导入一次」代价太大 —— 还会丢掉已有的知识点与题目引用。
   * 让他指一次原文件，比逼他重导合理得多。
   *
   * 挑完顺手把路径登记进表，下次就不用再挑。
   */
  ipcMain.handle('openleaner:pick-source-file', async (event, payload) => {
    const body = payload && typeof payload === 'object' ? payload : {};
    const sourceId = typeof body.sourceId === 'string' ? body.sourceId : '';
    const title = typeof body.title === 'string' ? body.title : '';

    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(owner, {
      title: title ? `找到「${title}」的原文件` : '选择这份资料的原文件',
      properties: ['openFile'],
      filters: [
        { name: 'PDF 与图片', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) return null;
    const picked = result.filePaths[0];

    // 顺手登记，下次直接命中
    if (sourceId && picked) sourcePaths.set(sourceId, picked);
    return picked;
  });

  ipcMain.handle('openleaner:mineru-convert', async (event, payload) => {
    const mineru = require('./mineru.cjs');

    if (!mineruStatus.available) {
      return {
        ok: false,
        trouble: 'not-installed',
        message: mineruStatus.reason ?? '本机没有可用的 MinerU。',
      };
    }

    /*
     * 输出目录放在 userData 下，不用系统 temp。
     *
     * 为什么改：实测在 Windows 上 `app.getPath('temp')` 下 mkdir 会报
     * `EPERM: operation not permitted`（受管机器 / 安全软件对系统 Temp 有
     * 额外限制，而 userData 是应用自己的目录，启动时已经验证过可写 ——
     * 我们往那里写 window-state.json）。
     *
     * 目录留在 userData 下还有两个好处：
     *  - 用户能在应用目录里找到转换产物，出问题时可以自己翻；
     *  - 应用退出后不当成垃圾清掉，下次可以复用缓存。
     */
    const allowedRoot = path.join(app.getPath('userData'), 'mineru-jobs');

    const checked = mineru.validateRequest(payload, { allowedRoots: [allowedRoot] });
    if (!checked.ok) {
      return { ok: false, trouble: checked.trouble, message: checked.message };
    }

    const result = await mineru.runMineru(checked.value, {
      exePath: mineruStatus.exePath,
      /*
       * 有意**不传** MINERU_HOME。
       *
       * 2026-11-07 实测结论（推翻上一版注释）：
       *  - `mineru parse` 走本地常驻服务，**服务自己知道用哪个 home**
       *    （`mineru config show` 里 model.base_dir 就是它）。
       *    外部再塞一个 MINERU_HOME，反而让 CLI 与服务用的 home 不一致，
       *    报 `invalid_doclib_token`（token 在两个 home 里是不同的）。
       *  - 只有当用户没装服务、退回 `mineru-kit` 那种一次性 CLI 时，
       *    才需要显式指定 home。
       *
       * 所以：不传。让服务自己管。
       */
      onProgress: (p) => {
        // 窗口可能已经关了
        if (!event.sender.isDestroyed()) {
          event.sender.send('openleaner:mineru-progress', p);
        }
      },
    });

    return result;
  });
}

/** 供确认对话框用：把 temp 下的输出目录算出来，页面据此传 outDir */
function mineruOutRoot() {
  return path.join(app.getPath('userData'), 'mineru-jobs');
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
    registerChatProxy();
    registerMineru();
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

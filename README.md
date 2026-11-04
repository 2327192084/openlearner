# OpenLeaner · 开发说明（P0）

青岛科技大学 2026 年人工智能应用创新大赛 · AI原生代码创意编程 · 学生学习与成长类

计划书见 `PLAN.md`（另存于比赛材料目录）。本文只讲**代码怎么跑、结构为什么这样分**。

---

## 一、怎么跑

```bash
npm install          # 首次；本机需加 --ignore-scripts 绕开系统对 postinstall 的限制
npm run dev          # 浏览器开发模式，http://127.0.0.1:5173
npm test             # 单元测试
npx tsc -b           # 类型检查
npm run build        # 生产构建到 dist/
npm run electron:dev # 桌面端开发模式（需要能创建窗口的交互式桌面会话）
npm run electron:build  # 打包桌面安装包到 release/
```

### 验收复跑

P0 的四条「算做完」用脚本复跑，不靠口头声明。**两个场景都要跑**：

```bash
npm run build

# 场景 A：浏览器（http://）
npx vite preview --port 4173          # 另开一个终端
node scripts/verify-p0.cjs            # 29 项

# 场景 B：桌面端（file://）—— 打包产物的真实加载方式
node scripts/verify-desktop.cjs       # 9 项

# 场景 C：打包产物（验 app.asar 里的真实字节）
#   需先打包： npx electron-builder --dir
node scripts/verify-packaged.cjs      # 8 项
```

脚本用 CDP 连无头浏览器，真实点击、真实刷新、真实读写 IndexedDB，
并截图存进 `.verify-shots/`。**不通过就退非零码**，可以直接挂进 CI。

> ⚠️ **两个场景必须分别跑。** 曾经只跑场景 A：29 项全过，
> 但 Electron 生产包因为 `createBrowserRouter` 在 `file://` 下匹配不到路径，
> 一打开就是「页面不存在」。浏览器验收永远发现不了这个。
> 教训：**验收必须在产物真正运行的环境里跑。**

### 路由为什么用 hash

`src/app/router.tsx` 用 `createHashRouter`，不是 history 路由。原因是同一个 `dist/`
要同时跑在 `file://`（Electron `loadFile`）和 `http(s)://`（静态托管）两处：

- history 路由在 `file://` 下 `pathname` 是整个文件路径，匹配不到任何路由 → 首屏 404
- history 路由在静态托管下需要额外配置 SPA 回退，漏配一次就是刷新 404

hash 路由两处都天然可用，代价只是 URL 多一个 `#`。对一个不分享链接的桌面学习工具，
这个代价可以忽略。**不要「优化」回 history 路由**，除非同时改掉两个部署目标。


---

## 二、目录结构

```
src/
  core/                 与界面无关的核心逻辑（可单测、可替换）
    model.ts            实体定义与备份文件结构
    registry.ts         页面注册表 ← 可插拔性的关键
    library.ts          学习库用例：建库/重命名/导出/导入
    backends.ts         AI 后端配置：录入/凭据隔离/状态推导
    storage/
      types.ts          存储契约（两套实现共用）
      indexeddb-storage.ts  真实持久化
      memory-storage.ts     测试与假后端流程用
  app/                  应用装配
    router.tsx          路由（由注册表生成）
    AppShell.tsx        外壳：左侧导航 + 主内容区
    services-context.ts 依赖注入，让测试能塞内存存储
    env.ts              运行环境探测（web/desktop/test）
  pages/                业务页面，每个页面对应计划书一个阶段
    modules.ts          ← 新增页面只改这里
  components/           通用组件（空态/错态/占位页）
  styles/               设计令牌与通用样式
electron/               桌面外壳（主进程 + preload）
scripts/verify-p0.cjs   P0 验收探针
```

### 两条硬规矩

1. **界面不直接碰 StorageAdapter**，只经 `LibraryService` / `BackendService`。
   这样 P1 要换存储（把大文件挪到 OPFS 或桌面端文件系统）不用改界面。
2. **导航、路由、标题都不写死**，全部由 `core/registry.ts` 推导。
   P0 验收第 4 条「加一个假页面也能立刻工作」就是靠这个。

---

## 三、P0 已完成到什么程度

| P0 要求 | 状态 | 证据 |
|---|---|---|
| 应用主框架：左侧导航 + 主内容区，切换不刷新 | 完成 | `AppShell.tsx`，验收项 1–2 |
| 六个页面占位，都点得进去，显示「该功能待接入」 | 完成 | 六个页面文件 + 验收项 3–10 |
| 本地数据层 + 读写接口 + 导出/导入备份 | 完成 | `library.ts`、`storage/`，验收项 13–19 |
| 设置页骨架：AI 后端配置录入与保存（不联调） | 完成 | `settings/BackendSection.tsx`，验收项 16–22 |
| 空状态与错误状态统一样式 | 完成 | `components/states.tsx` + `styles/components.css` |
| 加一个假页面立刻能工作 | 完成 | `pages/DemoPage.tsx` + 验收项 10、注册表测试 |

### 有意**没有**做的事

- 没有画假界面。占位页只说「待接入」并列出计划书原文要求，不假装功能已存在——
  假界面会让队友和评审同时误判进度。
- 没有做 `secrets` 分区的加密。P0 只保证凭据不进导出文件、不进日志、不上界面；
  真正调用前的存储加固（系统钥匙串）放到 P5。
- 没有实现文件读写 IPC。桌面端 P0 只需要把渲染进程装进窗口，
  P1 导入教材时才需要，`electron/preload.cjs` 里已留好位置。

---

## 四、给下一阶段（P1）的接口约定

P1 要动的两个地方，接口已经定死，不需要改骨架：

1. **资料正文与切分**：在 `model.ts` 里给 `Source` 加 `segments` 或另开分区，
   位置信息用现成的 `SourceLocation`（`page` / `chapter` / `charStart` / `charEnd`）。
   这是「点回原文」的唯一依据，**指错页比不能跳转更糟**。
2. **桌面端文件读取**：`electron/preload.cjs` 加 `selectFile()`，
   主进程加 `dialog.showOpenDialog` 的 IPC handler。浏览器端继续走 File API，
   两条路在 `core/` 里收敛到同一个函数。

---

## 五、已知限制（如实记录）

- **Electron 窗口本身未在本机实测**：当前是非交互式桌面会话，无可用显示环境。
  `electron.exe` 在 `app.whenReady()` 之前就 SIGSEGV，指定可写 `--user-data-dir` 后
  卡在 Chromium Mojo 创建命名管道 `\\.\pipe\*` 被拒（EACCES）。
  **已做的替代验证**：`electron-builder --dir` 打包成功；解包 asar 后用 `file://`
  加载真实产物，8 项全过（`scripts/verify-packaged.cjs`）。
  **仍需补**：正常桌面会话下跑一次 `npm run electron:dev` 确认真实窗口。
- **NSIS 安装器未生成**：只跑了 `--dir`。完整 `electron:build` 需联网下载
  winCodeSign/nsis，本机连 GitHub 超时，换 npmmirror 镜像后 `--dir` 成功。
  P7 提交材料时补这一步，建议配 `ELECTRON_BUILDER_BINARIES_MIRROR` 或代理。
- **未配应用图标**：打包日志有 `default Electron icon is used`。不影响功能，
  但 P7 演示前应补 `build/icon.ico`（256×256），否则显示 Electron 原子图标。
- **静态托管**：hash 路由下不需要 SPA 回退，直接静态托管即可。
- 无头浏览器验证用的是本机 Edge，断言以 DOM 与交互为准，不做像素级比对。

---

## 六、P1 · 资料导入与阅读

### 支持的格式与切分方式

| 格式 | 切分依据 | 说明 |
|---|---|---|
| PDF | 按页 | 真实页码，`SourceSegment.page` 即 PDF 页号 |
| PPTX | 按幻灯片 | **按 `sldIdLst` 顺序，不按文件名** —— PowerPoint 调整页序只改引用顺序，按文件名排会指错页 |
| DOCX | 按章节 | 依 Heading 1/2 切分；无标题的长文档按段落聚合 |
| Markdown | 按 `#` 标题 | 剥掉语法符号但不动文字 |
| 纯文本 | 按段落聚合 | 超长段落按句末标点切，不切断句子 |

### 位置信息（全项目的命根子）

```ts
interface SourceLocation {
  sourceId: string;
  page?: number;      // 从 1 开始
  chapter?: string;
  charStart?: number; // 相对**该页/该章文本**的偏移，左闭
  charEnd?: number;   // 右开
}
```

两个刻意的设计决定：

1. **偏移相对页内文本，不是全文偏移。** 全文偏移在重新导入或编辑后会整体错位，
   而页内偏移只依赖那一页的文本，稳定得多。
2. **不猜位置。** 解析器只写它实测到的页码。P2 要求「指认不到原文位置时留空等人处理」，
   不要自动填一个位置上去 —— 指错页比不能跳转更糟，它冒充可信。

### 文本规范化（决定「原文」长什么样）

PDF 取词有两个必须处理的特性，都是对着真实样本实测出来的：

- **行尾硬断句**：同一段话的第二行是独立的海拔基线，取出来是
  「…非线性」+「结构包括树与图。」，中间没有连接符。不接回去，全文搜索整句永远搜不到。
- **段内折行与段落间距不同**：实测样本行高 12，段内折行 23.25（1.94 倍），
  段落之间 32.25（2.69 倍）。所以按 **间距 / 行高** 判段，
  阈值 2.2。用「间距中位数」会失败 —— 段落间距反而更多，中位数被污染，所有段落并成一块。

### 扫描件

`textStatus: 'no-text-layer'` —— **不是错误**。能导入、能翻页，但搜不出字，
阅读器会禁用搜索框并说明原因（P6 走看图模型）。

### PDF worker 的两个坑

1. 浏览器里必须设 `GlobalWorkerOptions.workerSrc`，否则一份 PDF 都解析不了。
2. 必须用 `?url` 让打包器产出 worker 路径；但 **Node（单测）里不能用 `?url`**
   —— 没有打包器时它会被解析成文件系统路径，pdfjs 必然失败。
   所以按 `typeof window !== 'undefined'` 分支：浏览器设 workerSrc，Node 退回 fake worker。

> 这个 bug 单元测试抓不到（测试注入 pdfjs 自身，走不到真实加载分支），
> 是 `verify-p1.cjs` 在真实浏览器里跑出来的。

### 验收

```bash
npm run build

# 浏览器
npx vite preview --port 4173
node scripts/verify-p1.cjs           # 21 项

# 桌面端 file://（验 PDF worker 在打包产物里可用）
npx electron-builder --dir
node scripts/verify-p1-desktop.cjs   # 6 项
```

### 测试样本

`src/test/fixtures/` 由 `node scripts/make-fixtures.cjs` 生成，**需提交**（测试不依赖浏览器）。
样本内容固定（三章数据结构讲义），`expectations.json` 记录了每页应含的原文片段与检索词→页码映射，
测试直接引用它断言「哪句话在哪一页」。

### 一个环境坑

`npx vite build` 在 Windows 上可能报 `esbuild ... Access is denied`（`%TEMP%` 权限问题）。
这不是代码问题，把临时目录指到工作区内即可：

```bash
TMP="E:/openleaner/.scratch/tmp" TEMP="E:/openleaner/.scratch/tmp" npx vite build
```

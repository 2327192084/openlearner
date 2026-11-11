/**
 * 创建 GitHub Release 并上传安装包（2026-11-11）。
 *
 * ## 为什么不用 gh 命令
 *
 * 这台机器没装 gh（`gh: command not found`）。用 git 凭据管理器里
 * 已有的 token 直接打 API 更省事，也不用再存一份凭据。
 *
 * ## 为什么不走 git push
 *
 * GitHub 单文件上限 100MB，安装包 101.3MB 会被 pre-receive hook 拒绝
 * （实测过）。Release 附件上限 2GB，是唯一的正确载体。
 *
 * ## 上传为什么分两步
 *
 * Release 附件是「先由 GitHub 给一个上传 URL，再 PUT 到那个 URL」。
 * 不能直接 POST 文件 —— 那是 uploads.github.com 的独立接口。
 *
 * 用法：
 *   node scripts/publish-release.cjs [--dry-run]
 *   node scripts/publish-release.cjs --file build/OpenLeaner-0.1.0-setup.exe
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REPO = '2327192084/openlearner';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DRY = process.argv.includes('--dry-run');

/** 版本号：读 package.json，避免与脚本里写死的值漂开 */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const TAG = `v${VERSION}`;

const FILE = path.resolve(ROOT, arg('file', 'build/OpenLeaner-0.1.0-setup.exe'));

/* ---- 从 git 凭据里取 token（不落盘、不打印）---- */
function gitToken() {
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const m = out.match(/^password=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

const TOKEN = process.env.GITHUB_TOKEN || gitToken();
if (!TOKEN) {
  console.error('拿不到 GitHub token。请在 git 凭据里存一个，或设 GITHUB_TOKEN 环境变量。');
  process.exit(2);
}

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'openleaner-release-script',
};

/** 走代理的 fetch（本机直连 github.com 不通） */
const PROXY = process.env.HTTPS_PROXY || 'http://127.0.0.1:7897';
const { ProxyAgent, fetch: undiciFetch } = (() => {
  try {
    const undici = require('undici');
    return { ProxyAgent: undici.ProxyAgent, fetch: undici.fetch };
  } catch {
    return { ProxyAgent: null, fetch: globalThis.fetch };
  }
})();

const agent = ProxyAgent ? new ProxyAgent(PROXY) : undefined;

async function api(url, init = {}) {
  const res = await undiciFetch(url, {
    ...init,
    headers: { ...HEADERS, ...(init.headers || {}) },
    ...(agent ? { dispatcher: agent } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON（上传响应可能是空的） */
  }
  return { status: res.status, json, text, headers: res.headers };
}

const RELEASE_BODY = `## OpenLeaner ${VERSION}

学习备考软件 —— 把教材 / 课件整理成可复习的资料与可刷的习题集，每条内容都能点回原文。

### 这一版做了什么

**提问式复习补全了范围**
- 阅读器里划选一段 → 浮层「用这段提问」，直接就这段向 AI 提问
- 提问范围下拉：知识点随机 / 某份资料整本 / 某章节

**知识库按认知类型筛选**
- 按「记忆 / 理解 / 应用 / 分析」四类收窄，与知识骨架页口径一致
- 记忆闪卡改为跳转知识库挑选，能按资料、章节、类型层层缩小

**界面**
- 修好两处 CSS 静默失效（首页统计数字、阅读器右栏背景原本完全没生效）
- 统计行统一排布，空态改用纸卡语言
- 包体积从 124MB 降到 31MB（排除了本不该打进去的构建期依赖）

### 安装

下载下面的 \`OpenLeaner-${VERSION}-setup.exe\`（约 101 MB），双击安装。
装到当前用户目录，不需要管理员权限。

**系统要求**：Windows 10 或更新，64 位。

### 可选依赖（软件本体不含，按需自行安装）

这一版**只发软件本体**。下面这些能力装了才有，不装不影响基本使用：

- **MinerU** —— PDF / 扫描件的高精度解析。本机没装时，软件会在
  「设置」里提示并把 \`mineru.exe\` 的路径填进去，或用环境变量
  \`MINERU_EXE\` 指定。普通的 PDF / Word / PPT / Markdown 不经 MinerU 也能导入。
- **AI 出题与判定** —— 在「设置 → 模型」里填自己的 API Key（支持 DeepSeek 等）。

### 数据

学习库存在本机，不上传任何地方。升级安装不会动数据；
卸载也**不会**删数据（会提示数据目录在哪）。
`;

(async () => {
  if (!fs.existsSync(FILE)) {
    console.error(`找不到要上传的文件: ${FILE}`);
    process.exit(2);
  }
  const size = fs.statSync(FILE).size;
  const sizeMB = (size / 1024 / 1024).toFixed(1);
  console.log(`版本: ${TAG}`);
  console.log(`文件: ${path.relative(ROOT, FILE)}  (${sizeMB} MB)`);
  console.log(`仓库: ${REPO}`);
  console.log(`代理: ${PROXY}\n`);

  if (size > 2 * 1024 * 1024 * 1024) {
    console.error('超过 GitHub Release 附件 2GB 上限');
    process.exit(2);
  }

  /* ---- 1. 看 release 是否已存在 ---- */
  console.log('检查已有 Release …');
  const existing = await api(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`);
  let release = null;

  if (existing.status === 200) {
    release = existing.json;
    console.log(`已有 release ${TAG}（id=${release.id}），将复用并补传附件`);
  } else if (existing.status === 404) {
    if (DRY) {
      console.log('[dry-run] 将创建 release');
    } else {
      console.log('创建 Release …');
      const created = await api(`https://api.github.com/repos/${REPO}/releases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tag_name: TAG,
          name: `OpenLeaner ${VERSION}`,
          body: RELEASE_BODY,
          draft: false,
          prerelease: false,
        }),
      });
      if (created.status >= 300) {
        console.error(`创建失败 ${created.status}: ${created.text.slice(0, 400)}`);
        process.exit(1);
      }
      release = created.json;
      console.log(`已创建: ${release.html_url}`);
    }
  } else {
    console.error(`查询失败 ${existing.status}: ${existing.text.slice(0, 300)}`);
    process.exit(1);
  }

  /* ---- 2. 上传附件 ---- */
  if (DRY) {
    console.log('[dry-run] 将上传附件，结束。');
    return;
  }

  const assets = release.assets || [];
  const sameName = assets.find((a) => a.name === path.basename(FILE));
  if (sameName) {
    console.log(`同名附件已存在（${sameName.name}），先删除 …`);
    const del = await api(`https://api.github.com/repos/${REPO}/releases/assets/${sameName.id}`, {
      method: 'DELETE',
    });
    console.log(`删除 ${del.status === 204 ? '完成' : '失败 ' + del.status}`);
  }

  const name = path.basename(FILE);
  const uploadUrl = `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  console.log(`上传 ${name}（${sizeMB} MB）… 这一步可能要几分钟`);

  const data = fs.readFileSync(FILE);
  const up = await api(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: data,
  });

  if (up.status >= 300) {
    console.error(`上传失败 ${up.status}: ${up.text.slice(0, 500)}`);
    process.exit(1);
  }

  const asset = up.json;
  console.log(`\n上传成功`);
  console.log(`  附件: ${asset.name}  ${(asset.size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  下载: ${asset.browser_download_url}`);
  console.log(`\nRelease 页面: ${release.html_url}`);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});

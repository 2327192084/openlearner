/**
 * 把 GitHub 仓库的「关于」描述里的旧品牌改成 Open Learner（2026-11-16）。
 *
 * 用户要求：「然后将项目更名，把所有 openleaner 更名为 Open Learner。
 * 无论是软件内相关的文本还是 GitHub 的描述，release 上传的文件不用动。」
 *
 * ## 为什么单独写一个小脚本，不直接改 scripts/update-repo-meta.cjs
 *
 * 那个脚本是「一整套仓库元信息」（描述 + 主页 + 14 个 topics），
 * 跑一次会把这些一起覆盖。这次只改**描述里的品牌名**，
 * topics 与主页一个字节都不该动 —— 用户没要求改它们。
 *
 * ## 只改显示名，不动仓库名
 *
 * 仓库 URL 是 `2327192084/openlearner`，改名会让所有旧链接失效，
 * 而且用户明说「release 上传的文件不用动」（那些 release 页面挂在仓库下）。
 * 所以这里只 PATCH `description`。
 *
 * 用法：
 *   node scripts/rename-repo-description.cjs --dry-run
 *   node scripts/rename-repo-description.cjs
 */

const { execFileSync } = require('node:child_process');

const REPO = '2327192084/openlearner';
const DRY = process.argv.includes('--dry-run');

const NEW_DESCRIPTION =
  'Open Learner —— 本地优先的备考工作台：教材/课件 → 可点回原文的知识点、' +
  '题目、错题本与复习计划。React 19 + Electron，数据只存本机。';

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
  console.error('拿不到 GitHub token。');
  process.exit(2);
}

/* 直连能通就不必走代理；要代理时设 HTTPS_PROXY */
const PROXY = process.env.HTTPS_PROXY || '';
let undiciFetch = globalThis.fetch;
let agent;
if (PROXY) {
  try {
    const undici = require('undici');
    undiciFetch = undici.fetch;
    agent = new undici.ProxyAgent(PROXY);
  } catch {
    /* 没有 undici 就走直连 */
  }
}

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'openlearner-rename-script',
};

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
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

(async () => {
  const before = await api(`https://api.github.com/repos/${REPO}`);
  if (before.status >= 300) {
    console.error(`读仓库信息失败 ${before.status}: ${before.text.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`仓库        : ${REPO}`);
  console.log(`现在的描述  : ${before.json.description}`);
  console.log(`想要改成    : ${NEW_DESCRIPTION}`);

  if (DRY) {
    console.log('\n[dry-run] 不改动。');
    return;
  }

  const patch = await api(`https://api.github.com/repos/${REPO}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: NEW_DESCRIPTION }),
  });
  if (patch.status >= 300) {
    console.error(`改描述失败 ${patch.status}: ${patch.text.slice(0, 400)}`);
    process.exit(1);
  }

  /*
   * 回读核实 —— 脚本自己打印的成功不算证据（硬约束）。
   * 重新 GET 一次，看服务器上真的是新值。
   */
  const after = await api(`https://api.github.com/repos/${REPO}`);
  const now = after.json && after.json.description;
  console.log(`\n改后回读    : ${now}`);
  const ok = typeof now === 'string' && now.indexOf('Open Learner') === 0;
  console.log(ok ? '\n✅ 描述已更新，回读一致' : '\n❌ 回读不一致，需要复查');
  if (!ok) process.exit(1);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
/**
 * 更新 GitHub 仓库的「关于」信息：描述、主页、topics。
 *
 * 这些字段在仓库首页右栏显示，和 README 一起构成「项目的介绍」。
 * 用 API 改而不是网页点，理由同 publish-release.cjs：没装 gh，走 token 更省事。
 *
 * 用法：
 *   node scripts/update-repo-meta.cjs --dry-run
 *   node scripts/update-repo-meta.cjs
 */
const { execFileSync } = require('node:child_process');

const REPO = '2327192084/openlearner';
const DRY = process.argv.includes('--dry-run');

const DESCRIPTION =
  '本地优先的备考工作台：教材/课件 → 可点回原文的知识点、题目、错题本与复习计划。' +
  'React 19 + Electron，数据只存本机。';

const HOMEPAGE = 'https://github.com/2327192084/openlearner/releases/latest';

/*
 * topics 的选择逻辑：GitHub 用它们做搜索与推荐分类。
 * 只放真能检索到项目的词，不堆砌 —— 放「ai」这种泛词没有意义。
 */
const TOPICS = [
  'study-tools',
  'flashcards',
  'spaced-repetition',
  'spaced-repetition-scheduler',
  'pdf-parsing',
  'ocr',
  'mineru',
  'electron',
  'react',
  'typescript',
  'indexeddb',
  'local-first',
  'education',
  'chinese',
  'knowledge-base',
  'pptx',
];

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

const PROXY = process.env.HTTPS_PROXY || 'http://127.0.0.1:7897';
let undiciFetch = globalThis.fetch;
let agent;
try {
  const undici = require('undici');
  undiciFetch = undici.fetch;
  agent = new undici.ProxyAgent(PROXY);
} catch {
  /* 没有 undici 就走直连 */
}

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'openleaner-meta-script',
};

async function api(url, init = {}) {
  const res = await undiciFetch(url, {
    ...init,
    headers: { ...HEADERS, ...(init.headers || {}) },
    ...(agent ? { dispatcher: agent } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

(async () => {
  console.log(`仓库: ${REPO}`);
  console.log(`描述: ${DESCRIPTION}`);
  console.log(`主页: ${HOMEPAGE}`);
  console.log(`topics(${TOPICS.length}): ${TOPICS.join(', ')}\n`);

  if (DRY) {
    console.log('[dry-run] 不改动。');
    return;
  }

  /* ---- 1. 描述 + 主页 ---- */
  const patch = await api(`https://api.github.com/repos/${REPO}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: DESCRIPTION, homepage: HOMEPAGE }),
  });
  if (patch.status >= 300) {
    console.error(`改描述失败 ${patch.status}: ${patch.text.slice(0, 400)}`);
    process.exit(1);
  }
  console.log('描述与主页: 已更新');
  console.log(`  描述 → ${patch.json.description}`);
  console.log(`  主页 → ${patch.json.homepage}`);

  /* ---- 2. topics（走独立的 PUT 接口）---- */
  const put = await api(`https://api.github.com/repos/${REPO}/topics`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names: TOPICS }),
  });
  if (put.status >= 300) {
    console.error(`改 topics 失败 ${put.status}: ${put.text.slice(0, 400)}`);
    process.exit(1);
  }
  console.log(`\ntopics: 已更新 → ${(put.json.names || []).join(', ')}`);
  console.log(`\n仓库页: https://github.com/${REPO}`);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});

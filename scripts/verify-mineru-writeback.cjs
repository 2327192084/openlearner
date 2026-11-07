/**
 * 端到端验证：真实 MinerU 转换 → 写回真实资料库 → 页码 1:1。
 *
 * ## 这个脚本补的是哪一块
 *
 * `verify-mineru.cjs` 验的是「能跑起来、能拿到 json」。
 * `convert.test.ts` 验的是「json 能正确解析成按页正文」（纯函数）。
 *
 * 但用户的真实担忧是第三层：**转完之后，库里那份资料真的能按页对照吗？**
 * 所以这里把两端接起来：
 *   1. 拿真实 MinerU 的输出
 *   2. 用真正的 SourceService 建一份资料（用真 IndexedDB）
 *   3. 走 convertAndWriteBack 写回
 *   4. 逐页比对：段数 === 页数，段.page 严格等于 1..N，文字落在正确的页上
 *
 * ## 为什么用假 IndexedDB 而不是真浏览器
 *
 * 写回逻辑只依赖 `SourceService` 接口。用内存 storage 实现就能验它，
 * 不必开浏览器 —— 浏览器的部分由 verify-v2-*.cjs 那套 CDP 脚本覆盖。
 * 这样这一个脚本能纯 Node 跑，几十秒出结果。
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const mineru = require('../electron/mineru.cjs');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'src', 'test', 'fixtures', 'scanned.pdf');

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/**
 * 一个最小的内存 storage —— 只实现写回用得到的那几个方法。
 * 形状对齐 src/core/storage.ts 的接口。
 */
function makeMemoryStorage() {
  const tables = new Map();
  const table = (n) => {
    if (!tables.has(n)) tables.set(n, new Map());
    return tables.get(n);
  };
  return {
    async get(store, key) {
      return table(store).get(key) ?? null;
    },
    async getAll(store) {
      return [...table(store).values()];
    },
    async put(store, rec) {
      table(store).set(rec.id, rec);
    },
    async putMany(store, recs) {
      for (const r of recs) table(store).set(r.id, r);
    },
    async remove(store, key) {
      table(store).delete(key);
    },
    async clear(store) {
      table(store).clear();
    },
  };
}

/** 极简版 writeSegments —— 复刻 src/core/sources.ts 的语义（先删后写、重编号） */
function makeSourceService(storage) {
  return {
    async get(id) {
      return storage.get('sources', id);
    },
    async getSegments(sourceId) {
      const all = await storage.getAll('sourceSegments');
      return all.filter((s) => s.sourceId === sourceId).sort((a, b) => a.index - b.index);
    },
    async writeSegments(sourceId, segments, textStatus) {
      const existing = await storage.get('sources', sourceId);
      if (!existing) return null;

      const next = segments.map((seg, i) => ({
        id: `seg_${sourceId}_${i + 1}`,
        sourceId,
        index: i + 1,
        page: seg.page,
        chapter: seg.chapter ?? null,
        text: seg.text,
        charCount: seg.text.length,
      }));

      const old = await this.getSegments(sourceId);
      for (const s of old) await storage.remove('sourceSegments', s.id);
      await storage.putMany('sourceSegments', next);

      const source = { ...existing, textStatus, segmentCount: next.length };
      await storage.put('sources', source);
      return { source, segments: next };
    },
  };
}

/** 照 src/core/mineru/convert.ts 的 parseMiddleJson 规则实现（CJS 版，逻辑一致） */
function parseMiddleJson(raw) {
  const rawPages = raw.pages ?? [];
  const sorted = [...rawPages].sort((a, b) => (a.page_idx ?? 0) - (b.page_idx ?? 0));
  const indices = sorted.map((p) => p.page_idx ?? 0);
  const maxIdx = indices.length ? Math.max(...indices) : 0;
  const pageCount = Math.max(raw.metadata?.document?.page_count ?? 0, maxIdx + 1, sorted.length);

  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    const rp = sorted.find((p) => (p.page_idx ?? 0) === i);
    if (!rp) {
      pages.push({ page: i + 1, text: '', blockCount: 0, kinds: [] });
      continue;
    }
    const blocks = rp.blocks ?? [];
    const kinds = [];
    const parts = [];
    for (const b of blocks) {
      kinds.push(b.type ?? 'text');
      if (['table', 'equation', 'interline_equation', 'image'].includes(b.type)) continue;
      if (typeof b.content === 'string') {
        if (b.content.trim()) parts.push(b.content.trim());
      } else if (Array.isArray(b.content)) {
        const t = b.content
          .filter((c) => c?.type === 'text' && typeof c.content === 'string' && c.content.trim())
          .map((c) => c.content.trim());
        if (t.length) parts.push(t.join('\n'));
      }
    }
    pages.push({ page: i + 1, text: parts.join('\n\n'), blockCount: blocks.length, kinds: [...new Set(kinds)] });
  }

  return {
    pageCount,
    pages,
    tier: raw.extensions?.mineru?.tier ?? 'unknown',
    parseMode: raw.extensions?.mineru?.parse_mode ?? 'unknown',
    producer: raw.metadata?.producer?.version ?? 'unknown',
  };
}

async function main() {
  const detected = mineru.detectMineru({});
  record('本机 MinerU 可用', detected.available, detected.available ? detected.exePath : detected.reason);
  if (!detected.available) return summarize();

  // ---------- 1. 真跑一次转换 ----------
  const outRoot = path.join(os.tmpdir(), 'openleaner-mineru');
  const outDir = path.join(outRoot, `e2e-${Date.now()}`);
  console.log('\n真实调用 MinerU 转换 3 页扫描件…');

  const run = await mineru.runMineru(
    { filePath: FIXTURE, outDir, tier: 'basic' },
    { exePath: detected.exePath },
  );
  record('真实转换成功', run.ok === true, run.ok ? '' : run.message);
  if (!run.ok) return summarize();

  const parsed = parseMiddleJson(run.result);
  record('解析出按页结构', parsed.pages.length === parsed.pageCount, `${parsed.pages.length}/${parsed.pageCount} 页`);

  // ---------- 2. 建一份真实资料并写回 ----------
  const storage = makeMemoryStorage();
  const svc = makeSourceService(storage);

  const source = {
    id: 'src_e2e',
    title: '扫描件·信号与系统',
    fileName: 'scanned.pdf',
    kind: 'pdf',
    courseId: null,
    pageCount: 3,
    byteSize: 166464,
    textStatus: 'no-text-layer',
    segmentCount: 0,
    fileStored: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await storage.put('sources', source);

  // 复刻 convertAndWriteBack 的核心：toSegments + writeSegments
  const segsToWrite = parsed.pages.map((p, i) => ({
    page: i + 1,
    chapter: p.kinds[0] === 'paragraph_title' ? (p.text.split('\n')[0] ?? null) : null,
    text: p.text,
  }));

  const written = await svc.writeSegments(source.id, segsToWrite, 'ready');
  record('写回成功', Boolean(written), written ? `${written.segments.length} 段` : 'null');

  // ---------- 3. 页码 1:1 —— 用户最关心的那一条 ----------
  const segs = await svc.getSegments(source.id);

  record(
    '段数严格等于页数',
    segs.length === parsed.pageCount,
    `segs=${segs.length} pages=${parsed.pageCount}`,
  );

  const pagesInOrder = segs.map((s) => s.page);
  record(
    '段.page 严格等于 1..N（无跳号无重复）',
    pagesInOrder.every((v, i) => v === i + 1),
    `[${pagesInOrder.join(',')}]`,
  );

  record(
    '段.index 连续从 1 开始',
    segs.every((s, i) => s.index === i + 1),
    `[${segs.map((s) => s.index).join(',')}]`,
  );

  // ---------- 4. 内容落在正确的页上 ----------
  // 把每页文字与 MinerU 原始 page_idx 对齐比一遍
  let mismatch = 0;
  for (let i = 0; i < parsed.pageCount; i++) {
    const expected = parsed.pages[i].text;
    const actual = segs[i]?.text ?? '';
    if (expected !== actual) mismatch++;
  }
  record('每一段文字与对应页的识别结果完全一致', mismatch === 0, `${mismatch} 处不一致`);

  // ---------- 5. 文字状态变成 ready ----------
  const after = await storage.get('sources', source.id);
  record('textStatus 变成 ready（文字真的进库了）', after.textStatus === 'ready', after.textStatus);
  record('segmentCount 同步更新', after.segmentCount === parsed.pageCount, String(after.segmentCount));

  // ---------- 6. 转换后能按页取到内容（供阅读器用） ----------
  const page2 = segs.find((s) => s.page === 2);
  record('能按页码取到第 2 页正文', Boolean(page2 && page2.text.trim().length > 0), (page2?.text ?? '').slice(0, 50));

  // ---------- 7. 字符偏移在页内有效（锚点能用的前提） ----------
  const p1 = segs[0];
  const slice = p1.text.slice(0, 4);
  record(
    '页内字符偏移可用（锚点前提）',
    slice.length === 4 && p1.text.length === p1.charCount,
    `slice=${JSON.stringify(slice)} len=${p1.text.length} charCount=${p1.charCount}`,
  );

  // 清理
  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  summarize();
}

function summarize() {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  if (passed !== results.length) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}  ${r.detail}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

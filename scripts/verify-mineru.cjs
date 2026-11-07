/**
 * 验证 electron/mineru.cjs —— 真实调用本机 MinerU 跑一次转换。
 *
 * ## 为什么要单独跑这个脚本
 *
 * 交接文档的硬规矩：能不开窗口验的东西，就不要开 Electron 去验。
 * `electron/mineru.cjs` 是纯 Node 模块（可注入 spawn），所以这里直接
 * require 它、喂真实 PDF、检查真实产出 —— 不需要启动桌面应用。
 *
 * ## 验什么
 *
 *  1. 探测：能不能找到本机 mineru-kit
 *  2. 校验：坏路径/坏扩展名/越界输出目录都要被拒绝（安全边界）
 *  3. 真跑：一份 3 页扫描件 → 拿到 middle_json → 解析成按页正文
 *  4. 页码 1:1：页数与原文件一致，页号连续
 *  5. 内容正确：识别出的中文能对上 fixture 里的实际文字
 *  6. 进度回调：真的推了进度事件（否则界面就是死等）
 *
 * 用法：node scripts/verify-mineru.cjs
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

async function main() {
  // ---------- 1. 探测 ----------
  const detected = mineru.detectMineru({});
  record(
    '能找到本机 mineru-kit',
    detected.available === true,
    detected.available ? detected.exePath : detected.reason,
  );
  if (!detected.available) {
    console.log('\n本机没装 MinerU，后面的真实转换用例跳过。');
    return summarize();
  }

  // ---------- 2. 安全边界：这些请求必须被拒绝 ----------
  const allowedRoot = path.join(os.tmpdir(), 'openleaner-mineru');

  const cases = [
    ['空路径被拒', {}, /路径/],
    ['相对路径被拒', { filePath: 'foo.pdf', outDir: allowedRoot }, /绝对路径/],
    ['不支持的扩展名被拒', { filePath: 'C:\\x\\y.exe', outDir: allowedRoot }, /不支持/],
    ['不存在的文件被拒', { filePath: 'C:\\nope\\a.pdf', outDir: allowedRoot }, /不存在/],
    ['越界的输出目录被拒', { filePath: FIXTURE, outDir: 'C:\\Windows\\Temp\\evil' }, /允许的范围/],
    ['不认识的 tier 被拒', { filePath: FIXTURE, outDir: allowedRoot, tier: 'ultra' }, /档位/],
  ];

  for (const [label, payload, expectRe] of cases) {
    const r = mineru.validateRequest(payload, { allowedRoots: [allowedRoot] });
    const msg = r.ok ? '竟然通过了' : r.message;
    record(label, r.ok === false && expectRe.test(msg), msg);
  }

  // 合法请求要能通过，且没给 outDir 时主进程会生成一个在根下的目录
  const okReq = mineru.validateRequest(
    { filePath: FIXTURE, tier: 'standard' },
    { allowedRoots: [allowedRoot] },
  );
  record(
    '合法请求通过，且自动生成受控输出目录',
    okReq.ok === true && okReq.value.outDir.startsWith(allowedRoot),
    okReq.ok ? okReq.value.outDir : okReq.message,
  );

  // ---------- 3. 进度行解析 ----------
  const p1 = mineru.parseProgressLine(
    'VLM Predict:  25%|██▌       | 3/12 [00:12<00:27,  3.07s/it]',
  );
  record('能解析 VLM 进度行', p1?.phase === '视觉模型识别' && p1?.ratio === 0.25, JSON.stringify(p1));

  const p2 = mineru.parseProgressLine(
    'MinerU2.5-Pro-2605-1.2B-Q8_0.gguf:  79%|███████▊  | 418M/531M [00:34<00:28, 4.02MB/s]',
  );
  record('能解析模型下载进度行', p2?.phase?.includes('下载模型'), JSON.stringify(p2));

  const p3 = mineru.parseProgressLine('随便一行没用的日志');
  record('无关日志不编造进度', p3 === null, JSON.stringify(p3));

  // ---------- 4. 真跑一次转换 ----------
  console.log('\n正在用本机 MinerU 真跑一次转换（首次可能较慢或需下载模型）…');
  const outDir = path.join(allowedRoot, `verify-${Date.now()}`);
  const progressEvents = [];

  const started = Date.now();
  const run = await mineru.runMineru(
    { filePath: FIXTURE, outDir, tier: 'standard' },
    {
      exePath: detected.exePath,
      // 有意不传 home：走本地服务时由服务自己管（传了会 token 不匹配）
      onProgress: (p) => progressEvents.push(p),
    },
  );
  const elapsed = Date.now() - started;

  record('真实转换成功退出', run.ok === true, run.ok ? `${Math.round(elapsed / 1000)}s` : run.message);
  if (!run.ok) return summarize();

  record('拿到了转换结果', Boolean(run.result && run.result.markdown), `长度=${run.result?.markdown?.length ?? 0}`);
  record('真的推了进度事件', progressEvents.length > 0, `${progressEvents.length} 条`);

  // ---------- 5. 校验分页标记与内容 ----------
  const markdown = run.result.markdown;

  // MinerU 的 Markdown 自带 <!-- page N of M --> 分页标记
  const markers = [...markdown.matchAll(/<!--\s*page\s+(\d+)\s+of\s+(\d+)\s*-->/gi)];
  record('有分页标记（按页写回的依据）', markers.length > 0, `${markers.length} 个标记`);

  const declared = markers.length ? Number(markers[0][2]) : 0;
  record('页数与原文件一致', declared === 3, `声明 ${declared} 页，实际标记 ${markers.length} 个`);

  const pageNos = markers.map((m) => Number(m[1]));
  record('页号连续从 1 开始', pageNos.every((v, i) => v === i + 1), JSON.stringify(pageNos));

  record('识别内容对得上原书（含「数据结构」）', markdown.includes('数据结构'), markdown.slice(0, 50).replace(/\n/g, ' '));
  record('识别内容不是乱码（中文字符占比高）', ratioCjk(markdown) > 0.5, `中文占比 ${(ratioCjk(markdown) * 100).toFixed(0)}%`);
  record('保留了标题层级（Markdown #）', /^#{1,6}\s+\S/m.test(markdown), '');

  // 清理这次产出
  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  summarize();
}

function ratioCjk(s) {
  if (!s) return 0;
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const visible = s.replace(/\s/g, '').length;
  return visible === 0 ? 0 : cjk / visible;
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

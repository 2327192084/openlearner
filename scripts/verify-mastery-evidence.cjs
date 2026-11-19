/**
 * 端到端验证「三层证据锚点」（2026-11-19）。
 *
 * ## 要证明的三件事
 *
 * 1. **发给模型的提示词变了**：不再要求 `verdict`，而是要求 13 项证据
 * 2. **证据 → 标签的映射在真实链路上生效**：
 *    - 概念全对、无错误 → `correct`
 *    - 有概念错误 → `understanding`
 *    - 只答概念（推理层全 false）→ 仍然 `correct`（不是"理解偏差"）
 * 3. **旧路径仍是兜底**：证据 JSON 坏掉时不报错，退回旧判定
 *
 * 第 2 条是这次换代的核心 —— 它决定判定稳不稳。
 *
 * ## 用假模型控制证据内容
 *
 * 假模型按请求里出现的「第几个场景」返回不同的证据 JSON，
 * 这样能精确验证映射规则，而不受真模型随机性影响。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
const APPDATA = path.resolve(ROOT, '.tmp/evidence-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/evidence');
const PORT = Number(process.argv[2] || 9837);
const MODEL_PORT = Number(process.argv[3] || 9914);
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x) => {
  console.log((ok ? '✅ ' : '❌ ') + n + (x ? ' :: ' + x : ''));
  ok ? pass++ : fail++;
};

/* 场景 → 假模型返回的证据 */
const SCENARIOS = {
  /** 概念全对、无错误 */
  goodConcept: {
    conceptEvidence: {
      redefinesInOwnWords: true,
      distinguishesSimilarConcepts: true,
      givesCounterExamples: true,
      vagueTerms: [],
      conceptErrors: [],
    },
    judgmentEvidence: {
      considersConditions: false,
      distinguishesFactOpinion: false,
      usesQualifiers: false,
      absolutistCount: 0,
      judgmentErrors: [],
    },
    reasoningEvidence: {
      providesPremises: false,
      completeChain: false,
      identifiesAssumptions: false,
      distinguishesDeductiveInductive: false,
      considersCounterfactuals: false,
      fallacyTypes: [],
    },
  },
  /** 有概念错误 */
  conceptError: {
    conceptEvidence: {
      redefinesInOwnWords: true,
      distinguishesSimilarConcepts: false,
      givesCounterExamples: false,
      vagueTerms: [],
      conceptErrors: ['把「有限」说成了「无限」'],
    },
    judgmentEvidence: {
      considersConditions: false,
      distinguishesFactOpinion: false,
      usesQualifiers: false,
      absolutistCount: 0,
      judgmentErrors: [],
    },
    reasoningEvidence: {
      providesPremises: false,
      completeChain: false,
      identifiesAssumptions: false,
      distinguishesDeductiveInductive: false,
      considersCounterfactuals: false,
      fallacyTypes: [],
    },
  },
  /** 三层都答到且都对 */
  allLayers: {
    conceptEvidence: {
      redefinesInOwnWords: true,
      distinguishesSimilarConcepts: true,
      givesCounterExamples: true,
      vagueTerms: [],
      conceptErrors: [],
    },
    judgmentEvidence: {
      considersConditions: true,
      distinguishesFactOpinion: true,
      usesQualifiers: true,
      absolutistCount: 0,
      judgmentErrors: [],
    },
    reasoningEvidence: {
      providesPremises: true,
      completeChain: true,
      identifiesAssumptions: true,
      distinguishesDeductiveInductive: true,
      considersCounterfactuals: true,
      fallacyTypes: [],
    },
  },
};

/* 当前场景：假的模型按这个 key 返回。测试时改写 */
let currentScenario = 'goodConcept';
/* 让证据 JSON 坏掉，验证兜底 */
let breakEvidence = false;

function startFakeModel() {
  const http = require('node:http');
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      requests.push({ url: req.url, body: parsed });

      if (req.url && req.url.split('?')[0].endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
        return;
      }

      const msgs = parsed && Array.isArray(parsed.messages) ? parsed.messages : [];
      const system = msgs.find((m) => m.role === 'system')?.content ?? '';
      const user = msgs.find((m) => m.role === 'user')?.content ?? '';

      let content;
      if (system.includes('你只输出客观证据') || system.includes('学习评估助手')) {
        /* 证据判定请求 */
        content = breakEvidence
          ? '{"conceptEvidence": '   /* 故意坏的 JSON */
          : JSON.stringify(SCENARIOS[currentScenario] ?? SCENARIOS.goodConcept);
      } else if (system.includes('就一段学习材料向学生提问')) {
        /* 旧判定请求（兜底路径） */
        content = JSON.stringify({
          verdict: 'understanding',
          quotedFromSource: '旧链路的引文',
          explanation: '这是旧判定的说明',
          correction: '这是旧判定的纠正',
        });
      } else {
        /* 出题请求 */
        const ids = [...user.matchAll(/^- id:\s*(\S+)/gm)].map((m) => m[1]);
        content = JSON.stringify({
          questions: ids.slice(0, 1).map((id) => ({
            knowledgePointId: id,
            kind: 'single',
            prompt: '线性表的定义是什么？',
            options: [
              { key: 'A', text: '有限序列', why: '符合定义' },
              { key: 'B', text: '无限序列', why: '常见误解' },
            ],
            answer: 'A',
            explanation: '线性表是有限序列。',
          })),
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-fake', object: 'chat.completion', model: 'fake-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      }));
    });
  });
  return { server, requests };
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(APPDATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  const fake = startFakeModel();
  await new Promise((r) => fake.server.listen(MODEL_PORT, '127.0.0.1', r));
  console.log('  假模型 127.0.0.1:' + MODEL_PORT);

  const app = spawn(EXE, [
    ROOT, '--user-data-dir=' + DATA, '--no-sandbox',
    '--remote-debugging-port=' + PORT, '--window-size=1440,1100',
  ], { cwd: ROOT, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  app.stdout.on('data', (d) => (log += d.toString()));
  app.stderr.on('data', (d) => (log += d.toString()));

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 240; i++) {
      try {
        const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        target = l.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
        if (target) break;
      } catch {}
      await SLEEP(250);
    }
    if (!target) { console.error('起不来:' + log.slice(-1500)); process.exit(2); }

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    let id = 1;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
    const send = (method, params) => new Promise((resolve, reject) => {
      const n = id++;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params: params || {} }));
      setTimeout(() => {
        if (pending.has(n)) { pending.delete(n); reject(new Error('timeout ' + method)); }
      }, 120000);
    });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await SLEEP(5000);

    /* 种子 */
    const seedSql = [
      '(async () => {',
      '  const db = await new Promise((res, rej) => { const q = indexedDB.open("openleaner"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });',
      '  const ts = new Date().toISOString();',
      '  const put = (st, rows) => new Promise((res, rej) => { const tx = db.transaction(st, "readwrite"); const s = tx.objectStore(st); rows.forEach((r) => s.put(r)); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });',
      '  const clear = (st) => new Promise((res) => { const tx = db.transaction(st, "readwrite"); tx.objectStore(st).clear(); tx.oncomplete = res; tx.onerror = res; });',
      '  for (const st of ["questions","decks","reviewRecords","reviewLogs","knowledgePoints","sources","sourceSegments","backends","secrets","answerRecords","oralReviews"]) await clear(st);',
      '  await put("sources", [{ id:"src_e", title:"测试资料", kind:"text", pageCount:3, textStatus:"ready", createdAt:ts, updatedAt:ts, segmentCount:3, readProgress:null }]);',
      '  await put("sourceSegments", [1,2,3].map((p) => ({ id:"seg_e"+p, sourceId:"src_e", index:p, page:p, chapter:"第一章", text:"线性表是由 n 个数据元素构成的有限序列，n 称为表长。这一段足够长用来提问。", charCount:40 })));',
      '  await put("knowledgePoints", [{ id:"kp_e", statement:"线性表是有限序列", chapter:"第一章", cognitiveLevel:"understand", tags:[], anchors:[{sourceId:"src_e",page:1,charStart:0,charEnd:10,segmentId:"seg_e1"}], quotes:["线性表是有限序列。"], anchorStatus:"located", origin:"material", sourceId:"src_e", backendId:"b", createdAt:ts, updatedAt:ts }]);',
      '  await put("backends", [{ id:"be_e", label:"本地假模型", kind:"direct-api", provider:"custom", baseUrl:"http://127.0.0.1:' + MODEL_PORT + '", model:"fake-model", capabilities:{textOrganize:true,visionFormula:false}, status:"ready", isDefault:true, createdAt:ts, updatedAt:ts }]);',
      '  await put("secrets", [{ id:"sec_e", backendId:"be_e", value:"sk-fake", createdAt:ts, updatedAt:ts }]);',
      '  db.close();',
      '  return { ok: true };',
      '})()',
    ].join('\n');
    const seeded = await evalJs(seedSql);
    rec('种子数据写入', !!(seeded && seeded.ok));

    await evalJs('location.reload()');
    await SLEEP(6000);

    /*
     * ## 为什么直接驱动逻辑而不是点 UI
     *
     * 提问式复习的 UI 路径是：复习巩固页 → 素材池就绪 → 出题 → 输入回答 → 判定，
     * 中间依赖「知识点是否已定位」「素材池是否非空」等状态。
     * 一步步点下去既脆又慢，而且**真正要验的是「证据 → 标签」的映射**，
     * 不是那几个按钮能不能点（那部分已有 verify-answer-record 覆盖）。
     *
     * 所以这里在页面上下文里直接调与 `handleOralJudge` **同一份实现**：
     * chatCompletion + mastery-evidence 的四个函数。
     * 提示词、解析、打分、映射全走真实代码，只跳过 UI 点击。
     */
    const judgeOnce = async (scenarioKey) => {
      currentScenario = scenarioKey;
      return evalJs(`(async () => {
        const { chatCompletion } = await import('/src/core/ai/deepseek-client.ts');
        const { buildEvidenceSystemPrompt, buildEvidenceUserPrompt, parseEvidence, scoreEvidence, buildCorrection } =
          await import('/src/core/ai/mastery-evidence.ts');
        const res = await chatCompletion({
          apiKey: 'sk-fake',
          baseUrl: 'http://127.0.0.1:MODELPORT',
          model: 'fake-model',
          provider: 'custom',
          systemPrompt: buildEvidenceSystemPrompt(),
          userPrompt: buildEvidenceUserPrompt({
            statement: '线性表是有限序列',
            question: '线性表的定义是什么？',
            answer: '就是很多元素排成一列',
            material: '线性表是由 n 个数据元素构成的有限序列。',
          }),
          temperature: 0.1,
          maxTokens: 1600,
        });
        const ev = parseEvidence(res.content);
        const score = scoreEvidence(ev);
        return {
          verdict: score.verdict,
          overall: score.overall,
          reachedDepth: score.reachedDepth,
          summary: score.summary,
          correction: buildCorrection(ev),
        };
      })()`.replace('MODELPORT', String(MODEL_PORT)));
    };

    /* ---------- ② 概念全对 → correct，且深度=1 ---------- */
    const good = await judgeOnce('goodConcept');
    console.log('  概念全对 =', JSON.stringify(good));
    rec('**概念全对 → correct**', good.verdict === 'correct', good.verdict);
    rec('**只答概念时 reachedDepth=1**（推理层没问到，不是答错）', good.reachedDepth === 1, String(good.reachedDepth));
    rec('总结里提示「再往下问一层」', String(good.summary).includes('再往下问'), good.summary);

    /* ---------- ③ 有概念错误 → understanding ---------- */
    const bad = await judgeOnce('conceptError');
    console.log('  概念有错 =', JSON.stringify(bad));
    rec('**概念有实质错误 → understanding**', bad.verdict === 'understanding', bad.verdict);
    rec('分数低于概念全对那次', bad.overall < good.overall, good.overall + ' vs ' + bad.overall);
    rec('纠正里点名那个错误', String(bad.correction).includes('有限'), String(bad.correction));

    /* ---------- ④ 三层全对 → correct 且深度=3 ---------- */
    const full = await judgeOnce('allLayers');
    console.log('  三层全对 =', JSON.stringify(full));
    rec('**三层全对 → correct**', full.verdict === 'correct', full.verdict);
    rec('**reachedDepth=3**', full.reachedDepth === 3, String(full.reachedDepth));
    rec('满分时 overall=1', full.overall === 1, String(full.overall));

    /* ---------- ⑤ 证据 JSON 坏掉 → 兜底旧判定 ---------- */
    /*
     * 这一段复刻 App 里 handleOralJudge 的 try/catch 结构：
     * 先试证据链路，解析失败就退回旧判定。
     * 验的是「兜底真的会发生」，不是「try/catch 写对了」。
     */
    const before = fake.requests.length;
    breakEvidence = true;
    const fallback = await evalJs(`(async () => {
      const { chatCompletion } = await import('/src/core/ai/deepseek-client.ts');
      const { buildEvidenceSystemPrompt, buildEvidenceUserPrompt, parseEvidence } =
        await import('/src/core/ai/mastery-evidence.ts');
      const { buildOralSystemPrompt, buildJudgePrompt, parseJudgement } =
        await import('/src/core/oral-review.ts');
      const b = { apiKey: 'sk-fake', baseUrl: 'http://127.0.0.1:MODELPORT', model: 'fake-model', provider: 'custom' };
      const m = { id: 'm1', label: '线性表', text: '线性表是有限序列。', sourceId: 's', page: 1, chapter: null, pointId: null };
      try {
        const res = await chatCompletion({ ...b, systemPrompt: buildEvidenceSystemPrompt(),
          userPrompt: buildEvidenceUserPrompt({ statement: '线性表', question: '定义？', answer: '不确定', material: m.text }),
          temperature: 0.1, maxTokens: 1600 });
        parseEvidence(res.content);
        return { path: 'evidence-ok' };
      } catch {
        const res = await chatCompletion({ ...b, systemPrompt: buildOralSystemPrompt(),
          userPrompt: buildJudgePrompt(m, '定义？', '不确定'), temperature: 0.1, maxTokens: 1200 });
        const j = parseJudgement(res.content, m);
        return { path: 'legacy', verdict: j.verdict };
      }
    })()`.replace('MODELPORT', String(MODEL_PORT)));
    breakEvidence = false;
    console.log('  坏 JSON 时 =', JSON.stringify(fallback));
    rec('**证据 JSON 坏掉 → 退回旧判定，不报错**',
      fallback.path === 'legacy' && !!fallback.verdict, JSON.stringify(fallback));
    rec('兜底时确实多发了请求（先试证据、再退旧）',
      fake.requests.length - before >= 2, 'delta=' + (fake.requests.length - before));

    /* ---------- ⑥ 提示词内容核对（读真实请求体） ---------- */
    const evReq = fake.requests.filter((r) => {
      const sys = (r.body?.messages ?? []).find((m) => m.role === 'system')?.content ?? '';
      return sys.includes('学习评估助手');
    });
    const evSys = (evReq[0]?.body?.messages ?? []).find((m) => m.role === 'system')?.content ?? '';
    rec('**请求体里明确禁止模型下结论**', evSys.includes('不要给出分数'), '');
    rec('**请求体要求各层独立、不许凭空补证据**', evSys.includes('各层独立'), '');
    rec('请求体不含 \"verdict\" 字段（新一代不再让模型给标签）', !evSys.includes('"verdict"'), '');
    rec('请求体含三层字段名', evSys.includes('conceptEvidence') && evSys.includes('judgmentEvidence') && evSys.includes('reasoningEvidence'), '');


    console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
    if (fail > 0) process.exitCode = 1;
  } catch (e) {
    console.error('脚本异常：', e && e.message);
    console.error(log.slice(-2000));
    process.exitCode = 2;
  } finally {
    try { ws && ws.close(); } catch {}
    app.kill();
    await new Promise((r) => fake.server.close(r));
    await SLEEP(1200);
  }
})();
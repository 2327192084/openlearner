/**
 * 验证「后端 API 全链路」：设置页配置 → 出题页真发 HTTP → 题目落库且能点回原文。
 *
 * 为什么必须写这个脚本：
 *   设置页的「测试连接」只证明能发一次请求。用户真正要的是「配好之后能出题」。
 *   中间还有一大段：出题页读后端 → 读凭据 → 组装提示词 → 发请求 → 解析模型 JSON
 *   → 校验每道题 → 继承知识点的 anchors → 逐题落库 → 刷新题数。任何一环断了，
 *   用户看到的都是「出不了题」，而单测和设置页验收都发现不了。
 *
 * 判定标准（交接文档要求）：
 *   - 改界面 → CDP 截图
 *   - 改数据流 → 查 IndexedDB
 *   所以这里既截图，也直接翻库。
 *
 * 网络怎么处理：
 *   用 CDP Fetch 域把发往模型的请求截住，返回结构正确的假响应。
 *   不花钱、不需要真 Key，但**请求是真的被浏览器发出去的**（预检、请求头、
 *   请求体都真实生成），所以能验证地址拼接、鉴权头、JSON 模式、响应解析。
 *
 * 知识点从哪来：
 *   v2 目前**没有「整理知识点」的界面**（这是一个已记录的缺口）。
 *   所以这里直接往 IndexedDB 写一份资料 + 段落 + 知识点，
 *   代替那个还没做的页面。这不是绕过验证 —— 恰恰是要证明：
 *   一旦知识点存在，出题链路是通的；而「怎么产出知识点」是下一步要补的。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const PORT = 9247;

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method) for (const fn of this.listeners) fn(msg);
    });
  }
  on(fn) {
    this.listeners.push(fn);
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 60000);
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    }
    return res.result.value;
  }
  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) break;
    } catch {
      /* wait */
    }
    await sleep(250);
  }
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, {
    method: 'PUT',
  }).then((r) => r.json());
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new Cdp(ws);
}

/* ------------------------------------------------------------------ */
/* 假模型服务：解析请求体里的知识点 id，按 id 回题                      */
/* ------------------------------------------------------------------ */

/**
 * 从出题提示词里挖出知识点 id。
 *
 * 提示词格式是 `- id: kp_xxx`（见 buildQuestionUserPrompt）。
 * 用纯字符串扫描而不是正则，是为了避开模板字符串里反斜杠被吃掉一层的老坑。
 */
function extractIds(postData) {
  const ids = [];
  if (!postData) return ids;
  const lines = postData.split('\n');
  for (const line of lines) {
    const idx = line.indexOf('- id: ');
    if (idx === -1) continue;
    const id = line.slice(idx + 6).trim();
    if (id) ids.push(id);
  }
  return ids;
}

function makeQuestionBody(ids) {
  const questions = ids.slice(0, 2).map((id, i) => ({
    knowledgePointId: id,
    kind: 'single',
    prompt: `【假响应】第 ${i + 1} 题：关于该概念的下列说法，正确的是？`,
    options: [
      { key: 'A', text: '选项甲' },
      { key: 'B', text: '选项乙（正确）' },
      { key: 'C', text: '选项丙' },
      { key: 'D', text: '选项丁' },
    ],
    answer: 'B',
    explanation: '这是假响应里的解析文字，用来验证解析字段能落库。',
  }));
  return {
    model: 'deepseek-chat',
    choices: [{ message: { content: JSON.stringify({ questions }) } }],
    usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
  };
}

/** 第二阶段的失败响应：余额不足 */
const BALANCE_BODY = { error: { message: 'Insufficient Balance' } };

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = path.join(OUT_DIR, 'edge-profile-api');
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=1440,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp;
  try {
    cdp = await connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*chat/completions*', requestStage: 'Request' }],
    });

    /** 拦截到的真实请求 */
    const calls = [];
    const consoleErrors = [];
    /** 阶段：'ok' 正常出题；'balance' 返回余额不足 */
    let phase = 'ok';

    cdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(
          msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text,
        );
      }
      if (msg.method !== 'Fetch.requestPaused') return;

      const req = msg.params.request;
      const method = (req.method || '').toUpperCase();
      const origin = req.headers.Origin || req.headers.origin || '*';
      const corsHeaders = [
        { name: 'Access-Control-Allow-Origin', value: origin === '*' ? '*' : origin },
        { name: 'Access-Control-Allow-Methods', value: 'POST, OPTIONS' },
        { name: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
        { name: 'Access-Control-Max-Age', value: '600' },
      ];

      // 预检必须自己回，否则浏览器判定 CORS 失败（这是探针的坑，不是产品的）
      if (method === 'OPTIONS') {
        void cdp
          .send('Fetch.fulfillRequest', {
            requestId: msg.params.requestId,
            responseCode: 204,
            responseHeaders: corsHeaders,
            body: '',
          })
          .catch(() => {});
        return;
      }

      let body = {};
      try {
        body = JSON.parse(req.postData || '{}');
      } catch {
        /* 不是 JSON 就不管 */
      }
      calls.push({
        url: req.url,
        host: (() => {
          try {
            return new URL(req.url).host;
          } catch {
            return req.url;
          }
        })(),
        auth: Boolean(req.headers.Authorization || req.headers.authorization),
        model: body.model,
        jsonMode: Boolean(body.response_format),
        ids: extractIds(body.messages?.[1]?.content ?? ''),
      });

      const payload = phase === 'ok' ? makeQuestionBody(calls[calls.length - 1].ids) : BALANCE_BODY;
      const code = phase === 'ok' ? 200 : 402;

      void cdp
        .send('Fetch.fulfillRequest', {
          requestId: msg.params.requestId,
          responseCode: code,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, ...corsHeaders],
          body: Buffer.from(JSON.stringify(payload)).toString('base64'),
        })
        .catch(() => {});
    });

    // ---------- 1. 打开应用 ----------
    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(3500);
    const boot = await cdp.eval(`Boolean(document.querySelector('.app'))`);
    record('应用启动', boot);

    // ---------- 2. 建库 + 配后端（走真实界面） ----------
    const setup = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const fill = (el, v) => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
      const clickText = (txt) => {
        const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().includes(txt));
        if (b) { b.click(); return true; }
        return false;
      };

      // 进设置
      const navToSettings = [...document.querySelectorAll('.sidebar .nav-item')]
        .find(b => b.textContent.trim() === '设置');
      if (!navToSettings) return { error: '找不到设置入口' };
      navToSettings.click();
      await wait(900);

      // 建库
      const nameInput = document.querySelector('.settings-panel input.set-input');
      if (nameInput) {
        fill(nameInput, '链路验证库');
        clickText('创建学习库');
        await wait(1400);
      }

      // 切到模型分类
      const modelTab = [...document.querySelectorAll('.settings-nav__item')]
        .find(b => b.textContent.includes('模型与出题'));
      if (!modelTab) return { error: '找不到模型分类' };
      modelTab.click();
      await wait(600);

      // 按钮文案是「添加模型」（不是「添加后端」—— 别按猜的写）
      if (!clickText('添加模型')) {
        return {
          error: '找不到「添加模型」按钮',
          buttons: [...document.querySelectorAll('.settings-panel button')].map((b) => b.textContent.trim()),
        };
      }
      await wait(600);
      const form = document.querySelector('.set-form');
      if (!form) return { error: '表单没出来' };

      // 只填名字与 Key，其余用预设默认值（deepseek）
      const labelInput = form.querySelectorAll('input.set-input')[0];
      fill(labelInput, '链路验证后端');

      // API Key
      const keyInput = [...form.querySelectorAll('input')].find(i => i.type === 'password');
      fill(keyInput, 'sk-chain-abcdef1234567890');

      form.querySelector('button[type=submit]').click();
      await wait(1500);

      return {
        hasCard: Boolean(document.querySelector('.set-item')),
        cardText: document.querySelector('.set-item')?.textContent ?? '',
      };
    })()`);

    record('设置页建库 + 配后端成功', !setup.error && setup.hasCard, setup.error ?? '');

    // ---------- 3. 往库里种一份资料 + 段落 + 知识点 ----------
    // 代替「还没做的整理知识点页面」。写的是库本身，服务重启后就会读到。
    const seeded = await cdp.eval(`(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('openleaner');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const put = (store, rows) => new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        for (const r of rows) tx.objectStore(store).put(r);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });

      const now = new Date().toISOString();
      const text = '线性表是由 n 个数据元素构成的有限序列，其中每个元素都有唯一的前驱和后继。';
      await put('sources', [{
        id: 'src_chain', title: '链路验证资料', fileName: '链路.pdf', kind: 'pdf',
        courseId: null, pageCount: 1, byteSize: 1024, textStatus: 'ready',
        segmentCount: 1, fileStored: false, createdAt: now, updatedAt: now,
      }]);
      await put('sourceSegments', [{
        id: 'seg_chain', sourceId: 'src_chain', index: 1, page: 1,
        chapter: null, text, charCount: text.length,
      }]);
      await put('knowledgePoints', [{
        id: 'kp_chain_1',
        statement: '线性表是由 n 个数据元素构成的有限序列',
        chapter: null,
        cognitiveLevel: 'remember',
        tags: ['线性表'],
        anchors: [{ sourceId: 'src_chain', page: 1, charStart: 0, charEnd: 24 }],
        quotes: [text.slice(0, 24)],
        anchorStatus: 'located',
        origin: 'material',
        sourceId: 'src_chain',
        backendId: 'manual',
        createdAt: now,
        updatedAt: now,
      }, {
        id: 'kp_chain_2',
        statement: '每个元素都有唯一的前驱和后继',
        chapter: null,
        cognitiveLevel: 'understand',
        tags: ['线性表'],
        anchors: [{ sourceId: 'src_chain', page: 1, charStart: 25, charEnd: 45 }],
        quotes: [text.slice(25, 45)],
        anchorStatus: 'located',
        origin: 'material',
        sourceId: 'src_chain',
        backendId: 'manual',
        createdAt: now,
        updatedAt: now,
      }]);
      db.close();
      return true;
    })()`);
    record('种入资料与知识点', seeded === true);

    // 服务在启动时读库，所以必须刷新才能读到刚种的数据
    await cdp.send('Page.reload');
    await sleep(3500);

    // ---------- 4. 进出题页，真发一次请求 ----------
    const genResult = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const nav = [...document.querySelectorAll('.sidebar .nav-item')]
        .find(b => b.textContent.trim() === '创建题组');
      if (!nav) return { error: '找不到创建题组' };
      nav.click();
      await wait(1600);

      const hint = document.querySelector('.gen-hint')?.textContent ?? '';
      const select = document.querySelector('.gen-select');
      const options = select ? [...select.options].map(o => o.textContent) : [];

      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('生成并检查题组'));
      if (!btn) return { error: '找不到生成按钮', hint };
      const disabled = btn.disabled;
      btn.click();
      await wait(4000);

      return {
        hint,
        options,
        disabled,
        done: document.querySelector('.gen-done')?.textContent ?? '',
        error: document.querySelector('.gen-error')?.textContent ?? '',
      };
    })()`);

    record('出题页读到知识点', !genResult.error && /条已定位的知识点/.test(genResult.hint), genResult.hint ?? genResult.error ?? '');
    record('点下去真的发了一次请求', calls.length >= 1, `calls=${calls.length}`);

    const call = calls[0];
    record('请求打到配置的地址', Boolean(call) && call.host === 'api.deepseek.com', call?.host ?? '');
    record('带了 Authorization 头', Boolean(call?.auth));
    record('请求体里是配置的模型名', call?.model === 'deepseek-chat', call?.model ?? '');
    record('启用了 JSON 模式', Boolean(call?.jsonMode));
    record('提示词里带上了知识点 id', (call?.ids ?? []).length === 2, `ids=${(call?.ids ?? []).join(',')}`);

    record('界面显示生成成功', /已生成/.test(genResult.done ?? ''), (genResult.done ?? genResult.error ?? '').slice(0, 80));

    await cdp.screenshot(path.join(OUT_DIR, 'api-01-generated.png'));

    // ---------- 5. 查库：题目真的写进去了吗 ----------
    const dbAfter = await cdp.eval(`(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('openleaner');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const all = (store) => new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const out = {
        questions: await all('questions'),
        decks: await all('decks'),
        knowledge: await all('knowledgePoints'),
        usage: await all('usageRecords'),
      };
      db.close();
      return out;
    })()`);

    record('题目落库', dbAfter.questions.length === 2, `questions=${dbAfter.questions.length}`);
    record('题组落库且题数一致', dbAfter.decks.length === 1 && dbAfter.decks[0].questionCount === 2, `count=${dbAfter.decks[0]?.questionCount}`);

    const q0 = dbAfter.questions[0] ?? {};
    record('题目继承了知识点的出处', Array.isArray(q0.anchors) && q0.anchors.length === 1 && q0.anchors[0].page === 1, JSON.stringify(q0.anchors));
    record('题目记住了依据的知识点 id', typeof q0.knowledgePointId === 'string' && q0.knowledgePointId.startsWith('kp_chain'), q0.knowledgePointId);
    record('题干/选项/答案/解析都完整', Boolean(q0.prompt) && (q0.options ?? []).length === 4 && q0.answer === 'B' && Boolean(q0.explanation));
    record('用量记账落库', dbAfter.usage.length >= 1 && dbAfter.usage[0].tokens === 1500, `usage=${JSON.stringify(dbAfter.usage[0]?.tokens)}`);

    // ---------- 6. 复核：回复里没泄漏 Key，控制台没报错 ----------
    const leaked = await cdp.eval(`document.body.innerText.includes('sk-chain-abcdef1234567890')`);
    record('API Key 没有出现在界面上', leaked === false);
    const keyLeakedInConsole = consoleErrors.some((e) => e.includes('sk-chain-abcdef1234567890'));
    record('API Key 没有出现在控制台错误里', !keyLeakedInConsole);
    record('控制台没有未捕获异常', consoleErrors.filter((e) => !/Failed to load resource|favicon/i.test(e)).length === 0, consoleErrors.slice(0, 2).join(' | '));

    // ---------- 7. 失败路径：余额不足要说人话 ----------
    phase = 'balance';
    const failResult = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('生成并检查题组'));
      if (!btn) return { error: '找不到按钮' };
      btn.click();
      await wait(3500);
      return {
        error: document.querySelector('.gen-error')?.textContent ?? '',
        hint: document.querySelector('.gen-error__hint')?.textContent ?? '',
        stillBusy: /正在生成/.test(document.body.innerText),
      };
    })()`);

    record('失败时按钮恢复可点', failResult.stillBusy === false);
    record(
      '余额不足时给出可行动的原因',
      /余额不足/.test(failResult.error ?? ''),
      (failResult.error ?? '').slice(0, 90),
    );
    // 只说「余额不足」等于把用户丢在原地。ApiError 里本来就带了下一步建议，
    // 界面必须把它显示出来，否则用户不知道去充值还是换 Key。
    record(
      '失败时还告诉用户下一步做什么',
      /充值|控制台/.test(failResult.hint ?? ''),
      (failResult.hint ?? '').slice(0, 90),
    );
    await cdp.screenshot(path.join(OUT_DIR, 'api-02-balance-error.png'));

    // 失败的题不能污染已有题组：仍是 2 道
    const finalCount = await cdp.eval(`(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('openleaner');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction('questions', 'readonly');
        const req = tx.objectStore('questions').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return rows.length;
    })()`);
    record('失败的请求没有留下半截题', finalCount === 2, `questions=${finalCount}`);

    // ---------- 8. 窄屏截图（出题页也要看） ----------
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 560,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(600);
    await cdp.screenshot(path.join(OUT_DIR, 'api-03-narrow.png'));
    record('窄屏截图已产出', fs.existsSync(path.join(OUT_DIR, 'api-03-narrow.png')));
  } catch (err) {
    record('脚本执行', false, err instanceof Error ? err.message : String(err));
  } finally {
    try {
      edge.kill();
    } catch {
      /* ignore */
    }
    await sleep(500);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    if (failed.length > 0) {
      console.log('FAILED:');
      for (const f of failed) console.log(`  - ${f.name}  ${f.detail}`);
      process.exitCode = 1;
    }
  }
}

void main();

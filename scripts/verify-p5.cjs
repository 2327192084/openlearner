/**
 * P5 验收探针：AI 接入。
 *
 * 对应计划书 P5「算做完」里本轮能验的部分：
 *  - 未配置任何后端时，界面明确提示且可跳转设置
 *  - 后端配置与登录凭据不出现在界面截图中
 *  - 后端可切换（示例后端 vs 真实模型）
 *  - 界面在调用前就告知可用性，不做「点了才发现不能用」
 *
 * 真实 API 调用**不在自动验收里**：那需要一把有效的 Key，
 * 且会产生费用。真调用由人工在设置页点「测试连接」验证一次，
 * 这一点在验收报告里如实写清楚，不假装自动化覆盖了。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const FIXTURES = path.join(__dirname, '..', 'src', 'test', 'fixtures');
const PORT = 9231;
const LOG = path.join(OUT_DIR, 'log-p5.txt');

const results = [];
function say(line) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(LOG, `${line}\n`);
  console.log(line);
}
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
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

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LOG, '');
  say(`P5 验收开始 ${new Date().toISOString()}\n`);

  const userDataDir = path.join(OUT_DIR, 'edge-profile-p5');
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
      '--window-size=1400,950',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp;
  try {
    cdp = await connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // 拦截网络：把发给各家模型服务的请求换成假响应，
    // 这样能验证「真后端整条链路」而不花一分钱、不需要真 Key。
    //
    // 早先只拦 api.deepseek.com，所以「换服务商」这条链路根本没有被覆盖 ——
    // 代码里写死 DeepSeek 地址与模型名的问题一直测不出来。
    // 现在把预设里的服务商都拦上，顺便记下每个请求打到哪一家。
    await cdp.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*api.deepseek.com*', requestStage: 'Request' },
        { urlPattern: '*open.bigmodel.cn*', requestStage: 'Request' },
        { urlPattern: '*api.moonshot.cn*', requestStage: 'Request' },
        { urlPattern: '*dashscope.aliyuncs.com*', requestStage: 'Request' },
        { urlPattern: '*api.siliconflow.cn*', requestStage: 'Request' },
        { urlPattern: '*api.openai.com*', requestStage: 'Request' },
        { urlPattern: '*ark.cn-beijing.volces.com*', requestStage: 'Request' },
      ],
    });

    const consoleErrors = [];
    let deepseekCalls = 0;
    let sawAuthHeader = false;
    /** 记录每次非预检请求打到了哪个主机，用于验证「换服务商真的换了地址」 */
    const calledHosts = [];
    /** 记录每次请求体里的 model，用于验证「换服务商真的换了模型名」 */
    const sentModels = [];

    cdp.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);

      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(
          msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text,
        );
      }

      // 拦住发往各家的请求，返回一个结构正确的假响应
      if (msg.method === 'Fetch.requestPaused') {
        const isOptions = (msg.params.request.method ?? '').toUpperCase() === 'OPTIONS';
        // 只统计真实的 POST（预检不算「发起了一次整理请求」）
        if (!isOptions) {
          deepseekCalls += 1;
          try {
            calledHosts.push(new URL(msg.params.request.url).host);
          } catch {
            calledHosts.push(msg.params.request.url);
          }
          const raw = msg.params.request.postData;
          if (raw) {
            try {
              const parsed = JSON.parse(raw);
              if (parsed.model) sentModels.push(parsed.model);
            } catch {
              /* 不是 JSON 就算了，不影响其余断言 */
            }
          }
        }
        const headers = msg.params.request.headers ?? {};
        if (headers.Authorization || headers.authorization) sawAuthHeader = true;

        const reqHeaders = msg.params.request.headers ?? {};
        const origin = reqHeaders.Origin || reqHeaders.origin || '*';

        /**
         * 必须处理 CORS 预检。
         *
         * 浏览器在发真实 POST 之前会先发一个 OPTIONS 预检，
         * 而预检本身也经过 Fetch 拦截。如果只回 200 + JSON、
         * 不回 Access-Control-Allow-* 头，浏览器会判定为 CORS 失败，
         * 前端拿到的是 `Failed to fetch` —— 看起来像网络错误，
         * 实际是被我们自己的假响应挡了。
         *
         * 真实 DeepSeek 接口当然会返回这些头（P5 前置调研已实测放行），
         * 所以这是探针的问题，不是产品的问题。
         */
        const corsHeaders = [
          { name: 'Access-Control-Allow-Origin', value: origin === '*' ? '*' : origin },
          { name: 'Access-Control-Allow-Methods', value: 'POST, OPTIONS' },
          { name: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
          { name: 'Access-Control-Max-Age', value: '600' },
        ];

        const isPreflight =
          (msg.params.request.method ?? '').toUpperCase() === 'OPTIONS';

        if (isPreflight) {
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

        const body = JSON.stringify({
          model: 'deepseek-chat',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  points: [
                    {
                      statement: '（假响应）线性表是由有限个数据元素构成的序列',
                      quotes: ['线性表是由 n 个数据元素构成的有限序列'],
                      cognitiveLevel: 'remember',
                      tags: ['假响应'],
                    },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
        });

        void cdp
          .send('Fetch.fulfillRequest', {
            requestId: msg.params.requestId,
            responseCode: 200,
            responseHeaders: [
              { name: 'Content-Type', value: 'application/json' },
              ...corsHeaders,
            ],
            body: Buffer.from(body).toString('base64'),
          })
          .catch(() => {
            /* 请求可能已取消 */
          });
      }
    });

    // ---------- 准备：建库 + 导入资料 ----------
    await cdp.send('Page.navigate', { url: `${APP_URL}/#/settings` });
    await sleep(3500);

    await cdp.eval(`(async () => {
      const input = document.querySelector('.card input.input');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'P5 验收库');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'));
        if (btn) { btn.click(); await new Promise(r => setTimeout(r, 1500)); }
      }
    })()`);

    await cdp.eval(`location.hash = '#/sources'`);
    await sleep(1800);

    const pdfB64 = fs
      .readFileSync(path.join(FIXTURES, 'course.pdf'))
      .toString('base64');
    await cdp.eval(`(async () => {
      const b64 = ${JSON.stringify(pdfB64)};
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], '数据结构复习.pdf', { type: 'application/pdf' });
      const input = document.querySelector('input[type=file]');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 5000));
    })()`);

    // ---------- 1. 未配置后端时，知识点页给出明确指引 ----------
    await cdp.eval(`location.hash = '#/knowledge'`);
    await sleep(2200);
    await cdp.eval(`(async () => {
      const selects = [...document.querySelectorAll('select')];
      for (const sel of selects) {
        const opt = [...sel.options].find(o => o.textContent.includes('数据结构复习'));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); break; }
      }
      await new Promise(r => setTimeout(r, 1800));
    })()`);

    const selectorState = await cdp.eval(`(() => {
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      // 找后端选择下拉框（id 为 kp-backend）
      const sel = document.getElementById('kp-backend');
      const opts = sel ? [...sel.options].map(o => ({ text: o.textContent.trim(), disabled: o.disabled })) : [];
      return {
        hasSelector: !!sel,
        options: opts,
        // 未配置真后端时，应当有「去设置页配」之类的指引
        // 界面上的按钮叫「设置」，文案写的是「先到「设置」添加一个 AI 后端」，
        // 早先只匹配「设置页」，把正确文案判成了缺失。
        givesGuidance: /设置/.test(text) && /API Key|真模型|AI 后端/.test(text),
        text: text.slice(0, 500),
      };
    })()`);

    record(
      '知识点页有后端选择器',
      selectorState.hasSelector,
      selectorState.hasSelector ? `共 ${selectorState.options.length} 个选项` : '找不到 #kp-backend',
    );
    record(
      '**未配置真后端时给出明确指引（不是点了才发现不能用）**',
      selectorState.givesGuidance,
      selectorState.givesGuidance ? '' : selectorState.text.slice(0, 80).replace(/\n/g, ' '),
    );
    await cdp.screenshot(path.join(OUT_DIR, 'p5-01-no-backend.png'));

    // ---------- 2. 设置页能录入后端 ----------
    await cdp.eval(`location.hash = '#/settings'`);
    await sleep(2000);

    const addBackend = await cdp.eval(`(async () => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('添加后端'));
      if (!btn) return { ok: false, why: '找不到添加后端按钮' };
      btn.click();
      await new Promise(r => setTimeout(r, 800));

      const keyInput = document.querySelector('#bf-key');
      return {
        ok: true,
        formOpen: !!document.querySelector('.backend-form'),
        keyIsPassword: keyInput?.type === 'password',
      };
    })()`);

    record(
      '设置页可打开添加后端表单，且 Key 输入是 password',
      addBackend.ok && addBackend.formOpen && addBackend.keyIsPassword,
      addBackend.ok ? '' : addBackend.why,
    );

    // ---------- 3. 填入假 Key 并保存 ----------
    const FAKE_KEY = 'sk-fake-key-for-acceptance-test-1234567890';
    const saved = await cdp.eval(`(async () => {
      const setVal = (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      };

      setVal('#bf-key', ${JSON.stringify(FAKE_KEY)});
      const submit = [...document.querySelectorAll('.backend-form button')].find(b => b.textContent.includes('保存'));
      if (!submit) return { ok: false, why: '找不到保存按钮' };
      submit.click();
      await new Promise(r => setTimeout(r, 2000));

      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return {
        ok: true,
        text: text.slice(0, 600),
        // 关键安全检查：明文 key 绝不能出现在 DOM 里
        keyLeaked: document.body.innerHTML.includes(${JSON.stringify(FAKE_KEY)}),
        hasTestButton: [...document.querySelectorAll('button')].some(b => b.textContent.includes('测试连接')),
      };
    })()`);

    record(
      '能保存后端配置并出现「测试连接」按钮',
      saved.ok && saved.hasTestButton,
      saved.ok ? '' : saved.why,
    );
    record(
      '**明文 API Key 不出现在页面 DOM 里**',
      saved.ok && !saved.keyLeaked,
      saved.keyLeaked ? '！明文泄露！' : '',
    );
    await cdp.screenshot(path.join(OUT_DIR, 'p5-02-backend-saved.png'));

    // ---------- 4. 点「测试连接」走完整真实调用链路（网络被拦截） ----------
    const tested = await cdp.eval(`(async () => {
      const before = ${deepseekCalls};
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('测试连接'));
      if (!btn) return { ok: false, why: '找不到测试连接按钮' };
      btn.click();
      await new Promise(r => setTimeout(r, 4000));

      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return {
        ok: true,
        text: text.slice(0, 800),
        showsSuccess: /连接正常/.test(text),
        showsFail: /连接失败/.test(text),
      };
    })()`);

    record(
      '**点「测试连接」真的发出了 HTTP 请求并拿到响应**',
      tested.ok && deepseekCalls > 0,
      `拦截到 ${deepseekCalls} 次 DeepSeek 请求`,
    );
    record(
      '测试连接的结果就地显示在卡片上',
      tested.ok && (tested.showsSuccess || tested.showsFail),
      tested.ok ? (tested.showsSuccess ? '显示「连接正常」' : '显示「连接失败」') : tested.why,
    );
    record(
      '请求带了 Authorization 头（Key 确实被送出去了，但没落在界面上）',
      sawAuthHeader,
      sawAuthHeader ? '' : '没有拦截到 Authorization 头',
    );
    await cdp.screenshot(path.join(OUT_DIR, 'p5-03-test-connection.png'));

    /**
     * ---------- 4b. 换服务商：地址与模型名必须跟着换 ----------
     *
     * 这条是「多 API 接入」的核心价值，也是最容易被写死的地方。
     * 早先的代码不管 provider 是什么，一律构造 DeepSeek 后端、
     * 一律把模型名兜底成 deepseek-chat —— 用户配了智谱也照样发去 DeepSeek，
     * 报错还是「模型不存在」，完全看不出是代码写死。
     *
     * 所以这里真的要切一次服务商，然后检查网络里打出去的主机与模型名。
     */
    await cdp.eval(`location.hash = '#/settings'`);
    await sleep(2000);

    const switched = await cdp.eval(`(async () => {
      // 打开编辑表单
      const editBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '编辑');
      if (!editBtn) return { ok: false, why: '找不到编辑按钮' };
      editBtn.click();
      await new Promise(r => setTimeout(r, 900));

      const sel = document.getElementById('bf-provider');
      if (!sel) return { ok: false, why: '找不到服务商下拉框' };

      // 切到智谱
      const target = [...sel.options].find(o => o.value === 'zhipu');
      if (!target) return { ok: false, why: '下拉框里没有智谱', options: [...sel.options].map(o => o.value) };
      sel.value = 'zhipu';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 700));

      const base = document.getElementById('bf-base')?.value ?? '';
      const model = document.getElementById('bf-model')?.value ?? '';

      const submit = [...document.querySelectorAll('.backend-form button')].find(b => b.textContent.includes('保存'));
      if (!submit) return { ok: false, why: '找不到保存按钮' };
      submit.click();
      await new Promise(r => setTimeout(r, 2200));

      return { ok: true, base, model, text: (document.querySelector('.shell__content')?.innerText ?? '').slice(0, 400) };
    })()`);

    record(
      '切换服务商后接口地址与模型名自动跟着换（不是留在 DeepSeek）',
      switched.ok &&
        switched.base.includes('bigmodel.cn') &&
        switched.model.includes('glm'),
      switched.ok ? `地址=${switched.base} 模型=${switched.model}` : switched.why,
    );

    // 再点一次测试连接，检查真实打出去的主机是不是智谱
    const hostBefore = calledHosts.length;
    await cdp.eval(`(async () => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('测试连接'));
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 4000));
    })()`);
    const newHosts = calledHosts.slice(hostBefore);

    record(
      '**换成智谱后请求真的打到智谱，没有偷偷发去 DeepSeek**',
      newHosts.length > 0 && newHosts.some((h) => h.includes('bigmodel.cn')),
      newHosts.length ? `本轮到访：${[...new Set(newHosts)].join(', ')}` : '没有发出请求',
    );
    record(
      '请求体里的模型名是智谱的模型（没有沿用 deepseek-chat）',
      sentModels.length > 0 && sentModels.some((m) => /glm/i.test(m)),
      sentModels.length ? `最近发送的模型：${[...new Set(sentModels)].slice(-3).join(', ')}` : '没有捕获到请求体',
    );
    await cdp.screenshot(path.join(OUT_DIR, 'p5-04-provider-switched.png'));

    // ---------- 5. 后端可切换，且切到真模型后界面提示会花钱 ----------
    await cdp.eval(`location.hash = '#/knowledge'`);
    await sleep(2200);
    await cdp.eval(`(async () => {
      const selects = [...document.querySelectorAll('select')];
      for (const sel of selects) {
        const opt = [...sel.options].find(o => o.textContent.includes('数据结构复习'));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); break; }
      }
      await new Promise(r => setTimeout(r, 1800));
    })()`);

    const switchState = await cdp.eval(`(async () => {
      const sel = document.getElementById('kp-backend');
      if (!sel) return { ok: false, why: '找不到后端选择器' };

      const opts = [...sel.options].map(o => ({ value: o.value, text: o.textContent.trim(), disabled: o.disabled }));
      // 找一个可用的真后端选项并选中
      const real = opts.find(o => o.value !== 'mock' && !o.disabled);
      if (!real) return { ok: true, opts, switched: false };

      sel.value = real.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1200));

      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return {
        ok: true,
        opts,
        switched: true,
        warnsCost: /会产生费用|会消耗你的 API 额度/.test(text),
        text: text.slice(0, 400),
      };
    })()`);

    record(
      '真后端出现在下拉框里且可选',
      switchState.ok && switchState.opts.some((o) => o.value !== 'mock' && !o.disabled),
      switchState.ok ? JSON.stringify(switchState.opts.map((o) => `${o.text}${o.disabled ? '[禁用]' : ''}`)) : switchState.why,
    );
    record(
      '**切到真模型后界面明确提示会花钱**',
      switchState.ok && switchState.switched && switchState.warnsCost,
      switchState.ok ? (switchState.switched ? '' : '没有可切换的真后端') : switchState.why,
    );
    await cdp.screenshot(path.join(OUT_DIR, 'p5-04-real-backend.png'));

    // ---------- 6. 用真后端整理：整条链路跑通（网络拦截） ----------
    /**
     * 注意：这里**不能**在页面内算 callsDelta。
     *
     * `before = ${deepseekCalls}` 里的插值在字符串生成时就固化成数字了，
     * 页面里 `await` 之后的 `${deepseekCalls}` 又是同一个固化值，
     * 相减恒为 0 —— 看起来像「没发请求」，实际发了。
     * 正确做法是在 Node 侧比较点击前后的计数。
     */
    const callsBeforeGenerate = deepseekCalls;

    const generateState = await cdp.eval(`(async () => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => /开始整理|生成知识点|开始生成/.test(b.textContent ?? ''));
      if (!btn) return { ok: false, why: '找不到整理按钮' };
      btn.click();
      await new Promise(r => setTimeout(r, 8000));

      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return { ok: true, text: text.slice(0, 600) };
    })()`);

    const callsDelta = deepseekCalls - callsBeforeGenerate;

    record(
      '真后端整理链路发起了请求',
      generateState.ok && callsDelta > 0,
      generateState.ok ? `本次新增 ${callsDelta} 次请求` : generateState.why,
    );

    // 库里应当出现假响应里那条知识点
    const dbCheck = await cdp.eval(`(async () => {
      const openDb = () => new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await openDb();
      const readAll = (name) => new Promise((res, rej) => {
        const tx = db.transaction(name, 'readonly');
        const req = tx.objectStore(name).getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const points = await readAll('knowledgePoints');
      const runs = await readAll('generationRuns');
      db.close();

      const fromFake = points.filter(p => p.backendId && p.backendId !== 'mock');
      return {
        total: points.length,
        fromRealBackend: fromFake.length,
        sample: fromFake.slice(0, 2).map(p => ({
          statement: p.statement.slice(0, 30),
          status: p.anchorStatus,
          page: p.anchors?.[0]?.page ?? null,
          backendId: p.backendId,
        })),
        runBackend: runs.sort((a,b) => new Date(b.startedAt) - new Date(a.startedAt))[0]?.backendId ?? null,
        runActualTokens: runs.sort((a,b) => new Date(b.startedAt) - new Date(a.startedAt))[0]?.actualTokens ?? null,
      };
    })()`);

    record(
      '**真后端产出的知识点进了库，且记录了 backendId**',
      dbCheck.fromRealBackend > 0,
      `共 ${dbCheck.total} 条，其中来自真后端 ${dbCheck.fromRealBackend} 条；backendId=${JSON.stringify(dbCheck.sample.map((s) => s.backendId))}`,
    );
    record(
      '真后端的返回也走了定位器（有页码说明定位成功）',
      dbCheck.sample.every((s) => s.page !== null),
      JSON.stringify(dbCheck.sample),
    );
    record(
      '记录了真实用量（token 数）',
      typeof dbCheck.runActualTokens === 'number' && dbCheck.runActualTokens > 0,
      `实际用量 ${dbCheck.runActualTokens}`,
    );
    await cdp.screenshot(path.join(OUT_DIR, 'p5-05-generated.png'));

    // ---------- 7. 无控制台错误 ----------
    record(
      'P5 全流程无 console 错误 / 未捕获异常',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | '),
    );

    const failed = results.filter((r) => !r.ok);
    say('\n================ 汇总 ================');
    say(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    if (failed.length > 0) {
      for (const f of failed) say(`  - ${f.name}${f.detail ? `  ${f.detail}` : ''}`);
    }
    fs.writeFileSync(
      path.join(OUT_DIR, 'report-p5.json'),
      JSON.stringify({ results, consoleErrors }, null, 2),
    );
    return failed.length;
  } finally {
    try {
      cdp?.ws.close();
    } catch {
      /* ignore */
    }
    edge.kill();
  }
}

main()
  .then((n) => process.exit(n === 0 ? 0 : 1))
  .catch((err) => {
    say(`探针自身出错：${err && err.stack ? err.stack : err}`);
    process.exit(2);
  });

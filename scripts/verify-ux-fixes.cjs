/**
 * 验证两处改动：
 *  1. 扫描件提示里的两条出路（OCR / 看图模型）真的显示出来，且说了代价
 *  2. 知识点卡片标出「示例后端·非 AI」，不再让人误以为 AI 总结能力差
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const FIXTURES = path.join(__dirname, '..', 'src', 'test', 'fixtures');
const PORT = 9232;

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
  const userDataDir = path.join(OUT_DIR, 'edge-profile-u1');
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
      '--window-size=1400,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp;
  try {
    cdp = await connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Page.navigate', { url: `${APP_URL}/#/settings` });
    await sleep(3500);

    // 建库
    await cdp.eval(`(async () => {
      const input = document.querySelector('.card input.input');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '验证库');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'));
        if (btn) { btn.click(); await new Promise(r => setTimeout(r, 1500)); }
      }
    })()`);

    // 导入扫描件
    await cdp.eval(`location.hash = '#/sources'`);
    await sleep(1800);

    const scanB64 = fs.readFileSync(path.join(FIXTURES, 'scanned.pdf')).toString('base64');
    await cdp.eval(`(async () => {
      const b64 = ${JSON.stringify(scanB64)};
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], '扫描版讲义.pdf', { type: 'application/pdf' });
      const input = document.querySelector('input[type=file]');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 4000));
    })()`);

    // 打开阅读器
    await cdp.eval(`(async () => {
      const btn = document.querySelector('.source-item__main');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 2500));
    })()`);

    // ---------- 1. 两条出路都显示了 ----------
    const noticeState = await cdp.eval(`(() => {
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return {
        text: text.slice(0, 1400),
        hasOcr: /OCR|本地文字识别/.test(text),
        hasVision: /看图模型|视觉大模型/.test(text),
        // 关键：必须如实说明 OCR 的局限
        warnsOcrQuality: /效果要如实说|九成|公式.*差|准确/.test(text),
        // 必须说明看图模型按页计费
        warnsCost: /按页.*收费|按页计费/.test(text),
        // 给出现实建议
        suggestsTextVersion: /带文字层的版本|选中一句话/.test(text),
        optionCount: document.querySelectorAll('.scan-option').length,
      };
    })()`);

    record(
      '扫描件提示里给出两条技术路线',
      noticeState.hasOcr && noticeState.hasVision,
      `OCR=${noticeState.hasOcr} 看图模型=${noticeState.hasVision} 选项块=${noticeState.optionCount}`,
    );
    record(
      '**如实说明 OCR 效果有限（没说成万能）**',
      noticeState.warnsOcrQuality,
      noticeState.warnsOcrQuality ? '' : '没有提到准确率或局限',
    );
    record(
      '如实说明看图模型按页计费',
      noticeState.warnsCost,
    );
    record(
      '给出眼下最省事的建议（找带文字层的版本）',
      noticeState.suggestsTextVersion,
    );
    await cdp.screenshot(path.join(OUT_DIR, 'u1-scan-options.png'));

    // ---------- 2. 用示例后端生成，看卡片是否标明 ----------
    // 必须先点界面上的「返回资料库」离开阅读器。
    // 只改 location.hash 不会让 React 重渲染（hash 没变），
    // 界面会一直停在阅读器里，于是找不到文件输入框。
    await cdp.eval(`(async () => {
      const back = [...document.querySelectorAll('button')]
        .find(b => /返回资料库|返回/.test(b.textContent ?? ''));
      if (back) back.click();
      else location.hash = '#/sources';
      await new Promise(r => setTimeout(r, 2000));
    })()`);

    const pdfB64 = fs.readFileSync(path.join(FIXTURES, 'course.pdf')).toString('base64');
    await cdp.eval(`(async () => {
      const b64 = ${JSON.stringify(pdfB64)};
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], '正常教材.pdf', { type: 'application/pdf' });
      const input = document.querySelector('input[type=file]');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 5000));
    })()`);

    await cdp.eval(`location.hash = '#/knowledge'`);
    await sleep(2200);

    await cdp.eval(`(async () => {
      const selects = [...document.querySelectorAll('select')];
      for (const sel of selects) {
        const opt = [...sel.options].find(o => o.textContent.includes('正常教材'));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); break; }
      }
      await new Promise(r => setTimeout(r, 1500));
      const btn = [...document.querySelectorAll('button')].find(b => /开始整理|生成知识点/.test(b.textContent ?? ''));
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 12000));
    })()`);

    const cardState = await cdp.eval(`(() => {
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return {
        text: text.slice(0, 1000),
        // 卡片上必须标明这是示例后端
        marksMock: /示例后端|非 AI/.test(text),
        // statement 应当明确写「原文摘录·未经提炼」
        marksExcerpt: /原文摘录|未经提炼/.test(text),
        cardCount: document.querySelectorAll('.kp-card').length,
      };
    })()`);

    record(
      '**知识点卡片标明「示例后端·非 AI」**',
      cardState.marksMock,
      cardState.marksMock ? '' : cardState.text.slice(0, 100).replace(/\n/g, ' '),
    );
    record(
      '示例后端的表述明确写成「原文摘录·未经提炼」',
      cardState.marksExcerpt,
      cardState.marksExcerpt ? '' : `卡片数 ${cardState.cardCount}`,
    );
    await cdp.screenshot(path.join(OUT_DIR, 'u1-mock-labelled.png'));

    const failed = results.filter((r) => !r.ok);
    console.log(`\n============ 总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length} ============`);
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
  .catch((e) => {
    console.error('探针出错:', e);
    process.exit(2);
  });

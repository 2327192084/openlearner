/**
 * P0 验收探针 · CDP 版
 *
 * 为什么不用 --dump-dom：虚拟时间预算对 IndexedDB 的异步回调不生效，
 * DOM 会在「正在准备学习库…」那一帧被截下来，看不到真实界面。
 *
 * 这里通过 Chrome DevTools Protocol 连上无头 Edge，能：
 *   - 等 React 真正挂载完成
 *   - 真实点击导航、填表单、点按钮
 *   - 执行 JS 断言 IndexedDB 内容
 *   - 截图存证
 *
 * 只用 Node 内置能力（fetch + WebSocket），不额外装 puppeteer。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const PORT = 9222;

const results = [];
const LOG = path.join(OUT_DIR, 'log.txt');

function resetLog() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LOG, '');
}
function say(line) {
  fs.appendFileSync(LOG, `${line}\n`);
  console.log(line);
}
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  say(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端：一条 WebSocket，按 id 收发 */
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
      }, 30000);
    });
  }

  /** 求值并返回 JSON 值；表达式里的 await 由 returnByValue + awaitPromise 处理 */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        `求值异常: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ''}`,
      );
    }
    return res.result.value;
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
}

async function connect() {
  // 等 CDP 端口起来
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) break;
    } catch {
      /* 还没起来，继续等 */
    }
    await sleep(250);
  }

  // 关键：/json/version 给的是**浏览器级** WebSocket，它不支持 Page 域。
  // 必须新建一个页面目标，再连该目标自己的 page-level WebSocket。
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
  resetLog();
  say(`开始验收 ${new Date().toISOString()}`);

  const userDataDir = path.join(OUT_DIR, 'edge-profile');
  fs.rmSync(userDataDir, { recursive: true, force: true });

  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=1280,860',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp;
  try {
    cdp = await connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    // 收集控制台错误
    const consoleErrors = [];
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
    });

    // ---------- 1. 首屏 ----------
    await cdp.send('Page.navigate', { url: `${APP_URL}/` });
    await sleep(3500);

    const shell = await cdp.eval(`(() => {
      const links = [...document.querySelectorAll('.shell__link')].map(a => ({
        text: a.textContent.trim(),
        href: a.getAttribute('href'),
      }));
      return {
        hasNav: !!document.querySelector('.shell__nav'),
        hasContent: !!document.querySelector('.shell__content'),
        links,
        title: document.querySelector('.shell__page-title')?.textContent ?? null,
        hash: location.hash,
        rootEmpty: document.getElementById('root').children.length === 0,
        bodyLen: document.body.innerText.length,
      };
    })()`);

    record('应用启动并渲染出外壳', shell.hasNav && shell.hasContent && !shell.rootEmpty);
    record('导航条目由注册表生成', shell.links.length === 7, `实际 ${shell.links.length} 条：${shell.links.map((l) => l.text).join('、')}`);
    record('默认落地页重定向到第一个导航页', shell.hash === '#/sources', `hash=${shell.hash}`);
    await cdp.screenshot(path.join(OUT_DIR, '01-first-screen.png'));

    // ---------- 2. 六个页面 + 验证页逐个点通 ----------
    const expected = [
      ['sources', '资料库'],
      ['knowledge', '知识点'],
      ['decks', '习题集'],
      ['practice', '练习'],
      ['slides', '生成 PPT'],
      ['settings', '设置'],
      ['demo', '可插拔验证页'],
    ];

    for (const [id, title] of expected) {
      const clicked = await cdp.eval(`(() => {
        const link = [...document.querySelectorAll('.shell__link')]
          .find(a => (a.getAttribute('href') ?? '').endsWith('/${id}'));
        if (!link) return false;
        link.click();
        return true;
      })()`);
      await sleep(500);

      const state = await cdp.eval(`(() => ({
        title: document.querySelector('.shell__page-title')?.textContent ?? null,
        heading: document.querySelector('.page__title')?.textContent ?? null,
        hash: location.hash,
        contentLen: (document.querySelector('.shell__content')?.innerText ?? '').length,
        shellAlive: !!document.querySelector('.shell'),
      }))()`);

      record(
        `页面「${title}」可点通、标题正确、有内容`,
        clicked &&
          state.title === title &&
          state.heading === title &&
          state.contentLen > 30 &&
          state.shellAlive &&
          state.hash === `#/${id}`,
        `hash=${state.hash} 顶栏=${state.title} 正文=${state.heading} 长度=${state.contentLen}`,
      );
    }

    // ---------- 3. 占位页真的说了「待接入」 ----------
    await cdp.eval(`[...document.querySelectorAll('.shell__link')].find(a => (a.getAttribute('href') ?? '').endsWith('/knowledge')).click()`);
    await sleep(400);
    const placeholderText = await cdp.eval(
      `document.querySelector('.shell__content')?.innerText ?? ''`,
    );
    record(
      '占位页显示「该功能待接入」',
      placeholderText.includes('该功能待接入'),
      placeholderText.slice(0, 40).replace(/\n/g, ' '),
    );

    // ---------- 4. 设置页空态 ----------
    await cdp.eval(`[...document.querySelectorAll('.shell__link')].find(a => (a.getAttribute('href') ?? '').endsWith('/settings')).click()`);
    await sleep(700);
    const emptyState = await cdp.eval(`(() => {
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return {
        text,
        hasCreateBtn: [...document.querySelectorAll('button')].some(b => b.textContent.includes('创建学习库')),
        hasNewLibNotice: text.includes('还没有学习库'),
      };
    })()`);
    record('未建库时显示建库引导（统一空态）', emptyState.hasCreateBtn && emptyState.hasNewLibNotice);
    await cdp.screenshot(path.join(OUT_DIR, '02-settings-empty.png'));

    // ---------- 5. 建库 ----------
    const created = await cdp.eval(`(() => {
      const input = document.querySelector('.card input.input');
      if (!input) return { ok: false, why: '找不到输入框' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '数据结构复习');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('创建学习库'));
      if (!btn) return { ok: false, why: '找不到建库按钮' };
      btn.click();
      return { ok: true };
    })()`);
    await sleep(1500);

    const afterCreate = await cdp.eval(`(() => {
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      const btns = [...document.querySelectorAll('button')].map(b => b.textContent.trim());
      return { text, btns, name: document.querySelector('.card input.input')?.value ?? null };
    })()`);
    record(
      '建库成功（出现导出/恢复入口，库名回显）',
      created.ok &&
        afterCreate.btns.some((t) => t.includes('导出学习库')) &&
        afterCreate.btns.some((t) => t.includes('从备份恢复')) &&
        afterCreate.name === '数据结构复习',
      `库名=${afterCreate.name}`,
    );
    await cdp.screenshot(path.join(OUT_DIR, '03-settings-created.png'));

    // ---------- 6. 真正的「重启后还在」：整页重载 ----------
    await cdp.send('Page.reload');
    await sleep(3500);
    await cdp.eval(`[...document.querySelectorAll('.shell__link')].find(a => (a.getAttribute('href') ?? '').endsWith('/settings'))?.click()`);
    await sleep(1200);

    const afterReload = await cdp.eval(`(() => {
      const nameInput = document.querySelector('.card input.input');
      const btns = [...document.querySelectorAll('button')].map(b => b.textContent.trim());
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return {
        name: nameInput?.value ?? null,
        hasExport: btns.some(t => t.includes('导出学习库')),
        stillShowCreate: btns.some(t => t.includes('创建学习库')),
        mentions: text.includes('数据结构复习'),
      };
    })()`);
    record(
      '整页重载后学习库仍在（模拟重启）',
      afterReload.name === '数据结构复习' && afterReload.hasExport && !afterReload.stillShowCreate,
      `库名=${afterReload.name} 仍有导出入口=${afterReload.hasExport}`,
    );
    await cdp.screenshot(path.join(OUT_DIR, '04-after-reload.png'));

    // ---------- 7. IndexedDB 实际内容 ----------
    const dbState = await cdp.eval(`(async () => {
      const open = () => new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await open();
      const stores = [...db.objectStoreNames];
      const readAll = (name) => new Promise((res, rej) => {
        const tx = db.transaction(name, 'readonly');
        const req = tx.objectStore(name).getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const out = {};
      for (const s of stores) out[s] = (await readAll(s)).length;
      const meta = await readAll('meta');
      db.close();
      return { stores, counts: out, metaName: meta[0]?.name ?? null, metaCount: meta.length };
    })()`);
    record(
      'IndexedDB 分区齐全且 meta 已落库',
      dbState.stores.length === 10 &&
        dbState.metaCount === 1 &&
        dbState.metaName === '数据结构复习' &&
        dbState.counts.settings === 1,
      `分区 ${dbState.stores.length} 个，meta=${dbState.metaName}，settings=${dbState.counts.settings}`,
    );

    // ---------- 8. 设置页的后端录入区在 ----------
    const backendArea = await cdp.eval(`(() => {
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return {
        hasBackend: text.includes('AI 后端'),
        hasAddBtn: [...document.querySelectorAll('button')].some(b => b.textContent.includes('添加后端')),
        saysNoRequest: text.includes('不会发出任何请求') || text.includes('不联调'),
      };
    })()`);
    record(
      '设置页有 AI 后端录入区，并说明 P0 不联调',
      backendArea.hasBackend && backendArea.hasAddBtn && backendArea.saysNoRequest,
    );

    // ---------- 9. 后端表单能开、凭据框是 password ----------
    const formOpen = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('添加后端'));
      if (!btn) return { ok: false };
      btn.click();
      return { ok: true };
    })()`);
    await sleep(500);
    const formState = await cdp.eval(`(() => {
      const keyInput = document.querySelector('.backend-form input#bf-key');
      return {
        formExists: !!document.querySelector('.backend-form'),
        keyIsPassword: keyInput?.type === 'password',
        keyAutocompleteOff: keyInput?.getAttribute('autocomplete') === 'off',
        hasCapabilityBoxes: document.querySelectorAll('.backend-form__caps input[type=checkbox]').length,
        defaultModelValue: document.querySelector('#bf-model')?.value ?? null,
        defaultBaseValue: document.querySelector('#bf-base')?.value ?? null,
      };
    })()`);
    record(
      '后端表单可打开，凭据输入为 password 且禁用自动填充',
      formOpen.ok && formState.formExists && formState.keyIsPassword && formState.keyAutocompleteOff,
      `模型默认=${formState.defaultModelValue}`,
    );
    record(
      '后端表单有 3 项能力勾选（文字整理/看图/联网）',
      formState.hasCapabilityBoxes === 3,
      `实际 ${formState.hasCapabilityBoxes} 项`,
    );
    await cdp.screenshot(path.join(OUT_DIR, '05-backend-form.png'));

    // ---------- 10. 保存后端后凭据不回显 ----------
    const savedBackend = await cdp.eval(`(async () => {
      const setVal = (sel, val) => {
        const el = document.querySelector(sel);
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setVal('#bf-key', 'sk-verify-secret-should-not-leak-1234');
      const submit = [...document.querySelectorAll('.backend-form button')].find(b => b.textContent.includes('保存'));
      submit.click();
      await new Promise(r => setTimeout(r, 1500));
      return {
        bodyText: document.querySelector('.shell__content')?.innerText ?? '',
        hasBackendItem: !!document.querySelector('.backend-item'),
        keyStillInDom: document.body.innerHTML.includes('sk-verify-secret-should-not-leak-1234'),
      };
    })()`);
    record(
      '保存后端后列表出现该项',
      savedBackend.hasBackendItem,
      savedBackend.hasBackendItem ? '' : savedBackend.bodyText.slice(0, 100),
    );
    record(
      '凭据明文不出现在页面 DOM 里',
      !savedBackend.keyStillInDom,
      savedBackend.keyStillInDom ? '！明文泄露！' : '',
    );

    // 保存后端后，「库内记录 · 后端 N」的计数必须跟着变。
    // 这一条是补上的回归断言：界面显示 0 后端但列表里有一个，就是在说谎。
    const countAfterSave = await cdp.eval(`(() => {
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      const m = text.match(/后端\\s*(\\d+)/);
      return { matched: m ? m[1] : null, text: text.split('\\n').find(l => l.includes('库内记录')) ?? '' };
    })()`);
    record(
      '后端数量计数同步更新（不显示过期的 0）',
      countAfterSave.matched === '1',
      `计数=${countAfterSave.matched} 行=${countAfterSave.text.slice(0, 60)}`,
    );
    await cdp.screenshot(path.join(OUT_DIR, '06-backend-saved.png'));

    // ---------- 11. 导出备份不含凭据 ----------
    const exportCheck = await cdp.eval(`(async () => {
      // 从 IndexedDB 直接构造备份内容，复刻 exportBackup 的读取范围
      const open = () => new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await open();
      const stores = [...db.objectStoreNames];
      const readAll = (name) => new Promise((res, rej) => {
        const tx = db.transaction(name, 'readonly');
        const req = tx.objectStore(name).getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const exported = ['courses','sources','knowledgePoints','decks','questions','slideDecks','backends'];
      const dumping = {};
      for (const s of exported) dumping[s] = await readAll(s);
      const json = JSON.stringify(dumping);
      db.close();
      return {
        stores,
        containsSecret: json.includes('sk-verify-secret-should-not-leak-1234'),
        hasSecretsStore: stores.includes('secrets'),
      };
    })()`);
    record(
      '导出范围（不含 secrets 分区）里没有凭据明文',
      !exportCheck.containsSecret,
      exportCheck.containsSecret ? '！凭据进了导出范围！' : '',
    );

    // ---------- 12. 真实导出 → 清库 → 导入 往返 ----------
    // 单元测试已覆盖 exportBackup/importBackup 的逻辑，
    // 这里要验的是**界面上那条路**真的通：点导出拿到文件、点导入能恢复。
    const roundTrip = await cdp.eval(`(async () => {
      // 拦截 a.click() 的下载，把 blob 内容取出来（无头环境不会真的落盘）
      let captured = null;
      const origCreate = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        captured = blob;
        return origCreate.call(URL, blob);
      };

      const exportBtn = [...document.querySelectorAll('button')]
        .find(b => b.textContent.includes('导出学习库'));
      if (!exportBtn) return { ok: false, why: '找不到导出按钮' };
      exportBtn.click();
      await new Promise(r => setTimeout(r, 1200));

      URL.createObjectURL = origCreate;

      if (!captured) return { ok: false, why: '没有产生下载 blob' };
      const text = await captured.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (e) { return { ok: false, why: '导出的不是合法 JSON: ' + e.message }; }

      return {
        ok: true,
        format: parsed.format,
        schemaVersion: parsed.schemaVersion,
        libName: parsed.meta?.name,
        hasCourses: Array.isArray(parsed.courses),
        // 凭据绝不能出现在导出文件里
        leaksSecret: text.includes('sk-verify-secret-should-not-leak-1234'),
        hasSecretsKey: 'secrets' in parsed,
        rawLength: text.length,
      };
    })()`);

    record(
      '点「导出学习库」真的产出合法备份文件',
      roundTrip.ok && roundTrip.format === 'openleaner-library' && roundTrip.libName === '数据结构复习',
      roundTrip.ok ? `格式=${roundTrip.format} 版本=${roundTrip.schemaVersion} 大小=${roundTrip.rawLength}B` : roundTrip.why,
    );
    record(
      '导出文件不含凭据（含 secrets 键也视为失败）',
      roundTrip.ok && !roundTrip.leaksSecret && !roundTrip.hasSecretsKey,
      roundTrip.leaksSecret ? '！凭据进了导出文件！' : roundTrip.hasSecretsKey ? '！导出文件里有 secrets 键！' : '',
    );

    // 清空 IndexedDB，再走界面上的「从备份恢复」
    const restored = await cdp.eval(`(async () => {
      // 1) 先抓一份当前备份文本（复用上面的导出路径）
      let captured = null;
      const origCreate = URL.createObjectURL;
      URL.createObjectURL = (blob) => { captured = blob; return origCreate.call(URL, blob); };
      [...document.querySelectorAll('button')].find(b => b.textContent.includes('导出学习库')).click();
      await new Promise(r => setTimeout(r, 1200));
      URL.createObjectURL = origCreate;
      const backupText = await captured.text();

      // 2) 整库清空，模拟「换了一台机器」
      const del = indexedDB.deleteDatabase('openleaner');
      await new Promise((res, rej) => { del.onsuccess = res; del.onerror = () => rej(del.error); del.onblocked = res; });

      return { backupText };
    })()`);

    // 清库后重载，此时应回到「还没有学习库」
    await cdp.send('Page.reload');
    await sleep(3500);
    await cdp.eval(`[...document.querySelectorAll('.shell__link')].find(a => (a.getAttribute('href') ?? '').endsWith('/settings'))?.click()`);
    await sleep(1000);
    const afterWipe = await cdp.eval(`(() => ({
      hasCreate: [...document.querySelectorAll('button')].some(b => b.textContent.includes('创建学习库')),
      text: (document.querySelector('.shell__content')?.innerText ?? '').slice(0, 120),
    }))()`);
    record('清库重载后回到未建库状态', afterWipe.hasCreate, afterWipe.text.slice(0, 50).replace(/\n/g, ' '));

    // 3) 通过界面导入刚导出的备份
    const importResult = await cdp.eval(`(async () => {
      const backupText = ${JSON.stringify(restored.backupText)};

      // 直接调应用内的导入路径：造一个 File，走 file input 的 onChange
      const file = new File([backupText], 'backup.openleaner.json', { type: 'application/json' });
      const input = document.querySelector('input[type=file]');
      if (!input) return { ok: false, why: '找不到文件输入框' };

      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 2500));

      const btns = [...document.querySelectorAll('button')].map(b => b.textContent.trim());
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return {
        ok: true,
        name: document.querySelector('.card input.input')?.value ?? null,
        hasExport: btns.some(t => t.includes('导出学习库')),
        mentionsRestore: text.includes('已从备份恢复'),
        text: text.slice(0, 200),
      };
    })()`);

    record(
      '从备份恢复：界面显示恢复成功且库名还原',
      importResult.ok && importResult.mentionsRestore && importResult.name === '数据结构复习',
      importResult.ok ? `库名=${importResult.name} 提示=${importResult.mentionsRestore}` : importResult.why,
    );
    await cdp.screenshot(path.join(OUT_DIR, '07-after-restore.png'));

    // 4) 恢复后数据真的在 IndexedDB 里
    const dbAfterRestore = await cdp.eval(`(async () => {
      const open = () => new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await open();
      const readAll = (name) => new Promise((res, rej) => {
        const tx = db.transaction(name, 'readonly');
        const req = tx.objectStore(name).getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const meta = await readAll('meta');
      const backends = await readAll('backends');
      db.close();
      return { metaName: meta[0]?.name ?? null, backendCount: backends.length };
    })()`);
    record(
      '恢复后 IndexedDB 中库名与后端记录都还原',
      dbAfterRestore.metaName === '数据结构复习' && dbAfterRestore.backendCount === 1,
      `库名=${dbAfterRestore.metaName} 后端=${dbAfterRestore.backendCount} 个`,
    );

    // ---------- 13. 坏备份文件给出明确原因 ----------
    const badImport = await cdp.eval(`(async () => {
      const file = new File(['{"not":"a backup"}'], 'wrong.json', { type: 'application/json' });
      const input = document.querySelector('input[type=file]');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1500));
      const text = document.querySelector('.shell__content')?.innerText ?? '';
      return {
        saysNotBackup: text.includes('不是本应用的学习库备份文件'),
        givesHint: text.includes('导出学习库') || text.includes('下一步'),
        libStillOk: document.querySelector('.card input.input')?.value === '数据结构复习',
      };
    })()`);
    record(
      '导入坏文件给出明确原因，且不破坏现有库',
      badImport.saysNotBackup && badImport.libStillOk,
      `说明原因=${badImport.saysNotBackup} 现有库完好=${badImport.libStillOk}`,
    );

    // ---------- 14. 控制台无报错 ----------
    record('运行过程无 console 错误 / 未捕获异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

    // ---------- 汇总 ----------
    const failed = results.filter((r) => !r.ok);
    say('\n================ 汇总 ================');
    say(`总计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
    if (failed.length > 0) {
      say('失败项：');
      for (const f of failed) say(`  - ${f.name}${f.detail ? `  ${f.detail}` : ''}`);
    }
    fs.writeFileSync(
      path.join(OUT_DIR, 'report.json'),
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
  .then((failedCount) => process.exit(failedCount === 0 ? 0 : 1))
  .catch((err) => {
    say(`探针自身出错：${err && err.stack ? err.stack : err}`);
    process.exit(2);
  });

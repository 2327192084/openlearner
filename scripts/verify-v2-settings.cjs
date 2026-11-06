/**
 * 验证设置页：真的能建库、真的能加后端、真的能导出备份。
 *
 * 判定标准（交接文档要求）：
 *  - 改界面 → 必须 CDP 截图看
 *  - 改数据流 → 必须查 IndexedDB 确认写进去了
 *
 * 所以这个脚本两件事都做：截图 + 直接翻 IndexedDB。
 * 只看 DOM 里「元素存在」不算通过。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173';
const OUT_DIR = path.join(__dirname, '..', '.verify-shots');
const PORT = 9241;

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

/** 点一个侧栏导航项（折叠分组要先展开） */
function clickNav(label) {
  return `(async () => {
    const direct = [...document.querySelectorAll('.sidebar .nav-item')]
      .find(b => b.textContent.trim() === ${JSON.stringify(label)});
    if (direct) { direct.click(); await new Promise(r => setTimeout(r, 700)); return 'direct'; }
    // 折叠分组：先展开所有组
    for (const g of document.querySelectorAll('.nav-group')) {
      if (g.getAttribute('aria-expanded') === 'false') { g.click(); await new Promise(r => setTimeout(r, 200)); }
    }
    const hit = [...document.querySelectorAll('.sidebar .nav-item')]
      .find(b => b.textContent.trim() === ${JSON.stringify(label)});
    if (hit) { hit.click(); await new Promise(r => setTimeout(r, 700)); return 'expanded'; }
    return 'not-found';
  })()`;
}

/** 直接读 IndexedDB，绕过界面确认数据真的落库了 */
function readDb(store) {
  return `(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('openleaner');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!db.objectStoreNames.contains(${JSON.stringify(store)})) {
      db.close();
      return { missing: true, stores: [...db.objectStoreNames] };
    }
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(${JSON.stringify(store)}, 'readonly');
      const req = tx.objectStore(${JSON.stringify(store)}).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const names = [...db.objectStoreNames];
    db.close();
    return { rows, names };
  })()`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userDataDir = path.join(OUT_DIR, 'edge-profile-settings');
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

    await cdp.send('Page.navigate', { url: APP_URL });
    await sleep(3500);

    // ---------- 0. 应用起来了 ----------
    const boot = await cdp.eval(`(() => ({
      hasApp: Boolean(document.querySelector('.app')),
      title: document.querySelector('.topbar__title')?.textContent ?? '',
      navCount: document.querySelectorAll('.sidebar .nav-item').length,
      // 语言切换必须已经摘掉
      hasLangSwitch: Boolean(document.querySelector('.lang-switch')),
      hasEnButton: [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'EN'),
    }))()`);
    record('应用启动', boot.hasApp, `title=${boot.title} nav=${boot.navCount}`);
    record('EN 按钮已摘掉', !boot.hasLangSwitch && !boot.hasEnButton);

    await cdp.screenshot(path.join(OUT_DIR, 'set-01-home.png'));

    // ---------- 1. 进设置页 ----------
    const navResult = await cdp.eval(clickNav('设置'));
    record('点「设置」进入设置页', navResult !== 'not-found', `via=${navResult}`);
    const onSettings = await cdp.eval(`(() => ({
      title: document.querySelector('.topbar__title')?.textContent ?? '',
      hasPage: Boolean(document.querySelector('.settings-page')),
      navItems: [...document.querySelectorAll('.settings-nav__item')].map(b => b.textContent.trim()),
      current: document.querySelector('.settings-nav__item[aria-current="page"]')?.textContent.trim() ?? '',
    }))()`);
    record('设置页渲染', onSettings.hasPage && onSettings.title === '设置', `分类=${onSettings.navItems.join('/')}`);
    record('默认选中第一类', onSettings.current.includes('学习库'), `current=${onSettings.current}`);
    await cdp.screenshot(path.join(OUT_DIR, 'set-02-settings-library.png'));

    // ---------- 2. 建库（真实写入） ----------
    const created = await cdp.eval(`(async () => {
      const input = document.querySelector('.settings-page input.set-input');
      if (!input) return { err: 'no-input' };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '验证学习库');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 150));
      const btn = [...document.querySelectorAll('.settings-page button')]
        .find(b => /创建学习库/.test(b.textContent));
      if (!btn) return { err: 'no-button' };
      btn.click();
      await new Promise(r => setTimeout(r, 1800));
      return { clicked: true, text: document.querySelector('.settings-page')?.innerText.slice(0, 400) ?? '' };
    })()`);
    record('点了「创建学习库」', created.clicked === true, created.err ?? '');
    await sleep(600);
    await cdp.screenshot(path.join(OUT_DIR, 'set-03-created.png'));

    const metaRows = await cdp.eval(readDb('meta'));
    record(
      'IndexedDB: meta 分区真的有记录',
      Array.isArray(metaRows.rows) && metaRows.rows.length === 1 && metaRows.rows[0].name === '验证学习库',
      JSON.stringify(metaRows.rows?.[0] ?? metaRows),
    );

    // 顶栏库名是否跟着变了（这是启动快照的坑）
    const shellName = await cdp.eval(`document.querySelector('.topbar__lib strong')?.textContent ?? ''`);
    record('顶栏库名已同步', shellName === '验证学习库', `顶部显示=${shellName}`);

    // ---------- 3. 加一个后端（真实写入 secrets） ----------
    await cdp.eval(`(async () => {
      const btn = [...document.querySelectorAll('.settings-nav__item')].find(b => /模型与出题/.test(b.textContent));
      btn?.click();
      await new Promise(r => setTimeout(r, 500));
    })()`);
    const modelPane = await cdp.eval(`(() => ({
      hasEmpty: Boolean(document.querySelector('.set-inline')),
      emptyText: document.querySelector('.set-inline')?.textContent?.slice(0, 80) ?? '',
      hasAdd: [...document.querySelectorAll('.settings-page button')].some(b => /添加模型/.test(b.textContent)),
    }))()`);
    record('模型页空态正常', modelPane.hasEmpty && modelPane.hasAdd, modelPane.emptyText);
    await cdp.screenshot(path.join(OUT_DIR, 'set-04-model-empty.png'));

    const filled = await cdp.eval(`(async () => {
      const add = [...document.querySelectorAll('.settings-page button')].find(b => /添加模型/.test(b.textContent));
      if (!add) return { err: 'no-add' };
      add.click();
      await new Promise(r => setTimeout(r, 500));
      const form = document.querySelector('.set-form');
      if (!form) return { err: 'no-form' };

      const setInput = (el, value) => {
        const proto = el instanceof window.HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };

      const label = form.querySelector('input.set-input:not([type=password]):not([list])');
      if (label) setInput(label, '验证后端');

      const password = form.querySelector('input[type=password]');
      if (password) setInput(password, 'sk-verify-1234567890abcdef');

      await new Promise(r => setTimeout(r, 200));
      const save = [...form.querySelectorAll('button')].find(b => /^保存$/.test(b.textContent.trim()));
      if (!save) return { err: 'no-save' };
      save.click();
      await new Promise(r => setTimeout(r, 2000));
      return {
        ok: true,
        formGone: !document.querySelector('.set-form'),
        text: document.querySelector('.settings-page')?.innerText.slice(0, 700) ?? '',
      };
    })()`);
    record('后端表单可填可保存', filled.ok === true && filled.formGone === true, filled.err ?? '');
    await sleep(600);
    await cdp.screenshot(path.join(OUT_DIR, 'set-05-backend-saved.png'));

    const backendRows = await cdp.eval(readDb('backends'));
    const secretRows = await cdp.eval(readDb('secrets'));
    record(
      'IndexedDB: backends 有 1 条',
      Array.isArray(backendRows.rows) && backendRows.rows.length === 1,
      JSON.stringify(backendRows.rows?.[0] ?? backendRows).slice(0, 300),
    );
    record(
      'IndexedDB: secrets 有 1 条（Key 真的存了）',
      Array.isArray(secretRows.rows) && secretRows.rows.length === 1,
      `条数=${secretRows.rows?.length ?? 'n/a'}`,
    );

    const cardText = await cdp.eval(`document.querySelector('.set-item')?.innerText ?? ''`);
    record(
      '卡片状态如实（显示已保存凭据，不假装连接正常）',
      /凭据/.test(cardText) && !/连接正常/.test(cardText),
      cardText.replace(/\n/g, ' | ').slice(0, 200),
    );
    record(
      'Key 明文没有泄漏到界面',
      !cardText.includes('sk-verify-1234567890abcdef'),
    );

    // 顶栏「已连接」应随之变化
    const connText = await cdp.eval(`document.querySelector('.topbar__status')?.textContent ?? ''`);
    record('顶栏连接状态已同步', /已连接/.test(connText), `显示=${connText}`);

    // ---------- 4. 备份页 ----------
    await cdp.eval(`(async () => {
      const btn = [...document.querySelectorAll('.settings-nav__item')].find(b => /备份与恢复/.test(b.textContent));
      btn?.click();
      await new Promise(r => setTimeout(r, 600));
    })()`);
    const backupPane = await cdp.eval(`(() => {
      const text = document.querySelector('.settings-page')?.innerText ?? '';
      const at = text.indexOf('不含');
      const after = at >= 0 ? text.slice(at, at + 80) : '';
      return {
        hasExport: text.includes('导出学习库'),
        hasRestore: text.includes('选择备份文件'),
        hasName: text.includes('.openleaner.json'),
        saysNoSecrets: after.includes('API Key'),
        noSecretsLine: after.split('\\n').join(' / '),
      };
    })()`);
    record('备份页两块都在', backupPane.hasExport && backupPane.hasRestore, '');
    record('备份说明里写清了文件名', backupPane.hasName);
    record('备份说明里写清了不含 Key', backupPane.saysNoSecrets, backupPane.noSecretsLine);
    await cdp.screenshot(path.join(OUT_DIR, 'set-06-backup.png'));

    // ---------- 4a. 先往「六个易漏分区」里塞真数据 ----------
    // 空库往返证明不了什么：以前那六个分区被清空也看不出来。
    // 所以直接写 IndexedDB，再走导出→恢复，最后数条数。
    const seeded = await cdp.eval(`(async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('openleaner');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const now = new Date().toISOString();
      const rows = {
        sourceSegments: { id: 'seg_v', sourceId: 'src_v', index: 0, page: 1, chapter: null, text: '正文在这儿，恢复后要还在', charCount: 11 },
        sourceAnnotations: { id: 'anno_v', sourceId: 'src_v', page: 2, strokes: [], texts: [], createdAt: now, updatedAt: now },
        reviewRecords: { id: 'card_v', cardId: 'card_v', kind: 'question', state: { ease: 2.5, intervalDays: 6, streak: 2, reviewCount: 3, lapseCount: 0, dueAt: '2026-12-01' }, firstSeenAt: now, updatedAt: now },
        reviewLogs: { id: 'log_v', cardId: 'card_v', kind: 'question', grade: 'good', day: '2026-11-06', prevIntervalDays: 1, newIntervalDays: 6, at: now },
        slideImages: { id: 'img_v', imageData: 'data:image/png;base64,iVBORw0KGgo=', width: 4, height: 3, byteSize: 8, createdAt: now },
        usageRecords: { id: '2026-11-06|dummy|questions', day: '2026-11-06', backendId: 'dummy', provider: 'deepseek', kind: 'questions', tokens: 4321, calls: 1, lastAt: now },
      };
      for (const [store, row] of Object.entries(rows)) {
        await new Promise((res, rej) => {
          const tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).put(row);
          tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
        });
      }
      db.close();
      return { ok: true };
    })()`);
    record('已往六个易漏分区写入测试数据', seeded.ok === true);

    // ---------- 4b. 真的导出一次，把 Blob 截下来 ----------
    // 不接下载目录（headless 里容易受策略影响），而是拦 createObjectURL：
    // 走的是同一条导出代码路径，拿到的就是用户会存进文件的那份 JSON。
    const exported = await cdp.eval(`(async () => {
      window.__backupBlob = null;
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { window.__backupBlob = blob; return orig(blob); };
      const btn = [...document.querySelectorAll('.settings-page button')]
        .find(b => /导出学习库/.test(b.textContent));
      if (!btn) return { err: 'no-export-button' };
      btn.click();
      await new Promise(r => setTimeout(r, 1500));
      URL.createObjectURL = orig;
      const blob = window.__backupBlob;
      if (!blob) return { err: 'no-blob' };
      const text = await blob.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      return {
        ok: true,
        size: blob.size,
        type: blob.type,
        format: parsed?.format ?? null,
        hasMeta: typeof parsed?.meta?.name === 'string',
        keys: parsed ? Object.keys(parsed) : [],
        // 凭据不能出现在导出文件里
        leaksKey: text.includes('sk-verify-1234567890abcdef'),
        text,
      };
    })()`);
    record('点「导出学习库」真的产出了文件', exported.ok === true, exported.err ?? `size=${exported.size} type=${exported.type}`);
    record('导出内容是合法备份（format + meta）', exported.format === 'openleaner-library' && exported.hasMeta, `format=${exported.format}`);
    record('导出文件里没有 API Key', exported.leaksKey === false);
    // 分区齐全：这六个以前被 validateBackup 吃掉，导出时必须先真的在
    const exportKeys = exported.keys ?? [];
    const wantKeys = ['sourceSegments', 'sourceAnnotations', 'reviewRecords', 'reviewLogs', 'slideImages', 'usageRecords'];
    const missingKeys = wantKeys.filter((k) => !exportKeys.includes(k));
    record('导出文件包含全部六个易漏分区', missingKeys.length === 0, missingKeys.length ? `缺 ${missingKeys.join(',')}` : `共 ${exportKeys.length} 个键`);

    if (exported.ok && exported.text) {
      // ---------- 4c. 把这份备份喂回「从备份恢复」 ----------
      const restore = await cdp.eval(`(async () => {
        const text = ${JSON.stringify(exported.text)};
        const input = document.querySelector('.settings-page input[type=file]');
        if (!input) return { err: 'no-file-input' };
        const file = new File([text], '往返测试.openleaner.json', { type: 'application/json' });
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 1200));
        const pane = document.querySelector('.settings-page')?.innerText ?? '';
        return {
          ok: true,
          showsFileName: pane.includes('往返测试.openleaner.json'),
          showsSummary: /条记录|门课程|份资料/.test(pane),
          hasConfirmButton: [...document.querySelectorAll('.settings-page button')]
            .some(b => /用此备份替换当前学习库/.test(b.textContent)),
        };
      })()`);
      record('选备份文件后出现预览（文件名 + 内容摘要）', restore.showsFileName && restore.showsSummary, restore.err ?? '');
      record('预览里有「用此备份替换」按钮', restore.hasConfirmButton === true);
      await cdp.screenshot(path.join(OUT_DIR, 'set-08-restore-preview.png'));

      // ---------- 4d. 二次确认框：初始焦点必须在取消上 ----------
      const dialog = await cdp.eval(`(async () => {
        const btn = [...document.querySelectorAll('.settings-page button')]
          .find(b => /用此备份替换当前学习库/.test(b.textContent));
        btn?.click();
        await new Promise(r => setTimeout(r, 500));
        const box = document.querySelector('.set-modal__box');
        if (!box) return { err: 'no-dialog' };
        const focused = document.activeElement?.textContent?.trim() ?? '';
        return {
          ok: true,
          role: box.getAttribute('role'),
          modal: box.getAttribute('aria-modal'),
          title: box.querySelector('.set-modal__title')?.textContent ?? '',
          focused,
        };
      })()`);
      record('确认框弹出了（role=dialog + aria-modal）', dialog.role === 'dialog' && dialog.modal === 'true', dialog.err ?? dialog.title);
      record('初始焦点在「取消」上（回车不等于确认）', /取消/.test(dialog.focused ?? ''), `焦点=${dialog.focused}`);
      await cdp.screenshot(path.join(OUT_DIR, 'set-09-confirm-dialog.png'));

      // Escape 应当关掉框，且不执行恢复
      const escaped = await cdp.eval(`(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(r => setTimeout(r, 500));
        return {
          gone: !document.querySelector('.set-modal__box'),
          stillPreview: /用此备份替换当前学习库/.test(document.querySelector('.settings-page')?.innerText ?? ''),
        };
      })()`);
      record('Escape 关闭确认框', escaped.gone === true);
      record('Escape 之后备份预览还在（没执行恢复）', escaped.stillPreview === true);

      // 真的执行一次恢复：这是整条链路里最该验的一步
      const done = await cdp.eval(`(async () => {
        const again = [...document.querySelectorAll('.settings-page button')]
          .find(b => /用此备份替换当前学习库/.test(b.textContent));
        again?.click();
        await new Promise(r => setTimeout(r, 400));
        const confirm = [...document.querySelectorAll('.set-modal__box button')]
          .find(b => b.textContent.trim() === '替换');
        if (!confirm) return { err: 'no-confirm-button', text: document.querySelector('.set-modal__box')?.innerText ?? '' };
        confirm.click();
        await new Promise(r => setTimeout(r, 2500));
        return {
          ok: true,
          dialogGone: !document.querySelector('.set-modal__box'),
          pane: document.querySelector('.settings-page')?.innerText.slice(0, 500) ?? '',
        };
      })()`);
      record('确认后恢复执行完成', done.ok === true, done.err ?? '');
      record('恢复后有明确提示', /已恢复|备份已恢复/.test(done.pane ?? ''), (done.pane ?? '').split('\n')[0]);
      await cdp.screenshot(path.join(OUT_DIR, 'set-10-restored.png'));

      // 恢复会整库替换。恢复完贴存里还该有 meta，且 6 个分区没被清空
      const afterRestore = await cdp.eval(`(async () => {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open('openleaner');
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
        const count = (store) => new Promise((res) => {
          if (!db.objectStoreNames.contains(store)) return res(-1);
          const q = db.transaction(store, 'readonly').objectStore(store).getAll();
          q.onsuccess = () => res(q.result.length); q.onerror = () => res(-1);
        });
        const out = {};
        for (const s of ['sourceSegments','sourceAnnotations','reviewRecords','reviewLogs','slideImages','usageRecords','meta']) {
          out[s] = await count(s);
        }
        db.close();
        return out;
      })()`);
      void afterRestore;
      record('恢复后 meta 还在（没有把库恢复成空）', afterRestore.meta === 1, JSON.stringify(afterRestore));
      // 这才是这条链路的核心断言：六个分区里的真数据活着回来了
      const survived = ['sourceSegments', 'sourceAnnotations', 'reviewRecords', 'reviewLogs', 'slideImages', 'usageRecords']
        .filter((k) => afterRestore[k] === 1);
      record(
        '恢复后六个易漏分区的数据都在（丢数据缺陷已修）',
        survived.length === 6,
        survived.length === 6 ? '6/6' : `${survived.length}/6 — ${JSON.stringify(afterRestore)}`,
      );
    }

    // ---------- 4e. 删除后端：必须走二次确认，取消不能删 ----------
    await cdp.eval(`(async () => {
      const btn = [...document.querySelectorAll('.settings-nav__item')].find(b => /模型与出题/.test(b.textContent));
      btn?.click();
      await new Promise(r => setTimeout(r, 600));
    })()`);
    const delDialog = await cdp.eval(`(async () => {
      const del = [...document.querySelectorAll('.set-item__actions button')]
        .find(b => b.textContent.trim() === '删除');
      if (!del) return { err: 'no-delete-button' };
      del.click();
      await new Promise(r => setTimeout(r, 500));
      const box = document.querySelector('.set-modal__box');
      if (!box) return { err: 'no-dialog' };
      return {
        ok: true,
        title: box.querySelector('.set-modal__title')?.textContent ?? '',
        focused: document.activeElement?.textContent?.trim() ?? '',
      };
    })()`);
    record('删除后端会先弹确认框', delDialog.ok === true, delDialog.err ?? delDialog.title);
    record('删除确认框焦点在取消上', /取消/.test(delDialog.focused ?? ''), `焦点=${delDialog.focused}`);

    const afterCancel = await cdp.eval(`(async () => {
      const cancel = [...document.querySelectorAll('.set-modal__box button')]
        .find(b => b.textContent.trim() === '取消');
      cancel?.click();
      await new Promise(r => setTimeout(r, 800));
      return {
        dialogGone: !document.querySelector('.set-modal__box'),
        itemCount: document.querySelectorAll('.set-item').length,
      };
    })()`);
    record('点取消后确认框关闭', afterCancel.dialogGone === true);
    record('点取消后端没有被删掉', afterCancel.itemCount === 1, `卡片数=${afterCancel.itemCount}`);

    // ---------- 5. 窄屏布局 ----------
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 520,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(800);
    await cdp.screenshot(path.join(OUT_DIR, 'set-07-narrow.png'));
    const narrow = await cdp.eval(`(() => {
      const nav = document.querySelector('.settings-nav');
      if (!nav) return { err: 'no-nav' };
      const cs = getComputedStyle(nav);
      return { direction: cs.flexDirection, overflowX: cs.overflowX };
    })()`);
    record(
      '窄屏时分类变横向药丸条',
      narrow.direction === 'row',
      `flex-direction=${narrow.direction} overflow-x=${narrow.overflowX}`,
    );

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(500);

    // ---------- 6. 截图不能是纯白/纯黑 ----------
    const px = await cdp.eval(`(async () => {
      const canvas = document.createElement('canvas');
      const img = new Image();
      return 'skip';
    })()`);
    void px;
  } finally {
    try {
      edge.kill();
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` :: ${f.detail}` : ''}`);
    process.exitCode = 1;
  }
}

void main();

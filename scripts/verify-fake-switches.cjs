/**
 * 验证 2026-11-19 修的两个假开关 + 一条文案（**隔离副本**，不碰真实库）。
 *
 * 判据全部落在「用户真实操作路径」的产物上：
 *  - ① 逐选项解析：到做题页真的选错 → 断言页面上出现该选项 why 的**原文**。
 *    修复前 why 在解析阶段就被丢了，这段文字不可能出现。
 *  - ② 认知层级筛选：勾 apply 层出题 → 断言**真正发给模型的请求体**里
 *    只含 apply 层知识点的 id。修复前 service 不筛素材，请求体会含全部四层。
 *  - ③ 导览文案：不再出现「对着章节清单自检」。
 *
 * 用本地假模型服务器（loopback http，`checkProxyTarget` 允许），
 * 走的是与真实模型完全相同的代码路径（界面 → service → 主进程代理 → HTTP），
 * 只是不花钱、结果确定。
 *
 * 隔离（硬约束 12）：app 目录旁不能有 openleaner-data；--user-data-dir 指副本；
 * 跑完检查没长出来。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { createFakeModel } = require('./fake-model-server.cjs');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, '.tmp/cloud-fullonly-app/electron.exe');
const APPDATA = path.resolve(ROOT, '.tmp/verify-fakeswitch-appdata');
const DATA = path.join(APPDATA, 'OpenLeaner');
const SHOTS = path.join(ROOT, '.verify-shots/fakeswitch');
const PORT = Number(process.argv[2] || 9824);
const MODEL_PORT = Number(process.argv[3] || 9911);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const rec = (n, ok, x = '') => {
  console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' :: ' + x : ''}`);
  ok ? pass++ : fail++;
};

/* 种子数据：四个层级各一条，id 可预测，便于断言 */
const KP = {
  remember: 'kp_remember',
  understand: 'kp_understand',
  apply: 'kp_apply',
  analyze: 'kp_analyze',
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });

  const stray = path.join(ROOT, '.tmp/cloud-fullonly-app/openleaner-data');
  if (fs.existsSync(stray)) fs.rmSync(stray, { recursive: true, force: true });

  const fake = createFakeModel();
  await fake.listen(MODEL_PORT);
  console.log(`  假模型服务器 127.0.0.1:${MODEL_PORT}`);

  const app = spawn(
    EXE,
    [
      ROOT,
      `--user-data-dir=${DATA}`,
      '--no-sandbox',
      `--remote-debugging-port=${PORT}`,
      '--window-size=1440,1000',
    ],
    { cwd: ROOT, env: { ...process.env, APPDATA }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  app.stdout.on('data', (d) => (log += d.toString()));
  app.stderr.on('data', (d) => (log += d.toString()));

  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 240; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = l.find((t) => t.type === 'page' && String(t.url).indexOf('file://') === 0);
        if (target) break;
      } catch {}
      await sleep(250);
    }
    if (!target) {
      console.error('起不来:' + log.slice(-3000));
      process.exit(2);
    }
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
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = id++;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
        setTimeout(() => {
          if (pending.has(n)) {
            pending.delete(n);
            reject(new Error('timeout ' + method));
          }
        }, 120000);
      });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails)
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const shot = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
    };
    const clickText = async (sel, text) =>
      evalJs(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(sel)})]
        .find(e=>e.textContent.trim().includes(${JSON.stringify(text)}));
        if(el){el.click();return true}return false})()`);

    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(5000);

    /* ================= 0. 隔离生效确认 ================= */
    rec('运行在 Electron 壳里', (await evalJs(`typeof window.openleaner !== 'undefined'`)) === true);

    /* ================= 种子：知识点 + 资料 + 后端配置 ================= */
    const seeded = await evalJs(`(async()=>{
      const DB_NAME='openleaner';
      const db = await new Promise((res,rej)=>{const r=indexedDB.open(DB_NAME);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
      const ts = new Date().toISOString();
      const putAll = (store, rows) => new Promise((res,rej)=>{
        const tx=db.transaction(store,'readwrite'); const st=tx.objectStore(store);
        rows.forEach(r=>st.put(r));
        tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error);
      });
      const mk = (id, statement, level, page) => ({
        id, statement, chapter:'第一章 测试', cognitiveLevel:level, tags:[],
        anchors:[{sourceId:'src_fake', page, charStart:0, charEnd:20, segmentId:'seg_fake_'+page}],
        quotes:['原文引文：'+statement],
        anchorStatus:'located', origin:'material', sourceId:'src_fake', backendId:'fake', createdAt:ts, updatedAt:ts,
      });
      /* 清掉上一轮种子与产物，保证幂等（这是隔离库，清空安全） */
      for (const st of ['decks','questions','generationRuns','answerRecords','reviewRecords','reviewLogs']) {
        await new Promise((res)=>{const tx=db.transaction(st,'readwrite');tx.objectStore(st).clear();tx.oncomplete=res;tx.onerror=res});
      }
      await new Promise((res)=>{const tx=db.transaction('knowledgePoints','readwrite');tx.objectStore('knowledgePoints').clear();tx.oncomplete=res;tx.onerror=res});
      await putAll('knowledgePoints', [
        mk('${KP.remember}','记忆层：线性表的定义','remember',1),
        mk('${KP.understand}','理解层：顺序表为什么支持随机访问','understand',2),
        mk('${KP.apply}','应用层：给定插入位置写出移动元素次数','apply',3),
        mk('${KP.analyze}','分析层：顺序表与链表的复杂度取舍','analyze',4),
      ]);
      /* 资料（界面判断「有没有资料」用） */
      await new Promise((res)=>{const tx=db.transaction('sources','readwrite');tx.objectStore('sources').clear();tx.oncomplete=res;tx.onerror=res});
      await putAll('sources', [{
        id:'src_fake', title:'测试资料（隔离）', kind:'text', pageCount:4,
        textStatus:'ready', createdAt:ts, updatedAt:ts, segmentCount:4, readProgress:null,
      }]);
      /* 资料段落：让「从原文出题」也有内容 */
      await putAll('sourceSegments', [1,2,3,4].map(p=>({
        id:'seg_fake_'+p, sourceId:'src_fake', index:p, page:p, chapter:'第一章 测试',
        text:'这是第'+p+'页的测试正文，长度足够用来出题，包含线性表与顺序表的内容。', charCount:40,
      })));
      /* 后端配置指向本地假模型 */
      await new Promise((res)=>{const tx=db.transaction('backends','readwrite');tx.objectStore('backends').clear();tx.oncomplete=res;tx.onerror=res});
      await putAll('backends', [{
        id:'be_fake', label:'本地假模型（验证用）', kind:'direct-api', provider:'custom',
        baseUrl:'http://127.0.0.1:${MODEL_PORT}', model:'fake-model',
        capabilities:{ textOrganize:true, visionFormula:false },
        status:'ready', isDefault:true, createdAt:ts, updatedAt:ts,
      }]);
      /* 凭据 */
      await new Promise((res)=>{const tx=db.transaction('secrets','readwrite');tx.objectStore('secrets').clear();tx.oncomplete=res;tx.onerror=res});
      await putAll('secrets', [{ id:'sec_fake', backendId:'be_fake', value:'sk-fake-for-local-test', createdAt:ts, updatedAt:ts }]);
      db.close();
      return { ok:true };
    })()`);
    rec('隔离库里写入 4 层级知识点 / 资料 / 后端 / 凭据', !!(seeded && seeded.ok), '');

    await evalJs(`location.reload()`);
    await sleep(6000);

    /* ================= ③ 导览文案 ================= */
    await evalJs(`document.querySelectorAll('.nav-group').forEach(g=>g.classList.add('is-open'));true`);
    await sleep(300);
    const opened = await clickText('.nav-item__label,.nav-item', '功能导览');
    await sleep(1800);
    const guideText = await evalJs(`document.body.innerText`);
    rec('③ 能打开功能导览页', opened === true);
    rec('③ 旧文案「对着章节清单自检」已消失', !guideText.includes('对着章节清单自检'));
    rec(
      '③ 新文案在位（摊开全部知识点 / 哪些章节还没出题）',
      guideText.includes('按资料与章节摊开全部知识点') && guideText.includes('哪些章节还没出题'),
    );
    await shot('03-guide.png');

    console.log(`\n  —— 进入出题页 ——`);
    const openedDecks = await clickText('.nav-item__label,.nav-item', '我的题组');
    await sleep(2200);
    rec('能打开「我的题组」', openedDecks === true);
    await shot('02-decks.png');

    /* 点「新建题组」展开出题表单 */
    const openedForm = await clickText('button', '新建题组');
    await sleep(1500);
    rec('能展开「新建题组」表单', openedForm === true);
    await shot('02-form.png');

    /*
    /*
     * 选「从知识库出题」（知识库那一条比原文更聚焦，且层级来自知识点本身）。
     *
     * 下面几处的文案是**实测确认**来的，不是猜的：
     *  - 入口按钮：「知识库知识点…」
     *  - 提交按钮：「生成并检查题组」
     * 谁改动了这些文案，脚本会在这几条断言上失败 —— 那是它该做的事。
     */
    const pickedKnowledge = await evalJs(`(()=>{
      const el=[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('知识库知识点'));
      if(el){el.click();return true}return false
    })()`);
    await sleep(1200);
    rec('能选「知识库出题」', pickedKnowledge === true);

    /* 只勾「应用」层 —— 这正是修复前无效的那个开关 */
    const pickedLevel = await evalJs(`(()=>{
      const el=[...document.querySelectorAll('.quota__level')].find(e=>e.textContent.trim()==='应用');
      if(el){el.click();return el.getAttribute('aria-pressed')}return null
    })()`);
    await sleep(500);
    const levelState = await evalJs(`(()=>({
      pressed: [...document.querySelectorAll('.quota__level')].map(e=>({t:e.textContent.trim(),on:e.getAttribute('aria-pressed')})),
      note: document.querySelector('.quota__note')?.textContent?.trim() ?? null,
    }))()`);
    console.log('  层级状态 =', JSON.stringify(levelState));
    rec(
      '② 能勾上「应用」层（只勾这一层）',
      Array.isArray(levelState.pressed) &&
        levelState.pressed.filter((x) => x.on === 'true').length === 1 &&
        levelState.pressed.find((x) => x.on === 'true')?.t === '应用',
      JSON.stringify(levelState.pressed),
    );
    await shot('02-level-picked.png');

    /* 出题前清空请求记录，确保断言只针对这一次 */
    fake.requests.length = 0;

    /* 点「生成并检查题组」（文案实测确认） */
    const started = await evalJs(`(()=>{
      const cands=[...document.querySelectorAll('button')].filter(b=>!b.disabled);
      const el=cands.find(b=>/生成并检查题组/.test(b.textContent))
        || cands.find(b=>/^(开始出题|开始生成)$/.test(b.textContent.trim()));
      if(el){el.click();return el.textContent.trim()}return null
    })()`);
    console.log('  点击了 =', started);
    rec('② 找到了「生成并检查题组」按钮并点击', started !== null, String(started));
    /* 等假模型回话 + 落库 */
    await sleep(9000);
    await shot('02-generated.png');

    /* ================= ② 断言：发给模型的素材只剩 apply 层 ================= */
    const sentIds = fake.lastMaterialIds();
    console.log('  请求里出现的素材 id =', JSON.stringify(sentIds));
    console.log('  请求条数 =', fake.requests.length);

    rec('② 假模型确实收到了请求（整条链路通了）', fake.requests.length > 0, `count=${fake.requests.length}`);
    rec(
      '② 请求体里只出现 apply 层知识点的 id（修复前会含全部四层）',
      sentIds.length > 0 && sentIds.every((x) => x === KP.apply),
      `sent=${JSON.stringify(sentIds.slice(0, 8))} 期望全是 ${KP.apply}`,
    );
    rec(
      '② 请求体里没有混入 remember / understand / analyze 层',
      !sentIds.includes(KP.remember) &&
        !sentIds.includes(KP.understand) &&
        !sentIds.includes(KP.analyze),
    );

    /* 提示词里也不该出现别的层的素材说明文字 */
    const promptText = fake.lastUserPrompt();
    rec(
      '② 提示词里不含「记忆层 / 理解层 / 分析层」那几条知识点的表述',
      !promptText.includes('线性表的定义') &&
        !promptText.includes('顺序表为什么支持随机访问') &&
        !promptText.includes('顺序表与链表的复杂度取舍'),
      promptText.slice(0, 200).replace(/\n/g, ' ⏎ '),
    );

    /* 界面上应出现「已按认知层级筛选」的说明 */
    const doneText = await evalJs(`document.querySelector('.gen-done')?.innerText ?? ''`);
    console.log('  反馈条 =', JSON.stringify(doneText));
    rec(
      '② 反馈条写明「已按认知层级筛选」',
      /已按认知层级筛选/.test(doneText) && /应用/.test(doneText),
      doneText.slice(0, 200).replace(/\n/g, ' ⏎ '),
    );

    /* ================= 发布题组（做题页只取已发布的题） ================= */
    const published = await evalJs(`(async()=>{
      const DB_NAME='openleaner';
      const db = await new Promise((res,rej)=>{const r=indexedDB.open(DB_NAME);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
      const decks = await new Promise((res)=>{const tx=db.transaction('decks');const rq=tx.objectStore('decks').getAll();rq.onsuccess=()=>res(rq.result)});
      const draft = decks.filter(d=>d.status!=='published');
      for(const d of draft){
        d.status='published'; d.publishedAt=new Date().toISOString();
        await new Promise((res)=>{const tx=db.transaction('decks','readwrite');tx.objectStore('decks').put(d);tx.oncomplete=res;tx.onerror=res});
      }
      const qs = await new Promise((res)=>{const tx=db.transaction('questions');const rq=tx.objectStore('questions').getAll();rq.onsuccess=()=>res(rq.result)});
      db.close();
      return { decks: decks.length, published: draft.length, questions: qs.length, sampleOptions: qs[0]?.options ?? null };
    })()`);
    console.log('  发布结果 =', JSON.stringify(published).slice(0, 400));

    /* ================= ① 逐选项解析：真做错一题，看有没有 why ================= */
    /*
     * 修复前：`why` 在解析阶段就被丢掉了，`hasOptionWhys()` 恒 false，
     * 逐选项解析整块不渲染 —— 所以下面这几条断言对旧实现必然失败。
     */
    rec(
      '① 题目的选项里真的带着 why（落库层）',
      Array.isArray(published?.sampleOptions) &&
        published.sampleOptions.some((o) => typeof o.why === 'string' && o.why.length > 0),
      JSON.stringify(published?.sampleOptions?.[1] ?? null).slice(0, 160),
    );

    await evalJs(`location.reload()`);
    await sleep(6000);

    /*
     * 三级导航，实测确认（别照猜）：
     *   侧栏「开始学习」→ 页内「开始做题」→ 「自由练习」
     * 今日没有到期题时，「开始做题」页只给「自由练习 / 先练 N 道新卡」两条路。
     */
    await clickText('.nav-item__label,.nav-item', '开始学习');
    await sleep(1800);
    const toStudy = await evalJs(`(()=>{
      const el=[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('开始做题'));
      if(el){el.click();return el.textContent.trim().slice(0,40)}return null})()`);
    console.log('  点「开始做题」 =', toStudy);
    await sleep(2200);

    const toPractice = await evalJs(`(()=>{
      const cands=[...document.querySelectorAll('button')].filter(b=>!b.disabled);
      const el=cands.find(b=>/^自由练习$/.test(b.textContent.trim()))
        || cands.find(b=>/先练这\\s*\\d+\\s*道新卡/.test(b.textContent))
        || cands.find(b=>/^去自由练习$/.test(b.textContent.trim()));
      if(el){el.click();return el.textContent.trim()}return null})()`);
    console.log('  进入练习 =', toPractice);
    await sleep(2500);

    /* 第四层：挑一个题组 → 「做这组」（实测确认的文案） */
    const toDeck = await evalJs(`(()=>{
      const cands=[...document.querySelectorAll('button')].filter(b=>!b.disabled);
      const el=cands.find(b=>/^做这组$/.test(b.textContent.trim()))
        || cands.find(b=>/^全库随机/.test(b.textContent) || /随机来一批/.test(b.textContent));
      if(el){el.click();return el.textContent.trim()}return null})()`);
    console.log('  进题组 =', toDeck);
    await sleep(3500);
    await shot('01-review-before.png');

    /* 选一个错误选项（B），然后提交 */
    const picked = await evalJs(`(()=>{
      const opts=[...document.querySelectorAll('.option')];
      if(opts.length===0) return {err:'no .option', body:document.body.innerText.slice(0,300)};
      const wrong=opts.find(o=>o.textContent.includes('干扰项')) || opts[1] || opts[0];
      wrong.click();
      return { clicked: wrong.textContent.trim().slice(0,60), count: opts.length };
    })()`);
    console.log('  选择 =', JSON.stringify(picked));

    const submitted = await evalJs(`(()=>{
      const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().startsWith('提交答案'));
      if(b){b.click();return true}return false})()`);
    rec('① 能在做题页选选项并提交（真实操作路径）', submitted === true);
    await sleep(1500);
    await shot('01-review-after.png');

    /* 断言：页面上出现了「你的选择」与该选项的 why 原文 */
    const reveal = await evalJs(`(()=>({
      hasOptionsBlock: !!document.querySelector('.reveal__options'),
      optionRows: [...document.querySelectorAll('.reveal__option')].map(li=>li.innerText.replace(/\\n/g,' ⏎ ')),
      whys: [...document.querySelectorAll('.reveal__option-why')].map(p=>p.innerText),
      tags: [...document.querySelectorAll('.reveal__option-tag')].map(t=>t.innerText),
      bodyHasWhy: document.body.innerText.includes('把「有限」记成了「无限」'),
    }))()`);
    console.log('  解析块 =', JSON.stringify(reveal).slice(0, 800));

    rec('① 逐选项解析整块渲染出来了（.reveal__options 存在）', reveal.hasOptionsBlock === true);
    rec(
      '① 每个选项都带「为什么」(.reveal__option-why)',
      Array.isArray(reveal.whys) && reveal.whys.length >= 2,
      `count=${reveal.whys?.length ?? 0}`,
    );
    rec(
      '① 页面上出现干扰项的 why 原文（模型写的那句）',
      reveal.bodyHasWhy === true,
      reveal.whys?.join(' | ')?.slice(0, 200) ?? '',
    );
    rec(
      '① 标出了「你的选择」和「正确答案」',
      Array.isArray(reveal.tags) &&
        reveal.tags.includes('你的选择') &&
        reveal.tags.includes('正确答案'),
      JSON.stringify(reveal.tags),
    );

    console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
    if (fail > 0) process.exitCode = 1;
  } catch (e) {
    console.error('脚本异常：', e && e.message);
    console.error(log.slice(-2500));
    process.exitCode = 2;
  } finally {
    try {
      ws && ws.close();
    } catch {}
    app.kill();
    await fake.close();
    await sleep(1500);
    const strayAfter = path.join(ROOT, '.tmp/cloud-fullonly-app/openleaner-data');
    console.log(
      fs.existsSync(strayAfter)
        ? '⚠️ app 目录旁出现 openleaner-data —— 隔离可能失效！'
        : '✅ app 目录旁没有 openleaner-data（隔离生效）',
    );
  }
})();
/**
 * 桌面端模型代理的地址策略验收。
 *
 * 为什么单独一个脚本：这段逻辑决定的是「这个通道能不能被利用」。
 * 一个太松的代理 = 给渲染进程开了内网扫描器（能看到路由器管理页、
 * NAS、云厂商元数据 169.254.169.254 上的临时凭据）；
 * 一个太紧的代理 = 所有正常服务商都被挡在门外，桌面版等于没有多服务商接入。
 * 两种错法都很安静：太紧只表现为「连不上」，太松则完全没有症状。
 *
 * 为什么不用 vitest：被验的是 electron/main.cjs —— 跑在主进程里的
 * CommonJS 文件，不能 import 到渲染进程的测试环境。这里改为
 * **从源码里抽出函数原样执行**，而不是复制一份改过名字的代码 ——
 * 复制出来的副本测的是副本，线上改了它也不会红。
 *
 * 用法：node scripts/verify-electron-proxy.cjs
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'electron', 'main.cjs');
const src = fs.readFileSync(SRC, 'utf8');

/** 从源码里配平花括号抽出一个函数定义的完整文本 */
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`electron/main.cjs 里找不到 ${name}`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 的函数体没有闭合`);
}

const code = [
  extract('isLoopbackHost'),
  extract('isPrivateHost'),
  extract('checkProxyTarget'),
  'module.exports = { isLoopbackHost, isPrivateHost, checkProxyTarget };',
].join('\n');

const mod = { exports: {} };
new Function('module', 'exports', code)(mod, mod.exports);
const { isLoopbackHost, isPrivateHost, checkProxyTarget } = mod.exports;

let pass = 0;
let fail = 0;

function record(ok, name, detail) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${detail}`);
}

function check(name, actual, expected) {
  record(actual === expected, name, `实际 ${actual}，期望 ${expected}`);
}

/** 判定一个完整地址的最终结论 */
function checkTarget(name, url, expectedKind) {
  const result = checkProxyTarget(url);
  const actual = result.ok ? 'allow' : result.kind;
  record(
    actual === expectedKind,
    name,
    `实际 ${actual}${result.ok ? '' : `（${result.message}）`}，期望 ${expectedKind}`,
  );
}

console.log('=== 判据一：回环地址（本地模型服务常只跑 http） ===');
check('localhost', isLoopbackHost('localhost'), true);
check('127.0.0.1', isLoopbackHost('127.0.0.1'), true);
check('127.5.5.5（整个 127/8）', isLoopbackHost('127.5.5.5'), true);
check('::1', isLoopbackHost('::1'), true);
check('公网域名不是回环', isLoopbackHost('api.deepseek.com'), false);

console.log('\n=== 判据二：内网地址必须拒绝（否则成了内网扫描器） ===');
check('10.0.0.1', isPrivateHost('10.0.0.1'), true);
check('192.168.1.1', isPrivateHost('192.168.1.1'), true);
check('172.16.0.1', isPrivateHost('172.16.0.1'), true);
check('172.31.255.255（私有段上界）', isPrivateHost('172.31.255.255'), true);
check('云厂商元数据 169.254.169.254', isPrivateHost('169.254.169.254'), true);
check('IPv6 唯一本地 fc00::', isPrivateHost('fc00::1'), true);
check('IPv6 链路本地 fe80::', isPrivateHost('fe80::1'), true);
check('172.32.0.1 不在私有段内', isPrivateHost('172.32.0.1'), false);
check('8.8.8.8', isPrivateHost('8.8.8.8'), false);

/**
 * 下面这一组才是真正守住边界的。
 *
 * 前面两组只测「判据」，但把判据组合起来的逻辑出错时，单测判据是
 * 发现不了的 —— 这一点已实测踩过：把 isLoopbackHost(...) 改成
 * `|| true` 之后，只有前面两组的版本仍然 ALL PASS。
 */
console.log('\n=== 完整地址判定：该放行的必须放行 ===');
checkTarget('DeepSeek', 'https://api.deepseek.com/chat/completions', 'allow');
checkTarget(
  '智谱（路径带前缀）',
  'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  'allow',
);
checkTarget(
  '通义 compatible-mode',
  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  'allow',
);
checkTarget('中转站自定义域名', 'https://my-relay.example.com/v1/chat/completions', 'allow');
checkTarget('本地 Ollama（http + 回环）', 'http://127.0.0.1:11434/v1/chat/completions', 'allow');
checkTarget('本地 LM Studio（localhost）', 'http://localhost:1234/v1/chat/completions', 'allow');

console.log('\n=== 完整地址判定：该拒绝的必须拒绝 ===');
checkTarget('外部 http（明文传 Key）', 'http://api.deepseek.com/chat/completions', 'invalid-url');
checkTarget('内网 192.168', 'https://192.168.1.1/chat/completions', 'forbidden-host');
checkTarget('云厂商元数据 169.254', 'https://169.254.169.254/chat/completions', 'forbidden-host');
checkTarget('file: 协议', 'file:///E:/secret/chat/completions', 'invalid-url');
checkTarget('不是 /chat/completions 的路径', 'https://api.deepseek.com/v1/models', 'invalid-path');
checkTarget('根本不是一个 URL', 'api.deepseek.com', 'invalid-url');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAILURE'}  通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);

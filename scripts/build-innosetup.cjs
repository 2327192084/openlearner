/**
 * 用 Inno Setup 编 OpenLeaner 安装包（2026-11-24，v4.0 起替换 NSIS）。
 *
 * ## 背景
 *
 * 旧的安装包用 build/installer.nsi + makensis 直接编（不用 electron-builder 的
 * nsis 目标，原因见 nsi 文件头注释）。2026-11-24 用户决定换成 Inno Setup：
 * 单次编译、卸载器自动生成、脚本更短。NSIS 脚本保留在 build/installer.nsi
 * 作为回退，不再被任何流程调用。
 *
 * ## 行为对齐清单（换打包器不能换行为）
 *
 * - 装到 %LOCALAPPDATA%\Programs\OpenLeaner（不弹 UAC）
 * - 只写 HKCU
 * - 卸载不删 %APPDATA%\OpenLeaner（学习库）
 * - 桌面 + 开始菜单快捷方式
 * - 「应用和功能」能算大小、能卸载
 *
 * ## 用法
 *
 *   node scripts/build-innosetup.cjs            # 用 release/win-unpacked 打 4.0.0
 *   node scripts/build-innosetup.cjs --version 4.0.0 --dir release/win-unpacked
 *
 * ISCC.exe 的查找顺序：PATH → %LOCALAPPDATA%\Programs\Inno Setup 6 →
 * C:\Program Files (x86)\Inno Setup 6。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ISS = path.join(ROOT, 'build', 'installer.iss');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function findIscc() {
  const candidates = [
    process.env.ISCC,
    'ISCC.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try { execFileSync('where', [c], { stdio: 'pipe' }); } catch { /* where 只对裸命令有用 */ }
    if (c.endsWith('.exe') && fs.existsSync(c)) return c;
    try { execFileSync(c, ['/?'], { stdio: 'pipe' }); return c; } catch { /* 不在 PATH */ }
  }
  console.error('找不到 ISCC.exe。装 Inno Setup 6：winget install JRSoftware.InnoSetup');
  process.exit(2);
}

const version = arg('version', JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
const sourceDir = path.resolve(ROOT, arg('dir', 'release/win-unpacked'));

/*
 * 打包前先对一遍版本号（2026-11-26）。
 *
 * 版本号散在 package.json / installer.iss / README 三处，全靠人手同步；
 * 0.40 那次就漏了 —— tag 打在改版本号之前的提交上。
 * 显式传 --version（本地试编）时跳过：那种场景本来就不打算让三处对齐。
 */
if (!process.argv.includes('--version')) {
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'check-version.cjs'), version], {
      stdio: 'inherit',
    });
  } catch {
    console.error('版本号不一致，先统一再打包（node scripts/check-version.cjs）');
    process.exit(2);
  }
}

if (!fs.existsSync(path.join(sourceDir, 'OpenLeaner.exe'))) {
  console.error(`win-unpacked 不存在或没有 OpenLeaner.exe：${sourceDir}`);
  console.error('先跑：TMP=E:\\openleaner\\.tmp\\buildtmp TEMP=E:\\openleaner\\.tmp\\buildtmp npm run electron:pack');
  process.exit(2);
}

const iscc = findIscc();
console.log(`ISCC: ${iscc}`);
console.log(`版本: ${version}  源: ${sourceDir}`);

execFileSync(iscc, [
  `/DVERSION=${version}`,
  `/DSOURCE_DIR=${sourceDir}`,
  `/O${path.join(ROOT, 'build')}`,
  ISS,
], { stdio: 'inherit' });

const out = path.join(ROOT, 'build', `OpenLeaner-${version}-setup.exe`);
if (!fs.existsSync(out)) {
  console.error(`编译完成但找不到产物：${out}`);
  process.exit(2);
}
console.log(`产物: ${out} (${fs.statSync(out).size} B)`);

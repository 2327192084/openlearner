# 版本号规则（VERSIONING）

> 这份文件回答三个问题：当前是哪个版本、下一个版本该叫什么、发版要改哪几处。
> 2026-11-26 整理 —— 之前版本号散着放，出过一次「tag 上的版本 ≠ 代码里的版本」。

## 当前版本

**0.40.1**（2026-11-26）

现在走在 **0.40 线**上。这是个完整的版本号三段 `MAJOR.MINOR.PATCH`：

| 段 | 什么时候加 | 例子 |
|---|---|---|
| PATCH | 修 bug、小改动、文案 | 0.40.1 → 0.40.2 |
| MINOR | 成组的新功能（用户能感知） | 0.40.2 → 0.41.0 |
| MAJOR | 学习库/导出格式不兼容，需要迁移 | 0.41.x → 1.0.0 |

`0.40` 不是 `0.4` 的笔误，也不是「0 点 4」—— 它就是 `0.40.0`，和 `0.40.1` 同一条线。

## 命名规范（四处必须同一个值）

| 位置 | 形式 | 谁在读它 |
|---|---|---|
| `package.json` 的 `version` | `0.40.1` | electron-builder → exe 资源版本 + 默认产物名 |
| `build/installer.iss` 的 `#define VERSION` | `0.40.1` | 安装包显示的版本 |
| `README.md` 首屏「当前版本」 | `0.40.1` | 用户第一眼看到的 |
| GitHub Release 的 tag | `v0.40.1`（**带 v，三段齐全**） | 下载链接 `/releases/download/v0.40.1/…` |

产物文件名也由版本号决定：`build/OpenLeaner-<版本>-setup.exe`。
exe 与安装包**不要手工改名** —— 名字里带版本号，是为了让桌面/下载目录里几个包不会拿错。

> 一致性由 `node scripts/check-version.cjs` 检查（三处不一致直接 exit 1），
> `scripts/build-innosetup.cjs` 在打包前会自动调用它 —— 版本没对齐的包打不出来。

## 发版清单

1. 改版本号：`package.json` + `build/installer.iss`（两处 `#define VERSION` 与注释里的示例）
2. 跑 `node scripts/check-version.cjs`，确认三处一致
3. 提交并推送 —— **tag 必须在「版本号那个提交」之后打**（顺序反了就是 0.40 那次的事故）
4. 打包：`TEMP/TMP` 指到 `.tmp/buildtmp` 再 `npm run electron:pack`（本机 esbuild 删临时文件会被拒），然后 `node scripts/build-innosetup.cjs`
5. 验：`release/win-unpacked` 的 CDP 复核 + exe `VersionInfo.FileVersion` 应等于新版本
6. 建 Release：tag `vX.Y.Z`（三段齐全），标题 `Open Learner X.Y.Z`，资产传 `OpenLeaner-X.Y.Z-setup.exe`
7. 回填 README 首屏的下载链接（指向新 tag），再跑一次 `check-version.cjs`
8. 桌面留一份安装包给用户

## 历史（含已修掉的坑）

| Release | tag 指向 | 该提交里的 `version` | 资产 |
|---|---|---|---|
| v0.1.0 | 24dd8f3 | 0.1.0 | OpenLeaner-0.1.0-setup.exe（NSIS） |
| v0.2.0 | ee771c2 | 0.2.0 | OpenLeaner-0.2.0-setup.exe |
| v0.3.0 | 07b4f49 | 0.3.0 | OpenLeaner-0.3.0-setup.exe |
| v0.3.1 | ecf7ea4 | 0.3.1 | OpenLeaner-0.3.1-setup.exe |
| v0.40.0 | f002e97 | 0.40.0 | OpenLeaner-0.40.0-setup.exe（Inno Setup） |
| v0.40.1 | 5999340 | 0.40.1 | OpenLeaner-0.40.1-setup.exe |

**0.3.1 → 0.40.0 这段是怎么来的**：2026-11-24 先定的是 `4.0.0`（打包从 NSIS 换成 Inno Setup，
当成一个大版本），当天用户改口「发布版本应该是 0.40」，于是 `4.0.0 → 0.40.0`。
换号本身没问题，问题在**顺序**：`v0.40` 这个 tag 打在了 `a8dbb2b`（安装器崩溃修复），
而版本号是下一个提交 `f002e97` 才改的 —— 于是 `git show v0.40:package.json` 显示 `4.0.0`，
资产却叫 `OpenLeaner-0.40.0-setup.exe`。2026-11-26 已把 tag 改名 `v0.40.0` 并挪到 `f002e97`，
同时把六条 release 的标题统一成 `Open Learner X.Y.Z`（0.3.1 及更早当时的品牌名是 OpenLeaner）。

**教训**：版本号是个提交里的内容，tag 是提交的指针。先改内容、再打包、最后指 tag。
指针指错了，事后挪 tag 会让已经发出去的下载链接失效，代价比一开始对一次大得多。

## 为什么 0.x 用了这么久

个人自用的本地软件，没有外部依赖方，按 SemVer 的 0.x 就是「随时可能改内部结构」的语义。
真要发布给一群人用、并且承诺库格式稳定，再升 1.0.0。

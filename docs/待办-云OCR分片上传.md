# 待办：云 OCR 分片上传（用户 2026-11-17 明确要求记录）

> 用户原话（2026-11-17）：
> 「现在云端ocr的分片识别功能能不能用，你验证一下。如果不行，这个切片方案放入待办事项中，
> 然后当用户选择云端ocr解析时仅提供整本解析选项。」

## 现状：分片识别不可用（已验证）

- 验证方式：`npx vitest run src/core/ocr/ocr-runner.test.ts src/core/ocr/deepseek-ocr.test.ts --reporter=verbose` → 2 files / 55 tests 全过。绿的是「整份上传」和「页范围拒绝」——恰好证明分片没实现。
- `src/core/ocr/ocr-runner.ts:126-134`：`request.pages` 只要不是 `'all'` 就抛错「云 OCR 目前只能整份上传，做不到「只解析第 X 页」」（带 `trouble='cloud-ocr'`），而且**在读文件之前就抛**，不做任何切片。
- `src/core/ocr/ocr-runner.test.ts:162-204` 把「指定页范围 → 报错且不读文件不发请求」钉死为**预期行为**。
- 界面（改之前）：`ConvertPanel` 仍给云 OCR 用户显示「分片解析」单选，选了要跑到运行时才报错——是个陷阱。
- 本机 MinerU 的分片解析（指定页范围）**是真能用的**，别混为一谈。本待办只针对**云端** DeepSeek OCR。

## 为什么需要它：网关体积上限

- 实测（docs/交接文档-2026-11-17.md:298-301、scripts/diag-ocr-gateway-limit.cjs）：服务端网关对请求体上限 **49 MiB 过 / 50 MiB 拒**；用户那份高数 **55.07 MiB** 被 `413` HTML 拒（耗时 18.5 秒）。
- 代码里 `deepseek-ocr.ts` 的 100 MiB 提前拦和 413 两种来源判定都不是问题——问题是网关比它低得多，大扫描件根本传不上去。

## 技术方案（2026-11-17 已与用户陈述，未批准开工）

核心：把「超过网关上限」从「用户倒霉」变成「程序内部自动切成几片」。

1. **加依赖** `pdf-lib@^1.17.1`（纯 JS、浏览器可用，能打进 dist）。当前 package.json 无此依赖、node_modules 也没装。包管理器 npm（package-lock.json）。
2. **新增 `src/core/ocr/pdf-split.ts`**：`splitPdf(bytes, maxBytes=40MiB)` —— `PDFDocument.load()` 打开，`copyPages()` 分组复制成多个合法子 PDF，每组 `save()` 后查字节数，超限就回退到更小的组；单页超限给明确报错。每片返回 `{bytes, pageOffset, pageCount}`。阈值取 40 MiB 给 multipart 开销留余量（49 能过但 50 被拒）。
3. **改 `src/core/ocr/ocr-runner.ts`**：小文件（<40 MiB）保持原样整份上传、零行为变化；大文件逐片 `runOcr`，把每片返回页的 `page + pageOffset` 拼成整本页数组，再 `toMinerUShape`；进度按「正在识别第 i/N 片」上报；任何一片失败带 `trouble='cloud-ocr'` 抛出。
4. **不改 `src/core/ocr/deepseek-ocr.ts`**：0 基转 1 基、HTTP200 error、413 两来源、100 MiB 提前拦那些钉死的测试保持原样——分片在它上层做。
5. **写回不用改**：`src/core/mineru/write-back.ts:205-209` 已是 `writeSegments(...,'merge')`（新页覆盖同页、没写到的页保留），分片结果汇总后走这条路即可。旧文档担心「要动 merge 语义」是过时的——merge 现成，真正缺的只是切 PDF 的库。
6. **测试**：新增 `pdf-split.test.ts`（真实生成多页 PDF 验切片、页码偏移、加密/损坏报错）；`ocr-runner.test.ts` 加多片拼接断言，但**保留现有「页范围报错」那组**——本次解决体积上限，不做「按用户指定页范围解析」，两者是独立功能。
7. **界面文案**：`src/v2/ui/ConvertPanel.tsx`、可能还有 `EnginePicker.tsx` 里「只能整份上传」「180 秒大文件必超时」的说法要改（改后必须 CDP 截图复核）。
8. **验证**：假 `fetchImpl` 端到端跑一遍大 PDF → 多片 → 偏移合并，不花钱、不碰用户真实库；跑 `npm run typecheck` + `npm run test`。

## 已做的收敛（2026-11-17）

在分片实现之前，云 OCR 的解析方式选项已收敛为**仅整本解析**：
`ConvertPanel` 在 `engine === 'deepseek'` 时不再显示 `PageRangePicker` 的两个单选与页码输入，
按钮/说明文案也只对整本解析说话；本机 MinerU 的「完整/分片」选项不受影响。
 rationale：与其让用户选了「分片解析」到运行时才撞「只能整份上传」的错，不如不给他这个选项。

## 开工前提醒

- 用户决定：**先不推提交**；不碰用户真实库；不做破坏性安装/卸载验证。
- 改界面必须 CDP 截图肉眼复核（截图前把 app 复制到旁边没有 `openleaner-data` 的独立目录）。
- 提交消息若含反引号/反斜杠，写进文件用 `git commit -F`。

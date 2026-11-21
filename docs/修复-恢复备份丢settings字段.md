# 已修：importBackup 的 settings 白名单会丢字段（2026-11-21 发现并修复）

> 状态：**已修**（2026-11-21，`src/core/library.ts` 的 `importBackup`）。
> 本文保留复盘，因为这类「数据在、但没生效」的问题会反复出现。

## 结论（先实验证实，不是读代码猜的）

`src/core/library.ts` 的 `importBackup` 里，`settings` 是**逐字段白名单**恢复：

```ts
await this.storage.put('settings', {
  locale: ...,
  questionLanguage: ...,
  onboarded: ...,
  gradingRules: ...,
  id: SETTINGS_ID,
});
```

**不在白名单里的字段一律丢失。** 实测（MemoryStorage，导出→导入往返）：

```
AFTER_HOME_WIDGETS=undefined          ← 应为 [{id:'w_1',kind:'quote',title:'座右铭',body:'天行健'}]
AFTER_QUOTE_ENDPOINT=undefined        ← 应为 'https://example.com/quote'
```

备份文件里**确实有**这两个字段（`JSON.stringify(backup)` 里搜得到「天行健」），
所以是「数据在、但恢复后没生效」。

## 影响

用户换机器恢复备份后：
1. 首页右侧自定义的小组件全没了（回到默认 4 个）
2. 自定义的每日一句端点没了（回到内置语料）

**界面不会报任何错** —— 这是最难发现的那一类。

## 讽刺的地方

同一段代码**下面**的注释早就写对了结论：

> 评分规则要显式带上，不能只列前三个字段。
> 这里原来是「逐字段白名单」，漏一个新字段的后果是：
> 用户恢复备份后自定义评分悄悄退回默认，而备份文件里明明存着 ——
> 属于「数据在、但没生效」的那类最难发现的问题。

结论对，但当时只补了 `gradingRules` 一个字段，**白名单本身没拆掉**。
后来加的 `homeWidgets`、`dailyQuoteEndpoint` 又掉进同一个坑。

**教训**：修「白名单漏字段」时，补一个字段不够 —— 要把白名单拆成
「默认值打底 + 整体展开 + 关键字段归一化」。

## 修法（已实施）

```ts
const restored = sanitizeSettingsForExport({
  ...DEFAULT_SETTINGS,
  ...((backup.settings ?? {}) as Partial<AppSettings>),
});
await this.storage.put('settings', {
  ...restored,
  locale: backup.settings?.locale ?? DEFAULT_SETTINGS.locale,
  questionLanguage: backup.settings?.questionLanguage ?? DEFAULT_SETTINGS.questionLanguage,
  onboarded: backup.settings?.onboarded ?? DEFAULT_SETTINGS.onboarded,
  gradingRules: normalizeGradingRules(backup.settings?.gradingRules),
  id: SETTINGS_ID,
});
```

三点：
1. `DEFAULT_SETTINGS` 打底 —— 新库/旧备份都有全部默认值
2. **整体展开**备份里的 settings —— 以后加字段自动跟着走，不用回来改
3. 展开前先 `sanitizeSettingsForExport` —— 旧备份里的凭据字段
   （`maimemoToken`）不会被重新写进库

## 回归测试（`src/core/library.test.ts` 新增 4 条）

| 测试 | 验什么 |
|---|---|
| 恢复备份时保留自定义首页小组件 | `homeWidgets` 活过往返 |
| 恢复备份时保留自定义每日一句端点 | `dailyQuoteEndpoint` 活过往返 |
| 恢复备份时凭据类字段仍被清掉 | 展开 settings 不会带回旧凭据 |
| 旧备份缺 settings 字段时用默认值补齐 | 没有 settings 也能导入 |

**反向验证做过**：把 `...backup.settings` 展开删掉（退回白名单行为），
前两条立刻红 —— 证明它们确实在验东西，不是摆设。
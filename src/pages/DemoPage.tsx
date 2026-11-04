import { PlaceholderPage } from '@/components/PlaceholderPage.tsx';

/**
 * 演示用假页面。
 *
 * P0 验收第 4 条：「加一个假页面也能立刻工作（证明模块是可插拔的，不是硬编码）」。
 * 这个页面就是那条验收的实物证据——它的整个存在只是一次 register() 调用，
 * 没有改导航、没有改路由、没有改 AppShell。
 *
 * 验收后可以删掉它；保留也不影响其他功能，因为它不碰任何数据。
 */
export function DemoPage() {
  return (
    <PlaceholderPage
      title="可插拔验证页"
      phase="P0"
      summary="这个页面存在的唯一目的是证明骨架可插拔：它没有修改导航、路由或外壳的任何一行代码，只是调用了一次 register()，就同时出现在左侧导航、路由和页面标题里。"
      items={[
        '注册方式：在 modules.ts 里 import 本文件，文件顶层调用 register({...})',
        '出现位置：左侧导航条目、顶栏标题、可访问路由 —— 三处都由注册表推导',
        '删除方式：删掉 register 调用即可，不留残留代码',
        '排序方式：改 order 字段，导航顺序随之变化，不需要改动其他文件',
      ]}
    />
  );
}

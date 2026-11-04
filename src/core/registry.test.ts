import { describe, expect, it, beforeEach } from 'vitest';
import { register, allPages, navPages, findPage, defaultPageId, __resetRegistryForTests } from './registry.ts';

/**
 * 可插拔注册表测试。
 *
 * 对应计划书 P0 验收第 4 条：
 * 「加一个假页面也能立刻工作（证明模块是可插拔的，不是硬编码）」
 *
 * 这里断言的是**可插拔性的机制**，而不是「demo 页面存在」这个事实：
 * 任意新模块只要 register，就能同时获得导航条目、路由可达、标题解析三项能力。
 */

function stubComponent() {
  return () => null;
}

beforeEach(() => {
  __resetRegistryForTests();
});

describe('register 与查询', () => {
  it('注册后能按 id 查回', () => {
    register({
      id: 'alpha',
      title: '甲页面',
      summary: '说明',
      order: 10,
      inNav: true,
      status: 'planned',
      component: stubComponent(),
    });

    const found = findPage('alpha');
    expect(found).toBeDefined();
    expect(found?.title).toBe('甲页面');
  });

  it('未注册的 id 返回 undefined，不抛错', () => {
    expect(findPage('不存在')).toBeUndefined();
  });

  it('重复 id 直接抛错（拒绝静默覆盖）', () => {
    const page = {
      id: 'dup',
      title: '第一次',
      summary: '',
      order: 1,
      inNav: true,
      status: 'planned' as const,
      component: stubComponent(),
    };
    register(page);
    // 静态覆盖会让「我明明注册了却看到另一个页面」变成难查的 bug
    expect(() => register({ ...page, title: '第二次' })).toThrow(/重复注册/);
  });
});

describe('排序', () => {
  it('按 order 升序排列', () => {
    register({ id: 'c', title: '丙', summary: '', order: 30, inNav: true, status: 'planned', component: stubComponent() });
    register({ id: 'a', title: '甲', summary: '', order: 10, inNav: true, status: 'planned', component: stubComponent() });
    register({ id: 'b', title: '乙', summary: '', order: 20, inNav: true, status: 'planned', component: stubComponent() });

    expect(allPages().map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('order 相同时按标题稳定排序，不随注册顺序抖动', () => {
    register({ id: 'y', title: 'B 页', summary: '', order: 5, inNav: true, status: 'planned', component: stubComponent() });
    register({ id: 'x', title: 'A 页', summary: '', order: 5, inNav: true, status: 'planned', component: stubComponent() });

    expect(allPages().map((p) => p.title)).toEqual(['A 页', 'B 页']);
  });
});

describe('导航可见性', () => {
  it('inNav:false 的页面在 allPages 里但不在 navPages 里', () => {
    register({ id: 'list', title: '列表', summary: '', order: 1, inNav: true, status: 'ready', component: stubComponent() });
    register({ id: 'detail', title: '详情', summary: '', order: 2, inNav: false, status: 'ready', component: stubComponent() });

    expect(allPages()).toHaveLength(2);
    expect(navPages().map((p) => p.id)).toEqual(['list']);
  });
});

describe('默认落地页', () => {
  it('取第一个导航页面，而不是写死的 id', () => {
    register({ id: 'late', title: '后', summary: '', order: 90, inNav: true, status: 'ready', component: stubComponent() });
    register({ id: 'first', title: '先', summary: '', order: 1, inNav: true, status: 'ready', component: stubComponent() });

    expect(defaultPageId()).toBe('first');
  });

  it('没有任何导航页面时明确报错，而不是返回空字符串', () => {
    register({ id: 'hidden', title: '隐藏', summary: '', order: 1, inNav: false, status: 'ready', component: stubComponent() });
    // 返回空串会让路由跳到一个奇怪地址，报错更容易定位
    expect(() => defaultPageId()).toThrow(/没有注册任何页面模块/);
  });
});

describe('P0 验收：新增一个页面不需要改动骨架', () => {
  it('任意新模块注册后，导航/路由/标题三处同时可得', () => {
    // 这个用例模拟「开发者新增一个页面文件 + 一次 register」
    register({
      id: 'fake-feature',
      title: '假功能',
      summary: '用来验证可插拔',
      order: 15,
      inNav: true,
      status: 'planned',
      phase: 'P0',
      component: stubComponent(),
    });

    // 1) 出现在导航里
    expect(navPages().map((p) => p.id)).toContain('fake-feature');
    // 2) 路由能解析到（router 由 allPages 生成）
    expect(allPages().map((p) => p.id)).toContain('fake-feature');
    // 3) 顶栏标题能解析到
    expect(findPage('fake-feature')?.title).toBe('假功能');
  });

  it('删除注册后三处同时消失，不留残留', () => {
    __resetRegistryForTests();
    register({ id: 'temp', title: '临时', summary: '', order: 1, inNav: true, status: 'planned', component: stubComponent() });
    expect(navPages()).toHaveLength(1);

    __resetRegistryForTests();
    expect(navPages()).toHaveLength(0);
    expect(findPage('temp')).toBeUndefined();
  });
});

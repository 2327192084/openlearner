import 'fake-indexeddb/auto';

/**
 * 测试环境准备。
 *
 * `fake-indexeddb/auto` 会在全局装上一套内存版 IndexedDB 实现，
 * 让 IndexedDbStorage 的用例能在 node 里跑——不必启动浏览器，
 * 也就不必为了跑一个用例去装 Playwright。
 */

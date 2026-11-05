import { createHashRouter, Navigate, RouterProvider } from 'react-router-dom';
import type { RouteObject } from 'react-router-dom';
import { allPages, defaultPageId } from '@/core/registry.ts';
import { AppShell } from '@/app/AppShell.tsx';
import { ErrorState } from '@/components/states.tsx';

/**
 * 路由完全由注册表推导。
 *
 * ---- 为什么是 hash 路由，不是 history 路由 ----
 *
 * 同一个构建产物要同时跑在两个地方：
 *   1. Electron 生产包：主进程用 loadFile 加载 dist/index.html，协议是 file://
 *   2. Web 部署：静态托管，协议是 http(s)://
 *
 * history 路由在这两处都有坑：
 *   - file:// 下 location.pathname 是整个文件路径
 *     （/E:/openleaner/dist/index.html），匹配不到任何路由，落到通配 404。
 *     这不是理论风险：用无头浏览器打开 file:///.../dist/index.html 实测，
 *     首屏直接显示「页面不存在」——而浏览器里验收全过，根本发现不了。
 *   - http:// 静态托管需要额外配置 SPA 回退（nginx try_files / Netlify _redirects），
 *     漏配一次就是刷新 404。
 *
 * hash 路由两处都天然可用，代价只是 URL 里多一个 #。
 * 对一个不分享链接的桌面学习工具，这个代价可以忽略；换来的是
 * 「打包出来的东西双击就能用」和「静态丢上去就能访问」。
 */
export function AppRouter() {
  const pages = allPages();
  const fallbackId = defaultPageId();

  const routes: RouteObject[] = [
    {
      path: '/',
      element: <AppShell />,
      errorElement: <RouteError />,
      children: [
        { index: true, element: <Navigate to={`/${fallbackId}`} replace /> },
        ...pages.map((page) => {
          const Component = page.component;
          return { path: page.id, element: <Component /> };
        }),
        { path: '*', element: <NotFound /> },
      ],
    },
  ];

  return <RouterProvider router={createHashRouter(routes)} />;
}

function NotFound() {
  return (
    <ErrorState
      title="页面不存在"
      message="这个地址没有对应的页面。可能是链接过期，或者该页面已被移除。"
      hint="从左侧导航重新进入；如果是从备份或旧链接跳来的，路径可能已经变了。"
    />
  );
}

function RouteError() {
  return (
    <ErrorState
      title="页面出错了"
      message="渲染这个页面时遇到意外错误，其他功能不受影响。"
      hint="刷新页面重试。如果反复出现，请记下你刚才的操作，方便定位。"
      onRetry={() => window.location.reload()}
      retryLabel="刷新页面"
    />
  );
}

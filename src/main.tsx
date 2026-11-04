import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LibraryService } from '@/core/library.ts';
import { BackendService } from '@/core/backends.ts';
import { CourseService, SourceService } from '@/core/sources.ts';
import { KnowledgeService } from '@/core/knowledge/service.ts';
import { IndexedDbStorage } from '@/core/storage/indexeddb-storage.ts';
import { ServicesContext, type AppServices } from '@/app/services-context.ts';
import { AppRouter } from '@/app/router.tsx';
import { ErrorState, LoadingState } from '@/components/states.tsx';
import { detectEnv } from '@/app/env.ts';
import '@/styles/base.css';
import '@/styles/components.css';
import '@/pages/modules.ts';

/**
 * 应用入口。
 *
 * 顺序很重要：先把存储打开（IndexedDB 首次要建表），再渲染路由。
 * 反过来会出现「页面已渲染但存储还没就绪」的竞态，
 * 表现是首屏偶尔读不到学习库——这类问题在慢机器上才复现，很难查。
 */
function Bootstrap() {
  const [services, setServices] = useState<AppServices | null>(null);
  const [failure, setFailure] = useState<{ message: string; hint: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const storage = new IndexedDbStorage();
    const library = new LibraryService(storage);
    const backends = new BackendService(storage);
    const sources = new SourceService(storage);
    const courses = new CourseService(storage);
    const knowledge = new KnowledgeService(storage, sources);

    library
      .init()
      .then(() => {
        if (cancelled) return;
        setServices({ library, backends, sources, courses, knowledge, env: detectEnv() });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFailure({
          message: err instanceof Error ? err.message : String(err),
          hint: '学习库存不进去时应用无法工作。请检查：是否在无痕/隐私模式（浏览器会禁用 IndexedDB），或磁盘是否已满。换一个普通窗口重试通常即可。',
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (failure) {
    return (
      <ErrorState
        title="本地存储不可用"
        message={failure.message}
        hint={failure.hint}
        onRetry={() => window.location.reload()}
        retryLabel="重新加载"
      />
    );
  }

  if (!services) {
    return <LoadingState label="正在准备学习库…" />;
  }

  return (
    <ServicesContext.Provider value={services}>
      <AppRouter />
    </ServicesContext.Provider>
  );
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 挂载点，index.html 可能被改坏了');
}

createRoot(container).render(
  <StrictMode>
    <Bootstrap />
  </StrictMode>,
);

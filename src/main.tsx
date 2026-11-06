import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LibraryService } from '@/core/library.ts';
import { BackendService } from '@/core/backends.ts';
import { CourseService, SourceService } from '@/core/sources.ts';
import { KnowledgeService } from '@/core/knowledge/service.ts';
import { DeckService } from '@/core/questions/service.ts';
import { SlideService } from '@/core/slides/service.ts';
import { UsageService } from '@/core/usage.ts';
import { AnnotationService } from '@/core/annotation-service.ts';
import { IndexedDbStorage } from '@/core/storage/indexeddb-storage.ts';
import { ServicesContext, type AppServices } from '@/app/services-context.ts';
// v1 路由暂时不用，但保留文件（解析器与业务逻辑仍被 v2 复用）
import { ReviewService } from '@/v2/core/review-service.ts';
import { App as V2App } from '@/v2/ui/App.tsx';
import { createCardLoader } from '@/v2/ui/cards-loader.ts';
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
  /**
   * v2 界面所需的数据。
   *
   * cardPool 现在是「题目 + 知识点」的 id 集合 ——
   * 间隔复习对两者一视同仁，统一成「卡片」。
   */
  const [v2Data, setV2Data] = useState<{
    review: ReviewService;
    cardPool: string[];
    hasSources: boolean;
    connected: boolean;
    modelName: string | null;
    loadCards: ReturnType<typeof createCardLoader>;
    sourceService: SourceService;
  } | null>(null);
  const [failure, setFailure] = useState<{ message: string; hint: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const storage = new IndexedDbStorage();
    const library = new LibraryService(storage);
    const backends = new BackendService(storage);
    const sources = new SourceService(storage);
    const courses = new CourseService(storage);
    const annotations = new AnnotationService(storage);
    const usage = new UsageService(storage);
    const knowledge = new KnowledgeService(storage, sources, usage);
    const decks = new DeckService(storage, usage);
    const slides = new SlideService(storage, usage);

    library
      .init()
      .then(async () => {
        if (cancelled) return;

        // ---- v2 数据 ----
        const review = new ReviewService(storage);
        const [questions, points, srcs] = await Promise.all([
          storage.getAll('questions'),
          storage.getAll('knowledgePoints'),
          storage.getAll('sources'),
        ]);
        if (cancelled) return;
        // 读后端配置判断是否已接入模型
        const backendList = await backends.list();
        const ready = backendList.filter((b) => b.status === 'ready');
        const first = ready[0] ?? null;

        setV2Data({
          review,
          cardPool: [...questions.map((q) => q.id), ...points.map((p) => p.id)],
          hasSources: srcs.length > 0,
          connected: ready.length > 0,
          modelName: first ? `${first.label} · ${first.model || '未填模型'}` : null,
          loadCards: createCardLoader(storage),
          sourceService: sources,
        });

        setServices({
          library,
          backends,
          sources,
          courses,
          annotations,
          usage,
          knowledge,
          decks,
          slides,
          env: detectEnv(),
        });
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

  if (!v2Data) {
    return <LoadingState label="正在准备学习库…" />;
  }

  /*
   * v2 界面接管。
   *
   * v1 的 AppRouter 暂时保留在 src/app/ 里 ——
   * 它承载的解析器、存储、出题逻辑仍然被 v2 复用，
   * 只是不再作为主界面。
   */
  return (
    <ServicesContext.Provider value={services}>
      <V2App
        reviewService={v2Data.review}
        cardPool={v2Data.cardPool}
        hasSources={v2Data.hasSources}
        connected={v2Data.connected}
        modelName={v2Data.modelName}
        loadCards={v2Data.loadCards}
        sourceService={v2Data.sourceService}
      />
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

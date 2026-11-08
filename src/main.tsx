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
import { NoteService } from '@/core/notes.ts';
import { ExamService } from '@/core/exam.ts';
import { TodoService } from '@/core/todos.ts';
import { FocusService } from '@/core/focus.ts';
import { TrashService } from '@/core/trash.ts';
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
    knowledge: AppServices['knowledge'];
    decks: AppServices['decks'];
    backends: AppServices['backends'];
  } | null>(null);
  const [failure, setFailure] = useState<{ message: string; hint: string } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const storage = new IndexedDbStorage();
    /*
     * 回收站（2026-11-08）必须**最先**建。
     *
     * 下面每个服务都要在构造时拿到它 —— 删除动作全部经过回收站，
     * 漏传一个就是「那条删除路径不可恢复」，而这种漏在界面上看不出来，
     * 只有用户误删后想还原才会发现。所以放在最前面，按依赖顺序往下传。
     */
    const trash = new TrashService(storage);
    const library = new LibraryService(storage);
    const backends = new BackendService(storage);
    const sources = new SourceService(storage, trash);
    const courses = new CourseService(storage);
    const annotations = new AnnotationService(storage);
    const notes = new NoteService(storage, trash);
    const exam = new ExamService(storage);
    const todos = new TodoService(storage, trash);
    const focus = new FocusService(storage);
    const usage = new UsageService(storage);
    const knowledge = new KnowledgeService(storage, sources, usage, trash);
    const decks = new DeckService(storage, usage, trash);
    const slides = new SlideService(storage, usage);

    library
      .init()
      .then(async () => {
        if (cancelled) return;

        // ---- v2 数据 ----
        const review = new ReviewService(storage);
        const [questions, , srcs, deckRows] = await Promise.all([
          storage.getAll('questions'),
          storage.getAll('knowledgePoints'),
          storage.getAll('sources'),
          storage.getAll('decks'),
        ]);
        if (cancelled) return;
        /*
         * 已发布题组的 id 集合 —— 卡片池必须与 `createCardLoader(storage, 'questions')`
         * 用同一个范围（它只取已发布题组的题）。两个范围不一致会让首页
         * 「已学 N/总数」和下面按资料汇总的条数对不上。
         */
        const publishedDeckIds = new Set(
          deckRows.filter((d) => d.status === 'published').map((d) => d.id),
        );
        // 读后端配置判断是否已接入模型
        const backendList = await backends.list();
        const ready = backendList.filter((b) => b.status === 'ready');
        const first = ready[0] ?? null;

        setV2Data({
          review,
          /*
           * 卡片池只放**题目**，不放知识点。
           *
           * 原来这里是 `[...questions, ...points]`，于是顶栏和「开始做题」
           * 显示「今天有 95 张卡片可以做」，而其中大部分是只读知识点 ——
           * 用户以为有 95 道题，实际做题时被知识点打断节奏。
           *
           * 知识点仍然会被「学习知识」和统计用到，但那是另一条路径
           * （createCardLoader 的 'all' 模式），不从这里走。
           *
           * ⚠️ 还必须只算**已发布**题组的题（2026-11-07 补）。
           *
           * `loadCards` 用的是 'questions' 模式，它只返回已发布题组的题；
           * 而这里原先取的是 `getAll('questions')`，含草稿题。
           * 两个范围不一致，直接后果是首页「已学 10/24」而下面的资料进度
           * 合计只有 16 道 —— 同一屏两个分母，用户没法判断信哪个。
           * 这正是项目早就踩过的「概览说已学 10 张但列表只有 3 张」。
           *
           * 所以这里按 deck 的 published 过滤，与 loadCards 保持同一范围。
           * 学一个数字一个来源 —— 概览上的每个数字都必须限定在同一个池子里。
           */
          cardPool: questions
            .filter((q) => publishedDeckIds.has(q.deckId))
            .map((q) => q.id),
          hasSources: srcs.length > 0,
          connected: ready.length > 0,
          modelName: first ? `${first.label} · ${first.model || '未填模型'}` : null,
          loadCards: createCardLoader(storage, 'questions'),
          sourceService: sources,
          knowledge,
          decks,
          backends,
        });

        setServices({
          library,
          backends,
          sources,
          courses,
          annotations,
          notes,
          exam,
          todos,
          focus,
          usage,
          knowledge,
          decks,
          slides,
          trash,
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
        knowledge={v2Data.knowledge}
        decks={v2Data.decks}
        backends={v2Data.backends}
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

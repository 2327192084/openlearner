import { createContext, useContext } from 'react';
import type { LibraryService } from '@/core/library.ts';
import type { BackendService } from '@/core/backends.ts';
import type { CourseService, SourceService } from '@/core/sources.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';

/**
 * 应用运行时上下文。
 *
 * 用 context 注入而不是全局单例，是为了让测试能把内存存储塞进来，
 * 跑「不联网、不落盘、不要 Key」的流程测试（计划书第 7 节的测试要求）。
 */
export interface AppServices {
  library: LibraryService;
  backends: BackendService;
  /** P1：资料导入、阅读、搜索 */
  sources: SourceService;
  /** P1：课程分组 */
  courses: CourseService;
  /** P2：知识点整理与校对 */
  knowledge: KnowledgeService;
  /** 运行环境：浏览器 / Electron 桌面端 / 测试 */
  env: 'web' | 'desktop' | 'test';
}

export const ServicesContext = createContext<AppServices | null>(null);

export function useServices(): AppServices {
  const ctx = useContext(ServicesContext);
  if (!ctx) {
    throw new Error('useServices 必须在 ServicesProvider 内使用');
  }
  return ctx;
}

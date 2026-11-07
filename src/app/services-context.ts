import { createContext, useContext } from 'react';
import type { LibraryService } from '@/core/library.ts';
import type { BackendService } from '@/core/backends.ts';
import type { CourseService, SourceService } from '@/core/sources.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { SlideService } from '@/core/slides/service.ts';
import type { UsageService } from '@/core/usage.ts';
import type { AnnotationService } from '@/core/annotation-service.ts';
import type { NoteService } from '@/core/notes.ts';
import type { ExamService } from '@/core/exam.ts';
import type { TodoService } from '@/core/todos.ts';
import type { FocusService } from '@/core/focus.ts';

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
  /** 资料页面上的手写注释（画笔 + 文本框） */
  annotations: AnnotationService;
  /** 学习笔记（挂在卡片或资料上的短笔记） */
  notes: NoteService;
  /** 模拟考试（出卷、判分、成绩记录） */
  exam: ExamService;
  /** 待办（带截止日的学习计划） */
  todos: TodoService;
  /** 专注记录（番茄钟） */
  focus: FocusService;
  /** P2：知识点整理与校对 */
  knowledge: KnowledgeService;
  /** P3：习题集、作答与错题 */
  decks: DeckService;
  /** P4：学习 PPT（大纲 → 导出 .pptx） */
  slides: SlideService;
  /** P5：用量统计（按天、按后端） */
  usage: UsageService;
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

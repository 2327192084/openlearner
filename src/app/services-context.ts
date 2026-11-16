import { createContext, useContext } from 'react';
import type { LibraryService } from '@/core/library.ts';
import type { BackendService } from '@/core/backends.ts';
import type { CourseService, SourceService } from '@/core/sources.ts';
import type { KnowledgeService } from '@/core/knowledge/service.ts';
import type { DeckService } from '@/core/questions/service.ts';
import type { FlashcardService } from '@/core/flashcards.ts';
import type { OralReviewService } from '@/core/oral-review-service.ts';
import type { SlideService } from '@/core/slides/service.ts';
import type { UsageService } from '@/core/usage.ts';
import type { AnnotationService } from '@/core/annotation-service.ts';
import type { NoteService } from '@/core/notes.ts';
import type { ExamService } from '@/core/exam.ts';
import type { TodoService } from '@/core/todos.ts';
import type { FocusService } from '@/core/focus.ts';
import type { TrashService } from '@/core/trash.ts';
import type { TaskRunService } from '@/core/task-run-service.ts';

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
  /**
   * 回收站（2026-11-08）。
   *
   * 所有删除动作都经过它：删除 → 进回收站 → 30 天后彻底删。
   * 它也负责「启动时扫一遍」与「距过期 24 小时提醒」。
   */
  trash: TrashService;
  /** P2：知识点整理与校对 */
  knowledge: KnowledgeService;
  /**
   * 任务运行记录（2026-11-17）。
   *
   * 用户要求任务栏也记「文档解析」，并把任务分成未完成/进行中/已完成。
   * 这张表原先只由整理知识点写（出题后来补了 kind），解析从来没写过。
   * 抽一个只管运行记录的小服务，谁跑任务谁调它 —— 不塞进 KnowledgeService
   * （那个管的是知识点，不是运行历史）。
   */
  taskRuns: TaskRunService;
  /** P3：习题集、作答与错题 */
  decks: DeckService;
  /**
   * 记忆闪卡（2026-11-10）。
   *
   * 引用知识点、不复制内容；翻卡**不写复习记录**、不参与间隔排期
   * （那是 ReviewService 的事）。
   */
  flashcards: FlashcardService;
  /**
   * 提问式复习的记录（2026-11-10）。
   *
   * 与 flashcards 一样是纯存储服务 —— 判定逻辑在 core/oral-review.ts。
   */
  oralReviews: OralReviewService;
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

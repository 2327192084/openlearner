import type { Deck, Question } from '../model.ts';

/**
 * 习题集导出。
 *
 * 计划书 P3 第 7 条：「导出：Markdown、JSON、可打印的 Word/PDF」。
 *
 * 这里先做 Markdown 与 JSON 两种（纯文本，零依赖、任何编辑器都能开）。
 * Word/PDF 走浏览器的打印能力（见界面层的打印样式），
 * 不引 docx/pdf 库 —— 那会让打包体积再增加几十 MB，
 * 而学生真正要的是「能打印出来做题」，浏览器打印完全够。
 */

/** 题型的中文名，导出时用 */
const KIND_LABEL: Record<Question['kind'], string> = {
  single: '单选题',
  multiple: '多选题',
  blank: '填空题',
  truefalse: '判断题',
  essay: '问答题',
};

const LEVEL_LABEL: Record<Question['cognitiveLevel'], string> = {
  remember: '识记',
  understand: '理解',
  apply: '应用',
  analyze: '分析',
};

export interface ExportOptions {
  /** 是否包含答案与解析。练习卷不需要，答案册需要 */
  includeAnswers: boolean;
  /** 是否包含出处（页码/章节） */
  includeAnchors: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  includeAnswers: true,
  includeAnchors: true,
};

/**
 * 导出为 Markdown。
 *
 * 结构按「试卷」组织：题目区在前，答案区在后。
 * 这样打印出来可以直接当练习卷用，答案不会混在题目旁边被瞄到。
 *
 * 注意：这里**不生成引用角标的复杂格式**。Markdown 在 Word/WPS 里的表格
 * 支持参差不齐，用最朴素的缩进列表反而排版最稳 —— 计划书要求
 * 「导出的文件在 Word/WPS 里打开排版正常」，朴素比花哨可靠。
 */
export function exportToMarkdown(
  deck: Deck,
  questions: Question[],
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS,
): string {
  const lines: string[] = [];

  lines.push(`# ${deck.title}`);
  lines.push('');
  lines.push(`共 ${questions.length} 题`);
  if (deck.status === 'published' && deck.publishedAt) {
    lines.push(`发布状态：已发布（${formatDate(deck.publishedAt)}）`);
  } else {
    lines.push('发布状态：草稿（未发布）');
  }
  lines.push('');

  // ---- 题目区 ----
  questions.forEach((q, i) => {
    const n = i + 1;
    lines.push(`## 第 ${n} 题（${KIND_LABEL[q.kind]}·${LEVEL_LABEL[q.cognitiveLevel]}）`);
    lines.push('');
    lines.push(q.prompt);
    lines.push('');

    if (q.options.length > 0) {
      for (const opt of q.options) {
        lines.push(`- ${opt.key}. ${opt.text}`);
      }
      lines.push('');
    }

    if (q.kind === 'blank') {
      // 填空题在题干里应当已经有下划线；没有就补一行作答区
      lines.push('答：______________');
      lines.push('');
    } else if (q.kind === 'essay') {
      lines.push('答：');
      lines.push('');
      lines.push('');
    }

    if (options.includeAnchors && q.anchors.length > 0) {
      const a = q.anchors[0];
      const where = [a.chapter, a.page ? `第 ${a.page} 页` : null].filter(Boolean).join(' · ');
      if (where) lines.push(`> 出处：${where}`);
    }
    lines.push('');
  });

  // ---- 答案区 ----
  if (options.includeAnswers) {
    lines.push('---');
    lines.push('');
    lines.push('# 答案与解析');
    lines.push('');

    questions.forEach((q, i) => {
      lines.push(`## 第 ${i + 1} 题`);
      lines.push('');
      lines.push(`**答案：**${formatAnswer(q)}`);
      lines.push('');
      if (q.explanation.trim()) {
        lines.push(`**解析：**${q.explanation}`);
        lines.push('');
      }
      if (options.includeAnchors && q.anchors.length > 0) {
        const a = q.anchors[0];
        const where = [a.chapter, a.page ? `第 ${a.page} 页` : null].filter(Boolean).join(' · ');
        if (where) {
          lines.push(`**出处：**${where}`);
          lines.push('');
        }
      }
    });
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * 导出为 JSON。
 *
 * 用途与 Markdown 不同：**给别的程序读的**。
 * 所以带上完整字段（含 knowledgePointId、anchors 的字符偏移），
 * 并且带一个可识别的格式标记与版本号，便于将来导入或迁移。
 */
export function exportToJson(
  deck: Deck,
  questions: Question[],
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS,
): string {
  const payload = {
    format: 'openleaner-deck',
    version: 1,
    exportedAt: new Date().toISOString(),
    deck: {
      id: deck.id,
      title: deck.title,
      status: deck.status,
      questionCount: questions.length,
      publishedAt: deck.publishedAt,
    },
    questions: questions.map((q, i) => ({
      order: i + 1,
      kind: q.kind,
      prompt: q.prompt,
      options: q.options,
      ...(options.includeAnswers
        ? {
            answer: q.answer,
            explanation: q.explanation,
          }
        : {}),
      cognitiveLevel: q.cognitiveLevel,
      topic: q.topic,
      ...(options.includeAnchors
        ? {
            anchors: q.anchors,
            knowledgePointId: q.knowledgePointId,
          }
        : {}),
    })),
  };

  return JSON.stringify(payload, null, 2);
}

/** 把答案格式化成人类可读的形式 */
function formatAnswer(q: Question): string {
  if (q.kind === 'single') {
    const opt = q.options.find((o) => o.key === q.answer);
    return opt ? `${q.answer}. ${opt.text}` : q.answer;
  }
  if (q.kind === 'multiple') {
    const keys = q.answer.split(',').map((k) => k.trim());
    const texts = keys
      .map((k) => {
        const opt = q.options.find((o) => o.key === k);
        return opt ? `${k}. ${opt.text}` : k;
      })
      .join('；');
    return `${q.answer} — ${texts}`;
  }
  return q.answer;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('zh-CN');
  } catch {
    return iso;
  }
}

/** 导出文件名：带日期，便于用户区分多份导出 */
export function exportFileName(deck: Deck, ext: 'md' | 'json'): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate(),
  ).padStart(2, '0')}`;

  // 文件名里不能有 Windows 非法字符。
  // 注意：标题只有空格时 `|| '习题集'` 不会兜底 —— 空格是 truthy 值，
  // 结果是文件名变成「   -20261104.md」，在资源管理器里像个空文件。
  // 所以先 trim 再判断。
  const cleaned = deck.title.replace(/[\\/:*?"<>|]/g, '_').trim();
  const safe = cleaned.slice(0, 40) || '习题集';

  return `${safe}-${stamp}.${ext}`;
}

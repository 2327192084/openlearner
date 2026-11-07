/**
 * JSON 题组导入。
 *
 * ## 为什么必须支持导入
 *
 * 我们已经有「导出为 JSON」（`exportToJson`），但没有导入 ——
 * 那是把用户的数据锁在一个只能出不能进的柜子里：
 *  - 换机器时只能靠整库备份，不能单独搬一个题组；
 *  - 用户在别的软件（Anki、别的 AI）里已有的题，只能手抄。
 *
 * 这跟「导出备份却不能恢复」是同一类不对称问题。
 *
 * ## 设计参照
 *
 * 结构参考 StudyHub 的 `lib/json-import.js`（MIT）：
 *  - **字段白名单**：只认已知字段，其余丢弃。防止外部 JSON 里的
 *    未知键污染我们的数据结构（那些键可能来自别的软件，语义完全不同）。
 *  - **逐题校验 + 明确指出第几题错**：不整批失败，让用户知道改哪。
 *  - **宽松接受常见写法**：题干可能叫 prompt / question / 题干，
 *    答案可能叫 answer / 正确答案。别的软件导出的东西不能指望字段名一致。
 *
 * ## 为什么不做「LaTeX 转义自动修复」
 *
 * StudyHub 有一个 `repairTexEscapes`，自动修 JSON 里未转义的 LaTeX。
 * 我们目前没有公式渲染，也就没有这个问题；不抄它 ——
 * 抄用不上的代码只会增加维护面。
 */

import type { Question, QuestionKind } from '../model.ts';

/** 支持的输入格式 */
export type ImportFormat = 'openleaner' | 'generic';

/** 解析结果 */
export interface ParsedImport {
  /** 题组标题 */
  title: string;
  /** 解析出来的题（尚未落库） */
  questions: ImportedQuestion[];
  /** 识别到的格式 */
  format: ImportFormat;
  /** 被丢弃的字段（如实告知用户哪些没导进来） */
  droppedFields: string[];
}

/** 一条导入的题（还没有 id / deckId） */
export interface ImportedQuestion {
  kind: QuestionKind;
  prompt: string;
  options: { key: string; text: string }[];
  answer: string;
  explanation: string;
  cognitiveLevel: Question['cognitiveLevel'];
  topic: string;
}

/** 导入失败时给出的、可操作的原因 */
export class ImportError extends Error {
  constructor(
    message: string,
    /** 给用户看的下一步 */
    readonly hint: string,
    /** 第几题出错（0 表示不是某一道题的问题） */
    readonly questionIndex = 0,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

/** 内容上限：与 StudyHub 一致，50 万字符 */
const MAX_CHARS = 500_000;

/** 一条题允许出现的字段（其余丢弃并告知） */
const ALLOWED_QUESTION_KEYS = new Set([
  'order',
  'kind',
  'prompt',
  '题干',
  'question',
  'options',
  '选项',
  'answer',
  '答案',
  '正确答案',
  'explanation',
  '解析',
  'cognitiveLevel',
  'topic',
  'anchors',
  'knowledgePointId',
]);

/** 题型别名：别的软件可能用别的写法 */
const KIND_ALIASES: Record<string, QuestionKind> = {
  single: 'single',
  singlechoice: 'single',
  single_choice: 'single',
  radio: 'single',
  choice: 'single',
  单选: 'single',
  multiple: 'multiple',
  multiplechoice: 'multiple',
  multiple_choice: 'multiple',
  checkbox: 'multiple',
  多选: 'multiple',
  truefalse: 'truefalse',
  true_false: 'truefalse',
  boolean: 'truefalse',
  bool: 'truefalse',
  判断: 'truefalse',
  判断题: 'truefalse',
  blank: 'blank',
  fill: 'blank',
  fillblank: 'blank',
  fill_blank: 'blank',
  text: 'blank',
  填空: 'blank',
  essay: 'essay',
  open: 'essay',
  openended: 'essay',
  short: 'essay',
  qa: 'essay',
  问答: 'essay',
  简答: 'essay',
  论述: 'essay',
};

/**
 * 解析一段 JSON 文本。
 *
 * 两种格式都接受：
 *  1. **openleaner**：我们自己导出的 `{format:'openleaner-deck', deck, questions}`
 *  2. **generic**：任何含 `{title?, cards|questions: [...]}` 的对象，
 *     或一个裸数组 `[{prompt, answer, ...}]`
 */
export function parseDeckJson(text: string): ParsedImport {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new ImportError('内容是空的', '把 JSON 粘贴进来，或者选择一个 .json 文件');
  }
  if (text.length > MAX_CHARS) {
    throw new ImportError(
      `内容超过 ${MAX_CHARS.toLocaleString()} 字符`,
      '这么大的题组请拆成几个文件分别导入',
    );
  }

  /* 去掉 BOM 与可能包着的 markdown 围栏（很多人从聊天窗口里复制） */
  const cleaned = text
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')
    .trim();

  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch (err) {
    throw new ImportError(
      `JSON 格式错误：${err instanceof Error ? err.message : String(err)}`,
      '检查是否有缺逗号、多逗号、或用了单引号（JSON 只认双引号）',
    );
  }

  /* ---- 形态判定 ---- */
  const isArray = Array.isArray(raw);
  if (!isArray && (raw === null || typeof raw !== 'object')) {
    throw new ImportError(
      'JSON 顶层既不是对象也不是数组',
      '顶层应该是 {"title": "...", "questions": [...]} 或直接一个题目数组',
    );
  }

  const obj = (isArray ? {} : raw) as Record<string, unknown>;
  const format: ImportFormat = obj.format === 'openleaner-deck' ? 'openleaner' : 'generic';

  /* 题数组：questions / cards 都认 */
  const list = isArray
    ? (raw as unknown[])
    : Array.isArray(obj.questions)
      ? (obj.questions as unknown[])
      : Array.isArray(obj.cards)
        ? (obj.cards as unknown[])
        : null;

  if (!list) {
    throw new ImportError(
      '找不到题目数组',
      '需要一个 questions 或 cards 数组，例如 {"title":"第一章","questions":[...]}',
    );
  }
  if (list.length === 0) {
    throw new ImportError('题目数组是空的', '至少放一道题进去');
  }

  /* 标题：我们自己导出的在 deck.title 里，通用格式在 title 里 */
  const deckObj = (obj.deck ?? {}) as Record<string, unknown>;
  const title =
    (typeof deckObj.title === 'string' && deckObj.title.trim()) ||
    (typeof obj.title === 'string' && obj.title.trim()) ||
    '导入的题组';

  const questions: ImportedQuestion[] = [];
  const dropped = new Set<string>();

  list.forEach((item, i) => {
    const n = i + 1;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ImportError(`第 ${n} 题不是对象`, '每一道题都应该是 {"prompt": ..., "answer": ...}', n);
    }
    const q = item as Record<string, unknown>;

    /* 记录被丢弃的字段（后来的人知道导入了什么） */
    for (const k of Object.keys(q)) {
      if (!ALLOWED_QUESTION_KEYS.has(k)) dropped.add(k);
    }

    /* 题干：三种常见写法 */
    const prompt = pickString(q, ['prompt', '题干', 'question', 'title']).trim();
    if (!prompt) {
      throw new ImportError(`第 ${n} 题没有题干`, '字段名可以是 prompt / 题干 / question', n);
    }

    /* 题型：先按别名归一；识别不出来时按选项内容猜 */
    const kindRaw = pickString(q, ['kind', 'type', '题型']).trim().toLowerCase();
    const options = parseOptions(q.options ?? q['选项'], n);
    const kind = resolveKind(kindRaw, options, n);

    /* 答案 */
    const answerRaw = pickAny(q, ['answer', '答案', '正确答案']);
    const answer = stringifyAnswer(answerRaw).trim();
    if (!answer) {
      throw new ImportError(
        `第 ${n} 题没有答案`,
        '字段名可以是 answer / 答案 / 正确答案',
        n,
      );
    }

    /* 判断题：答案必须是 T/F 的一种写法 */
    const normalizedAnswer =
      kind === 'truefalse' ? normalizeTrueFalse(answer, n) : answer;

    /* 选择题：答案键必须真的在选项里，否则这道题做不了 */
    if (kind === 'single' || kind === 'multiple') {
      const keys = new Set(options.map((o) => o.key.toUpperCase()));
      const given = normalizedAnswer
        .split(/[,，\s]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      const bad = given.filter((k) => !keys.has(k));
      if (bad.length > 0) {
        throw new ImportError(
          `第 ${n} 题的答案「${bad.join(',')}」不在选项里`,
          `这道题的选项是 ${[...keys].join('/')}，答案必须从里面选`,
          n,
        );
      }
    }

    questions.push({
      kind,
      prompt,
      options: kind === 'truefalse' ? trueFalseOptions() : options,
      answer: normalizedAnswer,
      explanation: pickString(q, ['explanation', '解析']).trim(),
      cognitiveLevel: parseLevel(pickString(q, ['cognitiveLevel', 'level'])),
      topic: pickString(q, ['topic']).trim(),
    });
  });

  return {
    title,
    questions,
    format,
    droppedFields: [...dropped],
  };
}

/* ============================ 辅助 ============================ */

/** 按候选字段名取第一个非空字符串 */
function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

/** 取第一个存在的值（不限类型） */
function pickAny(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return '';
}

/**
 * 答案可能是字符串（'A'）、字符串数组（['A','C']）、
 * 或布尔（判断题的 true/false）。统一成字符串。
 */
function stringifyAnswer(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'T' : 'F';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map((x) => String(x)).join(',');
  return '';
}

/** 解析选项数组，兼容 {key,text} / {key,value} / 纯字符串数组 */
function parseOptions(v: unknown, n: number): { key: string; text: string }[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new ImportError(`第 ${n} 题的 options 不是数组`, '选项应该是 [{key:"A",text:"…"}, …]', n);
  }

  return v.map((o, i) => {
    /* 纯字符串数组：key 用 A/B/C… 自动编 */
    if (typeof o === 'string') {
      return { key: String.fromCharCode(65 + i), text: o };
    }
    if (o && typeof o === 'object') {
      const rec = o as Record<string, unknown>;
      const key =
        (typeof rec.key === 'string' && rec.key) ||
        (typeof rec.label === 'string' && rec.label) ||
        String.fromCharCode(65 + i);
      const text =
        (typeof rec.text === 'string' && rec.text) ||
        (typeof rec.value === 'string' && rec.value) ||
        (typeof rec.content === 'string' && rec.content) ||
        '';
      return { key: key.trim(), text: text.trim() };
    }
    throw new ImportError(`第 ${n} 题的第 ${i + 1} 个选项无法识别`, '选项要写成 {key, text} 或纯字符串', n);
  });
}

/**
 * 题型归一：别名 → 标准 ID；没写时按选项**内容**猜。
 *
 * ⚠️ 这里踩过一个坑：最初按「选项数量」猜 —— 2 个选项就当成判断题。
 * 但很多单选题只有两个选项（「甲/乙」「是/否」之外的表述），
 * 于是它们被误判成判断题，然后因为答案「A」不是「对/错」而报错。
 * 测试当场抓到（选项写成 ['甲','乙'] 的那条）。
 *
 * 现在只在**选项文字确实是「对/错」**时才猜判断题 —— 那才是有依据的判断。
 */
function resolveKind(
  raw: string,
  options: { key: string; text: string }[],
  n: number,
): QuestionKind {
  if (raw) {
    const hit = KIND_ALIASES[raw.replace(/[\s_-]/g, '')] ?? KIND_ALIASES[raw];
    if (hit) return hit;
    throw new ImportError(
      `第 ${n} 题的题型「${raw}」不认识`,
      '支持：单选 / 多选 / 判断 / 填空 / 问答（或 single/multiple/truefalse/blank/essay）',
      n,
    );
  }

  if (options.length === 0) return 'blank';

  /* 只有选项字面就是「对/错」（或 T/F）才算判断题 */
  const texts = options.map((o) => o.text.trim());
  const looksTrueFalse =
    options.length === 2 &&
    ((texts.includes('对') && texts.includes('错')) ||
      (texts.includes('正确') && texts.includes('错误')) ||
      (texts.includes('True') && texts.includes('False')));
  if (looksTrueFalse) return 'truefalse';

  /* 其余有选项的一律当单选 —— 宁可当单选（能正常作答），
     也不误判成判断题（会因为答案格式不对而报错） */
  return 'single';
}

/** 判断题答案归一：接受 T/F/对/错/true/false */
function normalizeTrueFalse(answer: string, n: number): string {
  const v = answer.trim().toUpperCase();
  if (v === 'T' || v === 'TRUE' || v === '对' || v === '正确' || v === '是') return 'T';
  if (v === 'F' || v === 'FALSE' || v === '错' || v === '错误' || v === '否') return 'F';
  throw new ImportError(
    `第 ${n} 题的判断题答案「${answer}」不是对/错`,
    '判断题的答案写成 T / F，或 对 / 错',
    n,
  );
}

/** 判断题的固定选项 */
function trueFalseOptions(): { key: string; text: string }[] {
  return [
    { key: 'T', text: '对' },
    { key: 'F', text: '错' },
  ];
}

/** 认知层级归一，认不出就用 remember（不猜更高的） */
function parseLevel(raw: string): Question['cognitiveLevel'] {
  const v = raw.trim().toLowerCase();
  if (v === 'understand' || v === '理解') return 'understand';
  if (v === 'apply' || v === '应用') return 'apply';
  if (v === 'analyze' || v === '分析') return 'analyze';
  return 'remember';
}

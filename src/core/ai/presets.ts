/**
 * 服务商预设表。
 *
 * ## 为什么需要这张表
 *
 * 「让用户填 baseUrl 和 model」听起来很通用，实际用起来很糟：
 * 大部分人不知道 DeepSeek 的地址是 `https://api.deepseek.com`、
 * 模型叫 `deepseek-chat`，更不知道智谱要 `https://open.bigmodel.cn/api/paas/v4`、
 * 通义要 `https://dashscope.aliyuncs.com/compatible-mode/v1`。
 * 让他们从零填三个字段，等于把接入失败的责任推给用户。
 *
 * 所以：常见服务商做成预设，选中即自动填好地址与默认模型；
 * 「自定义」一项保留完全自由填写的出口，覆盖中转站、私有部署、
 * 学校网关、以及 agent 平台提供的兼容端点。
 *
 * ## 为什么几乎都是「OpenAI 兼容」
 *
 * 实测与官方文档确认，下列服务商都提供 OpenAI 兼容的
 * `POST {baseUrl}/chat/completions`：
 *   DeepSeek、月之暗面 Kimi、智谱 GLM、阿里通义千问（compatible-mode）、
 *   硅基流动、火山方舟、OpenAI 本体，以及各类中转站。
 *
 * agent 平台也走这条路：WorkBuddy 的「自定义模型」要求填的就是
 * OpenAI 兼容的接口地址 + Key，用户从那里拿到的端点可以直接填进「自定义」。
 * 这也是本项目选「通用兼容层」而不是「为每家写适配器」的原因 ——
 * 适配器方案每加一家就要改代码，兼容层方案加一家只是加一行预设。
 *
 * ## 能力标注的来源
 *
 * `visionFormula`（看图识公式）只在该服务商确实提供多模态模型时为 true。
 * 这一项错标会让用户在扫描件上点了「用看图模型」然后拿到一堆 400，
 * 所以宁可保守：不确定就 false，用户仍可在设置页手工勾上。
 */

/** 一家服务商的接入预设 */
export interface ProviderPreset {
  /** 稳定标识，存进 BackendConfig.provider */
  id: string;
  /** 下拉框显示名 */
  label: string;
  /** 一句话说明，帮用户判断该选哪个 */
  note: string;
  /** API 基址（不含 /chat/completions） */
  baseUrl: string;
  /** 默认模型名 */
  defaultModel: string;
  /** 常用模型候选，界面上做成可点的建议 */
  models: string[];
  /** 是否支持看图（多模态） */
  vision: boolean;
  /**
   * 是否需要额外说明怎么拿 Key。
   * 有值时设置页会在 Key 输入框下面显示这条指引。
   */
  keyHint?: string;
  /**
   * 该服务对 JSON 模式的兼容性备注。
   *
   * 少数兼容实现不认 `response_format: {type:'json_object'}`，
   * 会直接 400。这类服务在这里标 true，调用时就不发这个字段，
   * 改由 prompt 里要求「只输出 JSON」+ 解析时容错。
   */
  jsonModeUnsupported?: boolean;
  /**
   * 模型名必须由用户自己填，没有可用的默认值。
   *
   * 目前只有火山方舟是这样：它要求填**推理接入点 ID**（`ep-` 开头），
   * 而不是模型本名。硬塞一个 `doubao-xxx` 进去只会让用户拿到 404
   * 还不知道为什么。标了这个标记的服务，界面会把模型名标成必填、
   * 并在测试连接前就拦住空值。
   */
  modelMustBeFilled?: boolean;
}

/** 「自定义」预设的 id。选它时不覆盖用户已填的地址与模型。 */
export const CUSTOM_PROVIDER_ID = 'custom';

/**
 * 预设清单。
 *
 * 排序按「国内可用性 + 与本项目适配度」，不是字母序 ——
 * 用户第一个看到的最可能是他要的那个。
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek 深度求索',
    note: '便宜、中文好，默认推荐。整理一份课件大约几毛钱。',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    vision: false,
    keyHint: '在 platform.deepseek.com 的「API keys」页面创建，形如 sk- 开头。',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    note: '长上下文见长，整本教材一次喂进去不容易截断。',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-32k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    vision: false,
    keyHint: '在 platform.moonshot.cn 创建 API Key。',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    note: '有免费额度，适合先试。GLM-4V 支持看图。',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4-plus', 'glm-4v-plus'],
    vision: true,
    keyHint: '在 bigmodel.cn 的「API Keys」页面创建。',
  },
  {
    id: 'dashscope',
    label: '阿里通义千问',
    note: '走 compatible-mode 兼容端点；qwen-vl 系列可看图。',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    models: ['qwen-turbo', 'qwen-plus', 'qwen-max', 'qwen-vl-plus'],
    vision: true,
    keyHint: '在 dashscope.console.aliyun.com 创建 DashScope API Key。',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    note: '一家聚合多家开源模型，价格通常更低。',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
    models: ['Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-V3'],
    vision: false,
    keyHint: '在 cloud.siliconflow.cn 创建 API Key。',
  },
  {
    id: 'volcengine',
    label: '火山方舟（豆包）',
    note: '需要用「接入点 ID」当模型名，不是模型本名。',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: '',
    models: [],
    vision: true,
    modelMustBeFilled: true,
    keyHint:
      '在火山方舟控制台创建推理接入点，把「接入点 ID」（ep- 开头）填到模型名一栏，而不是 doubao-xxx。',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    note: '国内直连通常不通，一般需要自备代理地址。',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o'],
    vision: true,
    keyHint: '在 platform.openai.com 创建 API Key。若在国内，请在下方改用可用的代理地址。',
  },
  {
    id: CUSTOM_PROVIDER_ID,
    label: '自定义 / 中转站 / agent 平台',
    note: '任何 OpenAI 兼容端点都能填。agent 平台（如 WorkBuddy）的自定义模型端点、各类中转站都走这里。',
    baseUrl: '',
    defaultModel: '',
    models: [],
    vision: false,
    keyHint:
      '填对方提供的「接口地址」和「API Key」。地址填到 /v1 为止（不要带 /chat/completions），软件会自己补。',
  },
];

/** 按 id 找预设；找不到返回 null（旧数据里的 provider 可能已不在清单里）。 */
export function findPreset(id: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * 判断这个名字是不是「自动填的」（而非用户自己起的）。
 *
 * 用在「切换服务商时要不要改名字」这个判断上。除了比对预设 label 本身，
 * 还要认几个历史别名：早期版本把 DeepSeek 的默认名写成过 `DeepSeek`，
 * 而预设 label 后来改成了 `DeepSeek 深度求索`。老用户库里存的是旧名，
 * 若不认这个别名，他切到智谱后名字会停在「DeepSeek」，
 * 而地址已经变成智谱 —— 卡片写着 DeepSeek、实际发去智谱，比报错更难查。
 */
const LEGACY_LABELS: Record<string, string[]> = {
  deepseek: ['DeepSeek', '深度求索'],
};

export function isPresetLabel(label: string, providerId: string): boolean {
  const trimmed = label.trim();
  if (!trimmed) return true;

  const preset = findPreset(providerId);
  if (preset && trimmed === preset.label) return true;

  return (LEGACY_LABELS[providerId] ?? []).includes(trimmed);
}

/**
 * 按服务商预设取一套「开箱可用」的配置。
 *
 * 切换服务商时用它一次性拿到地址与模型，避免出现
 * 「地址换了但模型还是别家的」这种半新半旧的状态。
 */
export function presetDefaults(providerId: string): { label: string; baseUrl: string; model: string } | null {
  const preset = findPreset(providerId);
  if (!preset) return null;
  return { label: preset.label, baseUrl: preset.baseUrl, model: preset.defaultModel };
}

/**
 * 猜一个后端配置该怎么调用。
 *
 * 旧数据的 provider 可能是任意字符串（用户手填的），这里统一处理：
 *   - 认得出来的预设 → 用预设的兼容性标记
 *   - 认不出来的 → 按标准 OpenAI 兼容处理（这是最通用的假设）
 */
export function resolveCompat(provider: string): { jsonMode: boolean; vision: boolean } {
  const preset = findPreset(provider);
  if (!preset) return { jsonMode: true, vision: false };
  return { jsonMode: !preset.jsonModeUnsupported, vision: preset.vision };
}

/**
 * 把用户填的 baseUrl 归一成「可以直接拼 /chat/completions」的形式。
 *
 * 用户输入的真实情况比想象中乱：
 *   `https://api.deepseek.com`                    → 原样
 *   `https://api.deepseek.com/`                   → 去尾斜杠
 *   `https://api.deepseek.com/v1`                 → 原样（部分服务要 /v1）
 *   `https://api.deepseek.com/v1/chat/completions` → **去掉尾巴**
 *   `https://api.deepseek.com/chat/completions`    → **去掉尾巴**
 *
 * 最后两种是真实高频错误：很多文档直接给完整端点，用户就整段粘进来，
 * 我们再加一次 /chat/completions 就变成 .../chat/completions/chat/completions → 404。
 * 与其让用户自己发现，不如在这里吃掉。
 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return '';
  // 去掉所有末尾斜杠
  url = url.replace(/\/+$/, '');
  // 去掉用户误粘进来的完整路径尾巴
  url = url.replace(/\/chat\/completions$/i, '');
  url = url.replace(/\/completions$/i, '');
  return url.replace(/\/+$/, '');
}

import { useEffect, useMemo, useState } from 'react';
import type {
  GenerateQuestionsOptions,
  QuestionBackend,
  QuestionSourcePoint,
} from '@/core/questions/backend-types.ts';
import { MockQuestionBackend } from '@/core/questions/mock-backend.ts';
import { DeepSeekQuestionBackend as ModelQuestionBackend } from '@/core/questions/deepseek-backend.ts';
import { findPreset } from '@/core/ai/presets.ts';
import type { BackendService, BackendView } from '@/core/backends.ts';

/**
 * 出题后端选择器：决定「用哪个后端出题」。
 *
 * 写法**参照** P2 的 `use-organize-backend.ts`，但刻意自己写一份，
 * 不 import 它的私有逻辑（那是知识点页的文件域，且两个后端的接口不同：
 * `OrganizeBackend.estimateTokens(segments)` vs
 * `QuestionBackend.estimateTokens(points, options)`）。
 *
 * ## 为什么必须是懒加载
 *
 * 真实后端的 API Key 存在 `secrets` 分区里，只能异步读。如果在组件里
 * 一次性读出来塞进构造函数：
 *
 *   1. 首次渲染时 key 还没读到，后端拿着空 key 被创建出来，
 *      用户点了「开始出题」才发现不对；
 *   2. key 会以明文长期留在组件状态里 —— 一旦有人加一句 console.log
 *      调试就泄露了。
 *
 * 所以做成「每次 generate 调用时才读 key，用完即弃」。
 * 组件状态里只保存「用户选了哪个后端」，从不保存 key 本身。
 */

export interface QuestionBackendOption {
  /** 稳定标识，用于下拉框选中 */
  key: string;
  label: string;
  /** 一句话说明，界面上显示 */
  note: string;
  /** 能不能用；false 时下拉框该项禁用并显示原因 */
  available: boolean;
  /** 不可用的原因 */
  reason?: string;
}

export interface UseQuestionBackendResult {
  /** 当前生效的后端实例 */
  backend: QuestionBackend;
  options: QuestionBackendOption[];
  selected: string;
  select: (key: string) => void;
  /** 当前选中后端的说明，用于提示「你在用真模型，会花钱」 */
  activeNote: string;
  /** 是否是真的会消耗额度的后端 */
  isRealModel: boolean;
  loading: boolean;
  loadError: string | null;
}

/** 假后端的固定 key */
const MOCK_KEY = 'mock';

export function useQuestionBackend(backendService: BackendService): UseQuestionBackendResult {
  const [list, setList] = useState<BackendView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(MOCK_KEY);

  // 读已配置的后端列表
  useEffect(() => {
    let alive = true;
    backendService
      .list()
      .then((rows) => {
        if (!alive) return;
        setList(rows);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setList([]);
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [backendService]);

  const options = useMemo<QuestionBackendOption[]>(() => {
    const mockOption: QuestionBackendOption = {
      key: MOCK_KEY,
      label: '示例出题（离线，不联网）',
      note: '按机械规则从知识点里挖空、拼干扰项。不花钱、不联网，适合先跑通流程。它不是 AI 出的题。',
      available: true,
    };

    const real = (list ?? [])
      .filter((b) => b.kind === 'direct-api')
      .map<QuestionBackendOption>((b) => {
        const available = b.hasCredential && b.status === 'ready';

        let reason: string | undefined;
        if (!b.hasCredential) reason = '还没有填 API Key，去设置页填一下';
        else if (b.status !== 'ready')
          reason = `状态是「${statusLabel(b.status)}」，先在设置页确认配置`;

        return {
          key: b.id,
          label: b.label || 'DeepSeek',
          note: available
            ? `真实调用 ${b.model || 'default'}，会消耗你的 API 额度。`
            : '暂不可用',
          available,
          ...(reason ? { reason } : {}),
        };
      });

    return [mockOption, ...real];
  }, [list]);

  /**
   * 当前生效的后端。
   *
   * 对假后端直接返回实例；对真后端返回一个「调用时才去读 key」的包装。
   * 包装的 id/label/estimateTokens 与真后端保持一致，所以调用方看不出区别。
   */
  const backend = useMemo<QuestionBackend>(() => {
    if (selected === MOCK_KEY) return new MockQuestionBackend();

    const config = list?.find((b) => b.id === selected);
    // 配置被删掉了就退回假后端，避免界面卡在一个不存在的选择上
    if (!config) return new MockQuestionBackend();

    /**
     * 与 use-organize-backend 同样的多服务商映射：
     * provider 必须传下去，否则换服务商后模型名仍会写死成 deepseek-chat。
     */
    const provider = config.provider || 'custom';
    const preset = findPreset(provider);
    const base = {
      provider,
      label: config.label || preset?.label || '模型 API 直连（出题）',
      model: config.model || preset?.defaultModel || 'deepseek-chat',
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    };

    return {
      id: config.id,
      label: base.label,
      isMock: false,
      // 界面手搓的对象，provider 漏了会让用量统计写成「未知服务商」
      provider,
      // 估算不需要真 key，直接借真后端的算法（它只用 points 与 count）
      estimateTokens: (points: QuestionSourcePoint[], opts: GenerateQuestionsOptions) =>
        new ModelQuestionBackend({ apiKey: 'estimation-only', ...base }).estimateTokens(
          points,
          opts,
        ),
      generate: async (points, opts) => {
        const apiKey = await backendService.readCredential(config.id);
        if (!apiKey) {
          throw new Error(
            '读不到这个后端的 API Key。请到设置页重新填一次并保存，然后回到这里重试。',
          );
        }
        // key 的明文只在这个作用域里存活到调用结束
        return new ModelQuestionBackend({ apiKey, ...base }).generate(points, opts);
      },
    };
  }, [selected, list, backendService]);

  const activeOption = options.find((o) => o.key === selected);

  return {
    backend,
    options,
    selected,
    select: setSelected,
    activeNote: activeOption?.note ?? '',
    isRealModel: selected !== MOCK_KEY,
    loading: list === null,
    loadError,
  };
}

function statusLabel(status: BackendView['status']): string {
  switch (status) {
    case 'ready':
      return '就绪';
    case 'unconfigured':
      return '未配置';
    case 'needs-login':
      return '需登录';
    case 'expired':
      return '已过期';
  }
}

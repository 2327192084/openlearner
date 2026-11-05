import { useEffect, useMemo, useState } from 'react';
import type { OrganizeBackend } from '@/core/knowledge/backend-types.ts';
import { MockBackend } from '@/core/knowledge/mock-backend.ts';
import { DeepSeekBackend as ModelBackend } from '@/core/ai/deepseek-backend.ts';
import { findPreset } from '@/core/ai/presets.ts';
import type { BackendService, BackendView } from '@/core/backends.ts';

/**
 * 后端选择器：决定「用哪个后端整理知识点」。
 *
 * ## 为什么要单独抽一个 hook
 *
 * 真实的 AI 后端需要从存储里异步读 API Key，而 `OrganizeBackend`
 * 是同步接口（`organize()` 里才真正用到 key）。如果在组件里直接把 key
 * 读出来塞进构造函数，会遇到两个问题：
 *
 *   1. 首次渲染时 key 还没读到，后端拿着空 key 被创建出来，
 *      用户点了「开始整理」才发现不对。
 *   2. key 会以明文长期留在组件状态里 —— 一旦有人加一句 console.log
 *      调试就泄露了。
 *
 * 所以做成「懒加载」：每次 organize 调用时才读 key，用完即弃。
 * 组件状态里只保存「用户选了哪个后端」，从不保存 key 本身。
 */

export interface BackendOption {
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

export interface UseOrganizeBackendResult {
  /** 当前生效的后端实例 */
  backend: OrganizeBackend;
  options: BackendOption[];
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

export function useOrganizeBackend(backendService: BackendService): UseOrganizeBackendResult {
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

  const options = useMemo<BackendOption[]>(() => {
    const mockOption: BackendOption = {
      key: MOCK_KEY,
      label: '示例后端（离线，不联网）',
      note: '从原文摘句子模拟整理结果。不花钱、不联网，适合先熟悉流程。',
      available: true,
    };

    const real = (list ?? [])
      .filter((b) => b.kind === 'direct-api')
      .map<BackendOption>((b) => {
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
  const backend = useMemo<OrganizeBackend>(() => {
    if (selected === MOCK_KEY) return new MockBackend();

    const config = list?.find((b) => b.id === selected);
    // 配置被删掉了就退回假后端，避免界面卡在一个不存在的选择上
    if (!config) return new MockBackend();

    /**
     * 把后端配置映射成调用参数。
     *
     * 这是「多服务商」真正落地的一环。以前不管用户配的是哪家，
     * 都构造 DeepSeekBackend 并写死模型默认值 `deepseek-chat` ——
     * 换成智谱后依然把 deepseek-chat 发过去，必然报「模型不存在」，
     * 而用户配的明明是另一家，很难联想到是代码写死了。
     *
     * 现在 provider 一并传下去：默认模型按服务商预设取，
     * 报错文案也会写上是哪一家出的问题。
     */
    const provider = config.provider || 'custom';
    const preset = findPreset(provider);
    const base = {
      provider,
      label: config.label || preset?.label || '模型 API 直连',
      // 用户填了就用用户的；没填用该服务商的默认模型
      model: config.model || preset?.defaultModel || 'deepseek-chat',
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    };

    return {
      id: config.id,
      label: base.label,
      isMock: false,
      // 估算不需要 key，直接借真后端的算法
      estimateTokens: (segments) =>
        new ModelBackend({ apiKey: 'estimation-only', ...base }).estimateTokens(segments),
      organize: async (request) => {
        const apiKey = await backendService.readCredential(config.id);
        if (!apiKey) {
          throw new Error(
            '读不到这个后端的 API Key。请到设置页重新填一次并保存，然后回到这里重试。',
          );
        }
        // key 的明文只在这个作用域里存活到调用结束
        return new ModelBackend({ apiKey, ...base }).organize(request);
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

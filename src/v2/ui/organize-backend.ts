import { useEffect, useMemo, useState } from 'react';
import type { OrganizeBackend } from '@/core/knowledge/backend-types.ts';
import { MockBackend } from '@/core/knowledge/mock-backend.ts';
import { ModelBackend } from '@/core/ai/deepseek-backend.ts';
import { findPreset } from '@/core/ai/presets.ts';
import type { BackendService, BackendView } from '@/core/backends.ts';

/**
 * 「用哪个后端整理知识点」的选择器。
 *
 * ## 为什么要单独抽一层
 *
 * 真后端要异步读 API Key，而 `OrganizeBackend` 是同步接口
 * （只在 `organize()` 里真正用到 key）。如果在组件里先把 key 读出来
 * 塞进构造函数，会有两个问题：
 *
 *   1. 首次渲染时 key 还没读到，后端拿着空 key 被创建出来，
 *      用户点了「开始整理」才发现不对；
 *   2. key 明文长期留在组件状态里，加一句 console.log 就泄露了。
 *
 * 所以做成懒加载：组件状态只保存「选了哪个后端」，
 * 每次 organize 调用时才读 key，用完即弃。
 *
 * 这一层是从 v1 的 src/pages/knowledge/use-organize-backend.ts 移植过来的 ——
 * 那里的每条注释都是踩过的坑，尤其「provider 必须原样传出来」。
 */

export interface BackendOption {
  key: string;
  label: string;
  note: string;
  available: boolean;
  reason?: string;
}

export interface UseOrganizeBackendResult {
  backend: OrganizeBackend;
  options: BackendOption[];
  selected: string;
  select: (key: string) => void;
  isRealModel: boolean;
  loading: boolean;
  loadError: string | null;
  /** 已配置的后端列表（界面要据此显示「先去设置页加一个」） */
  backends: BackendView[];
}

const MOCK_KEY = 'mock';

export function useOrganizeBackend(service: BackendService): UseOrganizeBackendResult {
  const [list, setList] = useState<BackendView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(MOCK_KEY);

  useEffect(() => {
    let alive = true;
    service
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
  }, [service]);

  const options = useMemo<BackendOption[]>(() => {
    const mock: BackendOption = {
      key: MOCK_KEY,
      label: '示例后端（离线，不联网）',
      note: '从原文里摘句子模拟整理结果。不花钱、不联网，适合先熟悉流程。',
      available: true,
    };

    const real = (list ?? [])
      .filter((b) => b.kind === 'direct-api')
      .map<BackendOption>((b) => {
        const available = b.hasCredential && b.status === 'ready';
        let reason: string | undefined;
        if (!b.hasCredential) reason = '还没有填 API Key，去设置页填一下';
        else if (b.status !== 'ready') reason = `状态是「${statusLabel(b.status)}」，先在设置页确认配置`;
        return {
          key: b.id,
          label: b.label || '模型后端',
          note: available
            ? `真实调用 ${b.model || 'default'}，会消耗你的 API 额度。`
            : '暂不可用',
          available,
          ...(reason ? { reason } : {}),
        };
      });

    return [mock, ...real];
  }, [list]);

  /**
   * 当前生效的后端。
   *
   * 假后端直接返回实例；真后端返回一个「调用时才读 key」的包装。
   * 包装的 id / label / estimateTokens 与真后端一致，调用方看不出区别。
   */
  const backend = useMemo<OrganizeBackend>(() => {
    if (selected === MOCK_KEY) return new MockBackend();

    const config = list?.find((b) => b.id === selected);
    // 配置被删掉了就退回假后端，避免界面卡在一个不存在的选择上
    if (!config) return new MockBackend();

    /**
     * provider 必须原样传下去。
     *
     * 这个对象是界面手搓的（不是 ModelBackend 实例），字段漏一个就是静默降级：
     * 用了真后端、花了钱，用量统计里却记成「未知服务商」。
     * v1 验收时就是这么发现的 —— 数字对、名字错，最容易被忽略。
     */
    const provider = config.provider || 'custom';
    const preset = findPreset(provider);
    const base = {
      provider,
      label: config.label || preset?.label || '模型 API 直连',
      model: config.model || preset?.defaultModel || 'deepseek-chat',
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    };

    return {
      id: config.id,
      label: base.label,
      isMock: false,
      provider,
      // 估算不需要 key，直接借真后端的算法
      estimateTokens: (segments) =>
        new ModelBackend({ apiKey: 'estimation-only', ...base }).estimateTokens(segments),
      organize: async (request) => {
        const apiKey = await service.readCredential(config.id);
        if (!apiKey) {
          throw new Error('读不到这个后端的 API Key。请到设置页重新填一次并保存，然后回到这里重试。');
        }
        // key 的明文只在这个作用域里存活到调用结束
        return new ModelBackend({ apiKey, ...base }).organize(request);
      },
    };
  }, [selected, list, service]);

  return {
    backend,
    options,
    selected,
    select: setSelected,
    isRealModel: selected !== MOCK_KEY,
    loading: list === null,
    loadError,
    backends: list ?? [],
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

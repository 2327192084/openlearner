import { useEffect, useMemo, useState } from 'react';
import { ModelOutlineBackend } from '@/core/slides/outline-backend.ts';
import type {
  GenerateOutlineOptions,
  OutlineBackend,
  OutlineInputPoint,
} from '@/core/slides/backend-types.ts';
import { findPreset } from '@/core/ai/presets.ts';
import type { BackendService, BackendView } from '@/core/backends.ts';

/**
 * PPT 大纲的后端选择器。
 *
 * ## 为什么这里没有「示例后端（离线）」那一项
 *
 * 知识点整理和出题都有假后端，是为了让整个流程能离线跑通、便于测试。
 * 但 PPT 这一层的定位不同：产品定位就是「接好 AI，用 AI 生成课件」，
 * 用户明确要求不要离线拼装的 PPT。
 *
 * 所以这里**只提供真后端**。没有配置任何后端时，界面直接拦住并说明
 * 该去设置页做什么 —— 而不是让人点下去，等一个假的「生成成功」。
 *
 * ## 与另外两个 hook 相同的安全约定
 *
 * key 不在组件状态里长期存活：每次 generate 时才读，用完即弃。
 * 组件只保存「用户选了哪个后端」。
 */

export interface OutlineBackendOption {
  key: string;
  label: string;
  note: string;
  available: boolean;
  reason?: string;
}

export interface UseOutlineBackendResult {
  /** 当前生效的后端；没有任何可用后端时为 null */
  backend: OutlineBackend | null;
  options: OutlineBackendOption[];
  selected: string;
  select: (key: string) => void;
  activeNote: string;
  /** 是否可以真正开始生成 */
  ready: boolean;
  /** 不可用的原因（给界面直接显示） */
  blockedReason: string | null;
  loading: boolean;
  loadError: string | null;
  estimateTokens: (points: OutlineInputPoint[], opts: GenerateOutlineOptions) => number;
}

export function useOutlineBackend(backendService: BackendService): UseOutlineBackendResult {
  const [list, setList] = useState<BackendView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');

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

  const options = useMemo<OutlineBackendOption[]>(() => {
    return (list ?? [])
      .filter((b) => b.kind === 'direct-api')
      .map<OutlineBackendOption>((b) => {
        const available = b.hasCredential && b.status === 'ready';

        let reason: string | undefined;
        if (!b.hasCredential) reason = '还没有填 API Key，去设置页填一下';
        else if (b.status !== 'ready') reason = `状态是「${statusLabel(b.status)}」，先在设置页确认配置`;

        return {
          key: b.id,
          label: b.label || '模型 API 直连',
          note: available
            ? `用 ${b.model || 'default'} 生成，会消耗你的 API 额度。`
            : '暂不可用',
          available,
          ...(reason ? { reason } : {}),
        };
      });
  }, [list]);

  /**
   * 默认选中第一个可用后端。
   *
   * 不默认选中不可用的那一项：那会让界面一进来就是「选了但用不了」的状态，
   * 用户会以为是自己点错了。
   */
  useEffect(() => {
    if (selected) return;
    const first = options.find((o) => o.available);
    if (first) setSelected(first.key);
  }, [options, selected]);

  const backend = useMemo<OutlineBackend | null>(() => {
    const config = list?.find((b) => b.id === selected);
    if (!config) return null;

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
      // provider 必须原样传出来，否则用量统计会写成「未知服务商」
      provider,
      // 估算不需要真 key
      estimateTokens: (points, opts) =>
        new ModelOutlineBackend({ apiKey: 'estimation-only', ...base }).estimateTokens(
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
        return new ModelOutlineBackend({ apiKey, ...base }).generate(points, opts);
      },
    };
  }, [selected, list, backendService]);

  const activeOption = options.find((o) => o.key === selected);

  const blockedReason = (() => {
    if (list === null) return '正在读取已配置的后端…';
    if (options.length === 0) {
      return '还没有配置 AI 后端。这个功能需要用 AI 生成大纲，请先到「设置」页添加一个后端并填上 API Key。';
    }
    const active = options.find((o) => o.key === selected);
    if (!active) {
      // 有后端但一个都不可用
      const reason = options[0]?.reason;
      return reason
        ? `没有可用的 AI 后端：${reason}`
        : '没有可用的 AI 后端，请先到「设置」页确认配置。';
    }
    if (!active.available) {
      return `选中的后端现在不可用：${active.reason ?? '请到设置页确认配置'}`;
    }
    return null;
  })();

  return {
    backend,
    options,
    selected,
    select: setSelected,
    activeNote: activeOption?.note ?? '',
    ready: blockedReason === null && backend !== null,
    blockedReason,
    loading: list === null,
    loadError,
    estimateTokens: (points, opts) =>
      backend ? backend.estimateTokens(points, opts) : 0,
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

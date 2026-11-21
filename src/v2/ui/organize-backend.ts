import { useEffect, useMemo, useState } from 'react';
import type { OrganizeBackend } from '@/core/knowledge/backend-types.ts';
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
 *
 * ## ⚠️ 2026-11-21 深夜：删掉了「示例后端（离线）」这个选项
 *
 * 用户原话：「这个示例后端的按钮删掉，没有作用」。
 *
 * 起因是我自己踩的坑：接到「重新整理旧知识点」的指令后，我点开整理页、
 * 直接点了「开始整理」，**没注意默认选中的是示例后端**。结果：
 *  - 它根本不发请求（`MockBackend` 从原文里摘句子），
 *    所以**完全没经过新提示词**，这次「重新整理」等于没做
 *  - 却真往库里写了 144 条带「【原文摘录·未经提炼】」前缀的碎片
 *    （用户原 50 条还在，因为 `clearBySourceAndBackend` 只清同后端的）
 *
 * ## 为什么删掉而不是加个提示
 *
 * 这个选项的唯一价值是「拔网线也能演示一遍流程」，
 * 代价却是**它长得和真后端一模一样、还被设为默认值**。
 * 一个会被误当成真跑、却悄悄不调模型、还往真实库里写数据的按钮，
 * 留着就是隐患 —— 加提示治不了「用户不会逐行读提示」。
 *
 * 如果以后确实需要演示模式，应该做成**显式的演示入口**
 * （独立的「体验流程」按钮），而不是混在后端下拉里当默认值。
 *
 * `MockBackend` 类本身**保留**（`mock-backend.ts`）——
 * 单测与 P2 验收还在用它，删掉会引起一大片测试要改。
 * 这里只是不再向用户暴露这个选项。
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

export function useOrganizeBackend(service: BackendService): UseOrganizeBackendResult {
  const [list, setList] = useState<BackendView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 选中的后端 id；null = 还没选（随后自动选第一个可用的） */
  const [selected, setSelected] = useState<string | null>(null);

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
    return (list ?? [])
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
  }, [list]);

  /**
   * 自动选一个后端（用户还没选时）。
   *
   * ## 为什么必须自动选
   *
   * 原来的默认值是示例后端，用户点下去至少「有反应」。
   * 现在没有示例后端了，如果进页面时 selected 是 null，
   * 「开始整理」按钮会一直是禁用状态 —— 用户会以为功能坏了。
   *
   * 所以挑第一个**可用**的（有 Key 且状态就绪）。
   * 一个可用的都没有时保持 null，界面显示「先去设置页加后端」。
   */
  useEffect(() => {
    if (selected !== null) return;
    if (options.length === 0) return;
    const firstReady = options.find((o) => o.available);
    if (firstReady) setSelected(firstReady.key);
  }, [selected, options]);

  /**
   * 当前生效的后端。
   *
   * 真后端返回一个「调用时才读 key」的包装。
   * 包装的 id / label / estimateTokens 与真后端一致，调用方看不出区别。
   *
   * ⚠️ 配置被删掉时**不再静默换成示例后端**（那个已经删了）。
   * 现在返回一个「调用时才抛错」的占位 —— 比悄悄换成别的好：
   * 悄悄换会让用户以为用的是 A、其实是 B。
   */
  const backend = useMemo<OrganizeBackend>(() => {
    const config = selected === null ? undefined : list?.find((b) => b.id === selected);
    if (!config) return missingBackend();

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
    selected: selected ?? '',
    select: setSelected,
    /* 没有示例后端了 —— 只要选中了就一定是真模型 */
    isRealModel: selected !== null,
    loading: list === null,
    loadError,
    backends: list ?? [],
  };
}

/**
 * 「没有可用后端」时的占位实现。
 *
 * ## 为什么要有它
 *
 * `OrganizeBackend` 是同步接口，`OrganizePage` 渲染时就要拿到它。
 * 返回一个把错误推迟到 `organize()` 才抛的对象，界面能正常渲染，
 * 用户点「开始整理」时才拿到明确的下一步（去设置页加后端），
 * 而不是空指针崩掉或静默跑了一个假后端。
 */
function missingBackend(): OrganizeBackend {
  const message = '还没有选后端，或者一个可用的后端都没有。先到「设置 → 模型与出题」里加一个。';
  return {
    id: '',
    label: '（未选择后端）',
    isMock: false,
    provider: 'custom',
    estimateTokens: () => 0,
    organize: async () => {
      throw new Error(message);
    },
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
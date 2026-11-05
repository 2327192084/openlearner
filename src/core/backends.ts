import { newId, nowIso } from './id.ts';
import type { BackendConfig } from './model.ts';
import type { SecretRecord, StorageAdapter } from './storage/types.ts';
import { findPreset } from './ai/presets.ts';

/** 新建后端时的用户输入（不含 id/时间戳/状态） */
export interface BackendDraft {
  label: string;
  kind: 'direct-api' | 'agent-app';
  provider: string;
  baseUrl: string;
  model: string;
  capabilities: BackendConfig['capabilities'];
}

/**
 * 已配置后端的只读视图。
 *
 * 刻意**不含 apiKey**：界面上任何地方都不该拿到明文凭据，
 * 需要它的时候只有真实调用那一刻（P5）才单独取。
 * 这样「凭据不出现在界面截图」就不依赖写界面时记得别渲染。
 */
export interface BackendView extends BackendConfig {
  /** 是否已保存凭据 */
  hasCredential: boolean;
  /** 脱敏后的凭据尾号，用于让用户确认「存的是哪一把」 */
  credentialHint: string | null;
}

/**
 * 新建后端时的默认值。
 *
 * `label` 刻意与 `PRESETS` 里 DeepSeek 的 label 保持一致：
 * 界面切换服务商时，用「名字是否等于旧预设的 label」来判断
 * 这个名字是不是自动填的。两边不一致的话，一个从没改过名字的用户
 * 切到智谱后，名字会停在「DeepSeek」而地址已经变成智谱 ——
 * 卡片上写着 DeepSeek、实际发去智谱，比报错更难排查。
 */
export const DEFAULT_BACKEND_DRAFT: BackendDraft = {
  label: findPreset('deepseek')?.label ?? 'DeepSeek',
  kind: 'direct-api',
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  capabilities: { textOrganize: true, visionFormula: false, webSearch: false },
};

/**
 * AI 后端配置服务。
 *
 * P0 只做「录入界面 + 数据保存」，不联调（计划书 P0 第 4 条）。
 * 但存储契约现在就按 P5 的要求定死：凭据与配置分表，且判定可用状态。
 */
export class BackendService {
  constructor(private readonly storage: StorageAdapter) {}

  async list(): Promise<BackendView[]> {
    const [configs, secrets] = await Promise.all([
      this.storage.getAll('backends'),
      this.storage.getAll('secrets'),
    ]);
    const byBackend = new Map(secrets.map((s) => [s.backendId, s]));

    return configs
      .map((cfg) => {
        const secret = byBackend.get(cfg.id);
        return {
          ...cfg,
          hasCredential: Boolean(secret?.value),
          credentialHint: secret?.value ? maskCredential(secret.value) : null,
        };
      })
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label));
  }

  async get(id: string): Promise<BackendView | null> {
    const cfg = await this.storage.get('backends', id);
    if (!cfg) return null;
    const secrets = await this.storage.getAll('secrets');
    const secret = secrets.find((s) => s.backendId === id);
    return {
      ...cfg,
      hasCredential: Boolean(secret?.value),
      credentialHint: secret?.value ? maskCredential(secret.value) : null,
    };
  }

  /**
   * 新建或更新一个后端。
   *
   * credential 传 undefined 表示「不动已有凭据」——用户改模型名时
   * 不该被迫重填 Key。传空字符串则明确清除。
   */
  async save(
    draft: BackendDraft,
    opts: { id?: string; credential?: string } = {},
  ): Promise<BackendView> {
    const existing = opts.id ? await this.storage.get('backends', opts.id) : null;
    const ts = nowIso();
    const id = existing?.id ?? newId('backend');

    // 能力与状态由配置推导，而不是让用户手填「我可用」——
    // P5 要求界面在调用前告知可用性，状态必须反映真实配置。
    const status = deriveStatus(draft, opts.credential ?? null, existing != null);
    const nowHasCredential =
      opts.credential === undefined
        ? Boolean((await this.storage.getAll('secrets')).find((s) => s.backendId === id)?.value)
        : Boolean(opts.credential);

    const cfg: BackendConfig = {
      id,
      label: draft.label.trim() || draft.provider,
      kind: draft.kind,
      provider: draft.provider,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      capabilities: { ...draft.capabilities },
      status: nowHasCredential ? status : 'unconfigured',
      isDefault: existing?.isDefault ?? false,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };

    await this.storage.put('backends', cfg);

    if (opts.credential !== undefined) {
      await this.setCredential(id, opts.credential);
    }

    // 第一个后端自动成为默认，免得用户还要多点一次
    const all = await this.storage.getAll('backends');
    if (all.length === 1 && !all[0].isDefault) {
      await this.storage.put('backends', { ...all[0], isDefault: true });
    }

    return (await this.get(id))!;
  }

  /** 保存凭据。空字符串等于删除。 */
  async setCredential(backendId: string, value: string): Promise<void> {
    const existing = (await this.storage.getAll('secrets')).find(
      (s) => s.backendId === backendId,
    );
    const trimmed = value.trim();

    if (!trimmed) {
      if (existing) await this.storage.remove('secrets', existing.id);
      await this.refreshStatus(backendId);
      return;
    }

    const ts = nowIso();
    const record: SecretRecord = {
      id: existing?.id ?? newId('secret'),
      backendId,
      value: trimmed,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    await this.storage.put('secrets', record);
    await this.refreshStatus(backendId);
  }

  /**
   * 真实调用前才取凭据。
   * 刻意不在 list()/get() 里返回明文，减少误用的机会。
   */
  async readCredential(backendId: string): Promise<string | null> {
    const secrets = await this.storage.getAll('secrets');
    return secrets.find((s) => s.backendId === backendId)?.value ?? null;
  }

  async remove(id: string): Promise<void> {
    const existing = await this.storage.get('backends', id);
    await this.storage.remove('backends', id);

    // 配置删了，凭据不能留成孤儿——那是最容易被忘掉的垃圾数据
    const secrets = await this.storage.getAll('secrets');
    for (const s of secrets.filter((s) => s.backendId === id)) {
      await this.storage.remove('secrets', s.id);
    }

    // 删的是默认后端，就把剩下的第一个提为默认
    if (existing?.isDefault) {
      const rest = await this.storage.getAll('backends');
      if (rest.length > 0) {
        await this.storage.put('backends', { ...rest[0], isDefault: true });
      }
    }
  }

  async setDefault(id: string): Promise<void> {
    const all = await this.storage.getAll('backends');
    for (const cfg of all) {
      const shouldBeDefault = cfg.id === id;
      if (cfg.isDefault !== shouldBeDefault) {
        await this.storage.put('backends', { ...cfg, isDefault: shouldBeDefault });
      }
    }
  }

  private async refreshStatus(backendId: string): Promise<void> {
    const cfg = await this.storage.get('backends', backendId);
    if (!cfg) return;
    const hasCredential = Boolean(
      (await this.storage.getAll('secrets')).find((s) => s.backendId === backendId)?.value,
    );
    const next = cfg.kind === 'agent-app' ? cfg.status : hasCredential ? 'ready' : 'unconfigured';
    if (next !== cfg.status) {
      await this.storage.put('backends', { ...cfg, status: next, updatedAt: nowIso() });
    }
  }
}

/**
 * 由配置推导可用状态。
 *
 * agent-app 类型必须先登录（P5 的「需登录」），所以即使填了凭据也不是 ready；
 * direct-api 缺 Key 或基址就是 unconfigured，让界面能提前提示，而不是点了才报错。
 */
function deriveStatus(
  draft: BackendDraft,
  credential: string | null,
  isUpdate: boolean,
): BackendConfig['status'] {
  if (draft.kind === 'agent-app') {
    return 'needs-login';
  }
  if (credential !== null) {
    return credential.trim() ? 'ready' : 'unconfigured';
  }
  // 更新时没传凭据：状态由调用方随后按已存凭据刷新
  return isUpdate ? 'ready' : draft.baseUrl.trim() ? 'unconfigured' : 'unconfigured';
}

/**
 * 凭据脱敏。
 *
 * 只留尾 4 位，且短于 12 位的凭据一律不留尾巴——
 * 太短的 Key 露出 4 位可能就漏掉大半。
 */
export function maskCredential(value: string): string {
  if (value.length < 12) return '••••';
  return `••••${value.slice(-4)}`;
}

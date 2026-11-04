import { useCallback, useEffect, useState } from 'react';
import { Badge, Notice } from '@/components/states.tsx';
import { useServices } from '@/app/services-context.ts';
import { DEFAULT_BACKEND_DRAFT, type BackendDraft, type BackendView } from '@/core/backends.ts';
import { testConnection, type ConnectionTestResult } from '@/core/ai/deepseek-backend.ts';
import './backend.css';

type Flash = { tone: 'info' | 'warning' | 'danger'; text: string } | null;

/** 可用状态到界面文案/颜色的映射。P5 要求调用前就告知，所以状态要一直可见。 */
const STATUS_LABEL: Record<BackendView['status'], { text: string; tone: 'ready' | 'neutral' | 'planned' | 'danger' }> = {
  ready: { text: '就绪', tone: 'ready' },
  unconfigured: { text: '未配置', tone: 'neutral' },
  'needs-login': { text: '需登录', tone: 'planned' },
  expired: { text: '已过期', tone: 'danger' },
};

/**
 * AI 后端配置区（P0 只做录入与保存）。
 *
 * 两条硬性约束落实在这里：
 *  1. 凭据一旦保存就不回显明文，输入框始终为空，只显示脱敏尾号
 *     —— 界面截图泄露凭据是最容易发生也最难事后补救的事故。
 *  2. 能力与可用状态由配置推导并常显，不做「点了才发现不能用」。
 */
export function BackendSection({
  onFlash,
  onChanged,
}: {
  onFlash: (v: Flash) => void;
  /**
   * 后端增删后通知设置页刷新统计。
   *
   * 不加这个回调的话，页面上「库内记录 · 后端 N」会在加了后端之后仍显示 0，
   * 属于界面说谎——比不显示更糟，因为用户会以为没保存上。
   */
  onChanged?: () => void;
}) {
  const { backends: backendService } = useServices();
  const [list, setList] = useState<BackendView[] | null>(null);
  const [editing, setEditing] = useState<BackendView | 'new' | null>(null);

  /** 正在测试连接的后端 id（null 表示没有在测试） */
  const [testingId, setTestingId] = useState<string | null>(null);
  /** 最近一次测试结果，按后端 id 存，卡片上直接显示 */
  const [testResults, setTestResults] = useState<Record<string, ConnectionTestResult>>({});

  const refresh = useCallback(async () => {
    setList(await backendService.list());
  }, [backendService]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 测试连接。
   *
   * 做三件事，缺一不可：
   *   1. 从存储里取出这把 key（界面上从不持有明文）
   *   2. 发一个 token 极少的最小请求
   *   3. 把结果**按后端逐条**显示在卡片上，而不是只弹一个总提示 ——
   *      用户可能配了多个后端，得知道是哪一个不行。
   */
  const handleTest = async (target: BackendView) => {
    setTestingId(target.id);
    try {
      const apiKey = await backendService.readCredential(target.id);
      if (!apiKey) {
        setTestResults((prev) => ({
          ...prev,
          [target.id]: {
            ok: false,
            failure: {
              code: 'invalid-key',
              message: '读不到这把 Key',
              hint: '请点「编辑」重新填一次 API Key 并保存，然后重试。',
            },
          },
        }));
        return;
      }

      const result = await testConnection({
        apiKey,
        model: target.model || 'deepseek-chat',
        ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
      });

      setTestResults((prev) => ({ ...prev, [target.id]: result }));

      if (result.ok) {
        onFlash({
          tone: 'info',
          text: `「${target.label}」连接正常（${result.model ?? 'ok'}，${result.latencyMs ?? 0} ms）`,
        });
      } else {
        onFlash({
          tone: 'danger',
          text: `「${target.label}」连接失败：${result.failure?.message ?? '未知原因'}`,
        });
      }
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [target.id]: {
          ok: false,
          failure: {
            code: 'unknown',
            message: err instanceof Error ? err.message : String(err),
            hint: '遇到未预期的问题。检查接口地址是否为 https://api.deepseek.com。',
          },
        },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (target: BackendView) => {
    const ok = window.confirm(
      `删除后端「${target.label}」？\n\n已保存的 API Key 会一并删除，资料和已生成的内容不受影响。`,
    );
    if (!ok) return;
    await backendService.remove(target.id);
    onFlash({ tone: 'info', text: `已删除后端「${target.label}」` });
    await refresh();
    onChanged?.();
  };

  const handleSetDefault = async (target: BackendView) => {
    await backendService.setDefault(target.id);
    onFlash({ tone: 'info', text: `默认后端已切换为「${target.label}」` });
    await refresh();
  };

  return (
    <section className="card">
      <div className="card__head">
        <div>
          <div className="card__title">AI 后端</div>
          <div className="card__subtitle">
            录入后存在本机，P0 阶段不会发出任何请求。Key 只保存在本机存储里，不进备份文件、不进导出。
          </div>
        </div>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={() => setEditing('new')}
          disabled={editing !== null}
        >
          添加后端
        </button>
      </div>

      <div className="card__body page__stack">
        {list === null ? (
          <div className="page__muted">载入中…</div>
        ) : list.length === 0 ? (
          <Notice tone="info" title="还没有配置后端">
            没有后端也能用：资料阅读、错题归集、导出这些功能不依赖 AI。等你准备生成知识点或出题时再来配置即可。
          </Notice>
        ) : (
          <ul className="backend-list">
            {list.map((item) => {
              const status = STATUS_LABEL[item.status];
              return (
                <li key={item.id} className="backend-item">
                  <div className="backend-item__main">
                    <div className="backend-item__title">
                      <strong>{item.label}</strong>
                      {item.isDefault ? <Badge tone="info">默认</Badge> : null}
                      <Badge tone={status.tone}>{status.text}</Badge>
                      {item.kind === 'agent-app' ? <Badge tone="neutral">agent 应用</Badge> : null}
                    </div>
                    <div className="backend-item__meta">
                      <span className="page__mono">{item.model || '未填模型'}</span>
                      <span className="backend-item__sep">·</span>
                      <span className="page__mono">{item.baseUrl || '未填地址'}</span>
                    </div>
                    <div className="backend-item__caps">
                      <Capability on={item.capabilities.textOrganize} label="文字整理" />
                      <Capability on={item.capabilities.visionFormula} label="看图识公式" />
                      <Capability on={item.capabilities.webSearch} label="联网检索" />
                      <span className="backend-item__sep">·</span>
                      <span className="page__muted">
                        {item.hasCredential ? `凭据 ${item.credentialHint}` : '未保存凭据'}
                      </span>
                    </div>
                    {/*
                      测试结果就地显示在该后端下方，而不是只弹一个全局提示。
                      配了多个后端时，用户需要知道「是哪一个不行、为什么」。
                    */}
                    {testResults[item.id] ? (
                      <TestResultLine result={testResults[item.id]} />
                    ) : null}
                  </div>
                  <div className="backend-item__actions">
                    {!item.isDefault ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => void handleSetDefault(item)}
                        disabled={editing !== null}
                      >
                        设为默认
                      </button>
                    ) : null}
                    {/*
                      测试连接：发一个最小请求验证 key 真的能用。
                      计划书 P5 要求「界面在调用前就告知可用性，不做点了才发现不能用」，
                      这个按钮就是那条要求的落点。
                    */}
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void handleTest(item)}
                      disabled={editing !== null || testingId !== null || !item.hasCredential}
                      title={
                        item.hasCredential
                          ? '发一个最小请求验证这把 Key 能用'
                          : '先填 API Key 才能测试'
                      }
                    >
                      {testingId === item.id ? '测试中…' : '测试连接'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setEditing(item)}
                      disabled={editing !== null}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm btn--danger"
                      onClick={() => void handleDelete(item)}
                      disabled={editing !== null}
                    >
                      删除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {editing !== null ? (
          <BackendForm
            initial={editing === 'new' ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={async (msg) => {
              setEditing(null);
              onFlash({ tone: 'info', text: msg });
              await refresh();
              onChanged?.();
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

function Capability({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={`cap${on ? ' cap--on' : ''}`}>
      <span aria-hidden="true">{on ? '✓' : '—'}</span>
      {label}
    </span>
  );
}

/**
 * 新增/编辑表单。
 *
 * 凭据输入刻意用 type="password" 且**不回填**：
 * 用户打开编辑页时看到空框，代表「不改就不动」，而不是「Key 丢了」——
 * 文案里写清楚这一点，否则用户会以为需要重填。
 */
function BackendForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial: BackendView | null;
  onCancel: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const { backends: backendService } = useServices();
  const [draft, setDraft] = useState<BackendDraft>(() =>
    initial
      ? {
          label: initial.label,
          kind: initial.kind,
          provider: initial.provider,
          baseUrl: initial.baseUrl,
          model: initial.model,
          capabilities: { ...initial.capabilities },
        }
      : { ...DEFAULT_BACKEND_DRAFT, capabilities: { ...DEFAULT_BACKEND_DRAFT.capabilities } },
  );
  const [credential, setCredential] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setField = <K extends keyof BackendDraft>(key: K, value: BackendDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const setCap = (key: keyof BackendDraft['capabilities'], value: boolean) =>
    setDraft((d) => ({ ...d, capabilities: { ...d.capabilities, [key]: value } }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!draft.label.trim()) {
      setError('给这个后端起个名字，方便在界面上区分');
      return;
    }
    if (draft.kind === 'direct-api' && !draft.baseUrl.trim()) {
      setError('模型 API 直连需要填写接口地址');
      return;
    }

    setSaving(true);
    try {
      const saved = await backendService.save(initial ? draft : { ...draft }, {
        ...(initial ? { id: initial.id } : {}),
        // 新建时即使留空也显式传，让状态落成 unconfigured 而不是含糊的默认值
        credential: initial ? (credential ? credential : undefined) : credential,
      });
      await onSaved(
        initial
          ? `后端「${saved.label}」已更新`
          : `后端「${saved.label}」已添加${saved.hasCredential ? '，凭据已保存' : '，尚未填凭据'}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="backend-form" onSubmit={(e) => void handleSubmit(e)}>
      <div className="backend-form__head">
        <div className="page__section-title">{initial ? '编辑后端' : '添加后端'}</div>
        <div className="page__muted">
          这一页只保存配置，不会验证 Key 是否有效。真正的连通性检查在 P5 联调时做。
        </div>
      </div>

      <div className="backend-form__grid">
        <div className="field">
          <label className="field__label" htmlFor="bf-label">
            名称
          </label>
          <input
            id="bf-label"
            className="input"
            value={draft.label}
            onChange={(e) => setField('label', e.target.value)}
            placeholder="DeepSeek"
            maxLength={40}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="bf-kind">
            接入方式
          </label>
          <select
            id="bf-kind"
            className="select"
            value={draft.kind}
            onChange={(e) => setField('kind', e.target.value as BackendDraft['kind'])}
          >
            <option value="direct-api">模型 API 直连（填自己的 Key）</option>
            <option value="agent-app">agent 应用接入（登录第三方平台）</option>
          </select>
          <div className="field__hint">
            {draft.kind === 'direct-api'
              ? '无条件可用的主干路径。推荐 DeepSeek，也可换任何 OpenAI 兼容服务。'
              : '需要先在第三方平台登录，状态会显示「需登录」，直到 P5 完成对接。'}
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="bf-base">
            接口地址
          </label>
          <input
            id="bf-base"
            className="input input--mono"
            value={draft.baseUrl}
            onChange={(e) => setField('baseUrl', e.target.value)}
            placeholder="https://api.deepseek.com"
            disabled={draft.kind === 'agent-app'}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="bf-model">
            模型
          </label>
          <input
            id="bf-model"
            className="input input--mono"
            value={draft.model}
            onChange={(e) => setField('model', e.target.value)}
            placeholder="deepseek-chat"
          />
        </div>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="bf-key">
          API Key
        </label>
        <input
          id="bf-key"
          className="input input--mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={credential}
          onChange={(e) => setCredential(e.target.value)}
          placeholder={initial?.hasCredential ? '已保存，留空则保持不变' : '粘贴你的 API Key'}
        />
        <div className="field__hint">
          {initial?.hasCredential
            ? `当前已保存凭据 ${initial.credentialHint}。留空表示不修改；填新值会覆盖；填一个空格后删除则该行不生效，请用「删除后端」清除凭据。`
            : '只保存在本机，不会写进导出文件。出于安全考虑，保存后不再回显明文。'}
        </div>
      </div>

      <fieldset className="backend-form__caps">
        <legend className="field__label">这个后端支持的能力</legend>
        <div className="backend-form__caps-row">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.capabilities.textOrganize}
              onChange={(e) => setCap('textOrganize', e.target.checked)}
            />
            文字整理
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.capabilities.visionFormula}
              onChange={(e) => setCap('visionFormula', e.target.checked)}
            />
            看图识公式
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.capabilities.webSearch}
              onChange={(e) => setCap('webSearch', e.target.checked)}
            />
            联网检索
          </label>
        </div>
        <div className="field__hint">
          如实勾选。界面会在调用前告知能力，勾了但实际不支持会让用户在生成中途卡住。
        </div>
      </fieldset>

      {error ? <div className="field__error">{error}</div> : null}

      <div className="backend-form__actions">
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          取消
        </button>
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  );
}

/**
 * 一行测试结果。
 *
 * 失败时必须显示 hint（下一步能做什么），不能只说「失败」——
 * 这是 P1 就定下的规则，界面上一律遵守。
 */
function TestResultLine({ result }: { result: ConnectionTestResult }) {
  if (result.ok) {
    return (
      <div className="backend-item__test backend-item__test--ok">
        ✓ 连接正常
        {result.model ? ` · ${result.model}` : ''}
        {typeof result.latencyMs === 'number' ? ` · ${result.latencyMs} ms` : ''}
      </div>
    );
  }

  return (
    <div className="backend-item__test backend-item__test--fail">
      <strong>✗ {result.failure?.message ?? '连接失败'}</strong>
      {result.failure?.hint ? <div>{result.failure.hint}</div> : null}
    </div>
  );
}

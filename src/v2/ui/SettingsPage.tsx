import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, LibraryMeta } from '@/core/model.ts';
import { LIBRARY_SCHEMA_VERSION } from '@/core/model.ts';
import { LibraryError, backupFileName } from '@/core/library.ts';
import type { BackendDraft, BackendView } from '@/core/backends.ts';
import { DEFAULT_BACKEND_DRAFT } from '@/core/backends.ts';
import type { ConnectionTestResult } from '@/core/ai/deepseek-backend.ts';
import { testConnection } from '@/core/ai/deepseek-backend.ts';
import {
  CUSTOM_PROVIDER_ID,
  PROVIDER_PRESETS,
  findPreset,
  isPresetLabel,
} from '@/core/ai/presets.ts';
import { downloadBlob } from '@/pages/slides/download.ts';
import { HomeWidgetsEditor } from './HomeWidgetsEditor.tsx';
import { MaimemoSettings } from './MaimemoSettings.tsx';
import type { CardKind } from '@/v2/core/cards.ts';
import type { GradingRules, GradingStrictness } from '@/v2/core/grading.ts';
import {
  DEFAULT_GRADING_RULES,
  STRICTNESS_HINT,
  STRICTNESS_LABEL,
  isDefaultRules,
  normalizeGradingRules,
  strictnessFor,
} from '@/v2/core/grading.ts';
import { useServices } from '@/app/services-context.ts';
import { ConfirmDialog } from './dialog.tsx';

/**
 * 设置页。
 *
 * ## 为什么这一页优先做
 *
 * 出题页已经指向「设置」里添加后端，而这一页之前不存在 ——
 * 用户库里 0 道题，就是因为走到出题那一步被告知「先到设置里添加一个后端」，
 * 而设置里什么都没有。这一页的通路必须真能跑。
 *
 * ## 结构（借鉴 StudyHub 4.4.3 的 Settings.jsx，MIT）
 *
 * 左侧分类 + 右侧单面板。比一长条滚动好：用户来找的是某一件事，
 * 不是来通读的。分类只留三个 —— 学习库 / 模型 / 备份，
 * 没做的（主题、快捷键、导览）不摆空分类。
 *
 * ## 状态必须如实
 *
 * StudyHub 的 ModelStatus 分三档说清楚「填了 Key」≠「连接正常」。
 * 这里照做：卡片上只写「已保存凭据」，连通性要用户点「测试连接」才知道。
 * 不做「保存即成功」的假绿灯。
 */

type Category = 'library' | 'home' | 'grading' | 'model' | 'maimemo' | 'backup';

const CATEGORIES: { id: Category; label: string; group: string }[] = [
  { id: 'library', label: '学习库', group: '常用' },
  { id: 'home', label: '首页小组件', group: '常用' },
  { id: 'grading', label: '做题评分', group: '常用' },
  { id: 'model', label: '模型与出题', group: '常用' },
  /* 墨墨生词本（2026-11-09）：把阅读时遇到的新词送进已在用的背单词工具 */
  { id: 'maimemo', label: '墨墨生词本', group: '工具' },
  { id: 'backup', label: '备份与恢复', group: '数据' },
];

const STATUS_LABEL: Record<BackendView['status'], string> = {
  ready: '就绪',
  unconfigured: '未配置',
  'needs-login': '需登录',
  expired: '已过期',
};

/** 备份摘要里要数的那几个分区（顺序即显示顺序） */
const SUMMARY_STORES: { key: string; label: string }[] = [
  { key: 'courses', label: '课程' },
  { key: 'sources', label: '资料' },
  { key: 'knowledgePoints', label: '知识点' },
  { key: 'decks', label: '题组' },
  { key: 'questions', label: '题目' },
  { key: 'answerRecords', label: '作答' },
  { key: 'reviewLogs', label: '复习记录' },
  { key: 'slideDecks', label: '幻灯片' },
  { key: 'backends', label: '后端' },
];

export interface SettingsPageProps {
  /** 库名 / 后端变动后通知外层刷新顶栏与今日页 */
  onChanged: () => void;
}

type Flash = { tone: 'ok' | 'warn' | 'error'; text: string; hint?: string; offerReload?: boolean };

export function SettingsPage({ onChanged }: SettingsPageProps) {
  const { library, backends: backendsService } = useServices();

  const [cat, setCat] = useState<Category>('library');
  const [meta, setMeta] = useState<LibraryMeta | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [backends, setBackends] = useState<BackendView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [nextMeta, nextCounts, nextSettings] = await Promise.all([
        library.getMeta(),
        library.counts(),
        library.getSettings(),
      ]);
      setMeta(nextMeta);
      setCounts(nextCounts);
      setSettings(nextSettings);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [library]);

  const loadBackends = useCallback(async () => {
    try {
      setBackends(await backendsService.list());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [backendsService]);

  useEffect(() => {
    void load();
    void loadBackends();
  }, [load, loadBackends]);

  /** 库名或后端变化后：重读本页 + 让外层同步顶栏 */
  const refreshAll = useCallback(async () => {
    await load();
    await loadBackends();
    onChanged();
  }, [load, loadBackends, onChanged]);

  const readyCount = useMemo(
    () => backends.filter((b) => b.status === 'ready').length,
    [backends],
  );

  const groups = useMemo(() => {
    const out: { group: string; items: typeof CATEGORIES }[] = [];
    for (const c of CATEGORIES) {
      const hit = out.find((g) => g.group === c.group);
      if (hit) hit.items.push(c);
      else out.push({ group: c.group, items: [c] });
    }
    return out;
  }, []);

  return (
    <div className="settings-page">
      <header className="settings-head">
        <h1 className="settings-title">设置</h1>
        <p className="settings-lead">
          接入模型、管理学习库、导出备份。这里没有「一键优化」之类的开关 —— 只有确实生效的设置。
        </p>
      </header>

      {flash ? (
        <div
          className={`set-inline set-inline--${flash.tone}`}
          role={flash.tone === 'error' ? 'alert' : 'status'}
          style={{ marginBottom: 'var(--space-5)' }}
        >
          <span>{flash.text}</span>
          {flash.hint ? <span className="set-hint"> {flash.hint}</span> : null}
          {flash.offerReload ? (
            <>
              {' '}
              <button
                type="button"
                className="set-inline__action"
                onClick={() => window.location.reload()}
              >
                现在重新加载
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {groups.map((g) => (
            <div key={g.group}>
              <div className="settings-nav__group">{g.group}</div>
              {g.items.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="settings-nav__item"
                  aria-current={cat === c.id ? 'page' : undefined}
                  onClick={() => {
                    setCat(c.id);
                    setFlash(null);
                  }}
                >
                  {c.label}
                  {c.id === 'model' ? (
                    <span className="settings-nav__count">{readyCount}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="settings-panel">
          {loading ? (
            <p className="set-hint">正在读取学习库…</p>
          ) : loadError ? (
            <p className="set-inline set-inline--error" role="alert">
              读取失败：{loadError}
            </p>
          ) : cat === 'library' ? (
            <LibraryPane
              meta={meta}
              counts={counts}
              settings={settings}
              backends={backends}
              onRefresh={refreshAll}
              onFlash={setFlash}
            />
          ) : cat === 'home' ? (
            /*
              首页小组件（2026-11-08）。
              抽成独立组件而不是内联：这个文件已经 1400 行，
              而且项目对「往大文件里按行号插代码」有过明确教训
              （GeneratePage 的 CRLF/LF 混用，改坏过两次）。
            */
            <HomeWidgetsEditor
              load={async () => {
                const s = await library.getSettings();
                return (s as unknown as { homeWidgets?: unknown }).homeWidgets;
              }}
              save={async (widgets) => {
                await library.saveSettings({ homeWidgets: widgets });
              }}
              onSaved={() => {
                refreshAll();
                onChanged();
              }}
            />
          ) : cat === 'grading' ? (
            <GradingPane settings={settings} onRefresh={refreshAll} onFlash={setFlash} />
          ) : cat === 'model' ? (
            <ModelPane
              backends={backends}
              onRefresh={refreshAll}
              onFlash={setFlash}
            />
          ) : cat === 'maimemo' ? (
            /*
              墨墨生词本（2026-11-09）。
              抽成独立组件：这个文件已经 1400+ 行，而且项目对
              「往大文件里按行号插代码」有过明确教训。
            */
            <MaimemoSettings
              load={() => library.getSettings()}
              save={async (patch) => {
                await library.saveSettings(patch as Partial<AppSettings>);
              }}
              onSaved={() => {
                refreshAll();
                onChanged();
              }}
            />
          ) : (
            <BackupPane
              meta={meta}
              counts={counts}
              onRefresh={refreshAll}
              onFlash={setFlash}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================ 做题评分 ============================ */

/**
 * 计时评分规则设置。
 *
 * ## 为什么自定义只给「宽容度」三档，而不是让用户填秒数
 *
 * 评分先把「这道题正常要花多久」按题型与题干长度估出来，
 * 再看实际耗时是它的几倍。所以用户能调的只能是
 * 「判得松一点还是严一点」—— 填固定秒数会和「按题目长度归一」直接打架：
 * 用户填的数对某一道题合适，对另一道就不合适了。
 *
 * ## 为什么还要按题型单独设（C3）
 *
 * 有人读中文长句慢、算选择题快。一刀切会让他两边都不舒服：
 * 判松了选择题总是「一眼就会」，判严了简答永远「想久了」。
 * 所以每个题型可以单独覆盖总档，没覆盖的沿用总档。
 *
 * ## 界面必须给出「这套标准是什么」
 *
 * 只说「宽松/标准/严格」用户没有任何参照。所以下面把
 * 每一档在实际做题时的判定边界列出来（秒数按一道典型题算），
 * 让他能对上号。
 */
interface GradingPaneProps {
  settings: AppSettings | null;
  onRefresh: () => Promise<void>;
  onFlash: (f: Flash | null) => void;
}

/** 界面上展示的题型顺序与名字 */
const GRADING_KINDS: { kind: CardKind; label: string; example: string }[] = [
  { kind: 'single', label: '单选题', example: '30 字题干 + 4 个短选项' },
  { kind: 'multiple', label: '多选题', example: '同上，略慢一点' },
  { kind: 'blank', label: '填空题', example: '30 字题干' },
  { kind: 'short', label: '简答题', example: '60 字题干，要自己写' },
  { kind: 'point', label: '知识点', example: '100 字正文，只阅读' },
];

const STRICTNESS_OPTIONS: GradingStrictness[] = ['lenient', 'standard', 'strict'];

function GradingPane({ settings, onRefresh, onFlash }: GradingPaneProps) {
  const { library } = useServices();
  const [busy, setBusy] = useState(false);

  /*
   * 本地草稿。改完点「保存」才落库 —— 而不是改一下存一下。
   *
   * 理由：宽容度和别的设置不同，它直接影响复习间隔。
   * 用户拖来拖去试探时不该把每一次中间态都写进库。
   */
  const rules = useMemo(
    () => normalizeGradingRules(settings?.gradingRules),
    [settings?.gradingRules],
  );
  const [draft, setDraft] = useState<GradingRules>(rules);

  useEffect(() => {
    setDraft(rules);
  }, [rules]);

  const dirty =
    draft.strictness !== rules.strictness ||
    JSON.stringify(draft.perKind) !== JSON.stringify(rules.perKind);

  async function save() {
    setBusy(true);
    try {
      await library.saveSettings({ gradingRules: draft });
      await onRefresh();
      onFlash({ tone: 'ok', text: '评分标准已保存，下次做题就按这个判。' });
    } catch (err) {
      onFlash({
        tone: 'error',
        text: '保存失败',
        hint: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function resetToDefault() {
    setBusy(true);
    try {
      await library.saveSettings({ gradingRules: DEFAULT_GRADING_RULES });
      await onRefresh();
      onFlash({ tone: 'ok', text: '已恢复默认评分标准（标准宽容度）。' });
    } catch (err) {
      onFlash({
        tone: 'error',
        text: '恢复失败',
        hint: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  /** 覆盖某个题型：选「跟随总档」时从 perKind 里删掉这个键 */
  function setKindOverride(kind: CardKind, value: GradingStrictness | '') {
    setDraft((d) => {
      const perKind = { ...d.perKind };
      if (value === '') delete perKind[kind];
      else perKind[kind] = value;
      return { ...d, perKind };
    });
  }

  return (
    <>
      <div className="set-section">
        <h2 className="set-section__title">做题评分</h2>
        <p className="set-section__lead">
          做题时会自动计时。系统先按题型和题目长度估出「这道题大概要花多久」，
          再看你实际用了它的几倍，据此决定下次什么时候再考你。
        </p>
        <p className="set-hint">
          答错永远是「需要重来」，不看时间 —— 答错了就是没会。
          切到别的窗口时计时会暂停，那段时间不算。
        </p>
      </div>

      <div className="set-section">
        <h2 className="set-section__title">判得松还是严</h2>
        <p className="set-section__lead">
          这一档决定「多快算一眼就会、多慢算想久了」。它不会改变基准时长的算法，
          只改变判定的门槛。
        </p>
        <div className="grading-tiers">
          {STRICTNESS_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={`grading-tier${draft.strictness === s ? ' grading-tier--on' : ''}`}
              onClick={() => setDraft((d) => ({ ...d, strictness: s }))}
              aria-pressed={draft.strictness === s}
            >
              <span className="grading-tier__name">{STRICTNESS_LABEL[s]}</span>
              <span className="grading-tier__hint">{STRICTNESS_HINT[s]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="set-section">
        <h2 className="set-section__title">按题型单独设置</h2>
        <p className="set-section__lead">
          留空表示跟随上面的总档。常见用法：选择题判严一点（一眼就会才是真会），
          简答题判松一点（写字本来就花时间）。
        </p>
        <div className="grading-grid">
          {GRADING_KINDS.map(({ kind, label, example }) => (
            <label key={kind} className="set-field grading-row">
              <span className="set-label">
                {label}
                <span className="grading-row__eg">{example}</span>
              </span>
              <select
                className="set-select"
                value={draft.perKind[kind] ?? ''}
                onChange={(e) => setKindOverride(kind, e.target.value as GradingStrictness | '')}
              >
                <option value="">跟随总档（{STRICTNESS_LABEL[draft.strictness]}）</option>
                {STRICTNESS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {STRICTNESS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </div>

      <div className="set-section">
        <h2 className="set-section__title">各题型现在怎么判</h2>
        <p className="set-section__lead">
          每题都会按「题型 + 题目长度」各自归一，所以长题慢一点、短题快一点都算正常，
          不会被同一个秒数卡住。下表只说明每种题型当前落在哪一档。
        </p>
        {/*
          这里原来有一张「典型用时 / 快于这个算一眼就会 / 慢于这个算想久了」
          的秒数表。现在**去掉了秒数**：
          按题型和字数估出来的基准时长，用来做归一化可以，
          但当作「建议时长」摆给用户看是不可靠的（每道题、每个人的差异都很大）。
          改成只展示「这一档判得松还是严」，不再公布任何秒数。
        */}
        <table className="grading-table">
          <thead>
            <tr>
              <th>题型</th>
              <th>当前判定宽松度</th>
              <th>是否单独设置</th>
            </tr>
          </thead>
          <tbody>
            {GRADING_KINDS.map(({ kind, label }) => {
              const s = strictnessFor(kind, draft);
              const overridden = draft.perKind[kind] !== undefined;
              return (
                <tr key={kind}>
                  <td>{label}</td>
                  <td>
                    <span className={`grading-tag grading-tag--${s}`}>{STRICTNESS_LABEL[s]}</span>
                  </td>
                  <td>{overridden ? '是' : `跟随总档（${STRICTNESS_LABEL[draft.strictness]}）`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="set-hint">
          「宽松」更容易判成「一眼就会」，「严格」更容易判成「想久了」。
          判得最差也只到「想了一会儿」，不会因为你花的时间长就当成答错。
          切到别的窗口时计时暂停，中途离开不会被算进去。
        </p>
      </div>

      <div className="set-actions">
        <button type="button" className="btn-fill" onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? '保存中…' : '保存评分标准'}
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => void resetToDefault()}
          disabled={busy || isDefaultRules(rules)}
        >
          恢复默认
        </button>
        {dirty ? <span className="set-hint">有未保存的改动</span> : null}
      </div>
    </>
  );
}

/* ============================ 学习库 ============================ */

interface LibraryPaneProps {
  meta: LibraryMeta | null;
  counts: Record<string, number>;
  settings: AppSettings | null;
  backends: BackendView[];
  onRefresh: () => Promise<void>;
  onFlash: (f: Flash | null) => void;
}

function LibraryPane({ meta, counts, settings, backends, onRefresh, onFlash }: LibraryPaneProps) {
  const { library } = useServices();
  const [nameDraft, setNameDraft] = useState(meta?.name ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setNameDraft(meta?.name ?? '');
  }, [meta?.name]);

  const totalRecords = useMemo(
    () => Object.values(counts).reduce((sum, n) => sum + n, 0),
    [counts],
  );

  const create = async () => {
    setBusy(true);
    onFlash(null);
    try {
      const next = await library.create(nameDraft.trim() || '我的学习库');
      await onRefresh();
      onFlash({ tone: 'ok', text: `已创建学习库「${next.name}」。` });
    } catch (err) {
      onFlash({
        tone: 'error',
        text: err instanceof LibraryError ? err.message : '创建失败',
        hint: err instanceof LibraryError ? err.hint : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    const next = nameDraft.trim();
    if (!next || next === meta?.name) return;
    setBusy(true);
    onFlash(null);
    try {
      const updated = await library.rename(next);
      await onRefresh();
      onFlash({ tone: 'ok', text: `已改名为「${updated.name}」。` });
    } catch (err) {
      onFlash({
        tone: 'error',
        text: err instanceof LibraryError ? err.message : '改名失败',
        hint: err instanceof LibraryError ? err.hint : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  if (!meta) {
    return (
      <div className="set-section">
        <h2 className="set-section__title">还没有学习库</h2>
        <p className="set-section__lead">
          学习库是本机的一个数据库，资料、知识点、题目、复习记录都放在里面。
          它只存在这台电脑上，不会上传到任何地方。
        </p>
        <div className="set-grid">
          <label className="set-field">
            <span className="set-label">学习库名字</span>
            <input
              className="set-input"
              value={nameDraft}
              maxLength={40}
              placeholder="我的学习库"
              onChange={(e) => setNameDraft(e.target.value)}
            />
          </label>
        </div>
        <div className="set-actions">
          <button
            type="button"
            className="btn-fill btn-fill--sm"
            onClick={() => void create()}
            disabled={busy}
          >
            {busy ? '创建中…' : '创建学习库'}
          </button>
        </div>
        <p className="set-hint">
          已经有导出过的备份？也可以到「备份与恢复」里直接恢复，不用先建库。
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="set-section">
        <h2 className="set-section__title">学习库</h2>
        <p className="set-section__lead">
          名字只影响导出文件名和顶栏显示，不改动任何资料。
        </p>
        <div className="set-grid">
          <label className="set-field">
            <span className="set-label">名字</span>
            <input
              className="set-input"
              value={nameDraft}
              maxLength={40}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void rename();
              }}
            />
          </label>
        </div>
        <div className="set-actions">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => void rename()}
            disabled={busy || !nameDraft.trim() || nameDraft.trim() === meta.name}
          >
            {busy ? '保存中…' : '保存名字'}
          </button>
        </div>
      </div>

      <div className="set-section">
        <h2 className="set-section__title">库信息</h2>
        <dl className="set-kv">
          <dt>创建时间</dt>
          <dd>{formatTime(meta.createdAt)}</dd>
          <dt>最后更新</dt>
          <dd>{formatTime(meta.updatedAt)}</dd>
          <dt>结构版本</dt>
          <dd>
            v{meta.schemaVersion}
            {meta.schemaVersion < LIBRARY_SCHEMA_VERSION ? '（导入旧备份时会自动升级）' : ''}
          </dd>
          <dt>库内记录</dt>
          <dd>{totalRecords} 条</dd>
          <dt>明细</dt>
          <dd>{describeCounts(counts, backends.length)}</dd>
        </dl>
      </div>

      <div className="set-section">
        <h2 className="set-section__title">外观</h2>
        <p className="set-section__lead">
          现在只有深色书桌一种主题。浅色主题的样式已经写好，但还没接上切换入口 ——
          所以这里暂时没有选项，而不是放一个点了没反应的开关。
        </p>
        <p className="set-hint">
          数据存本机 IndexedDB，不联网、不回传。清浏览数据会把库一起清掉，记得定期导出备份。
        </p>
        {settings ? (
          <p className="set-hint">
            当前语言设置：界面 {settings.locale}，出题语言{' '}
            {settings.questionLanguage === 'zh' ? '中文' : 'English'}。
          </p>
        ) : null}
      </div>
    </>
  );
}

/* ============================ 模型 ============================ */

interface ModelPaneProps {
  backends: BackendView[];
  onRefresh: () => Promise<void>;
  onFlash: (f: Flash | null) => void;
}

interface FormState {
  id: string | null;
  draft: BackendDraft;
  credential: string;
}

function ModelPane({ backends, onRefresh, onFlash }: ModelPaneProps) {
  const { backends: service } = useServices();
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ConnectionTestResult>>({});
  const [deleting, setDeleting] = useState<BackendView | null>(null);

  const startNew = () => {
    setForm({ id: null, draft: { ...DEFAULT_BACKEND_DRAFT }, credential: '' });
    setFormError(null);
    onFlash(null);
  };

  const startEdit = (b: BackendView) => {
    setForm({
      id: b.id,
      draft: {
        label: b.label,
        kind: b.kind,
        provider: b.provider,
        baseUrl: b.baseUrl,
        model: b.model,
        capabilities: { ...b.capabilities },
      },
      // 已保存的 Key 永不回填到界面：连占位符都不显示真值
      credential: '',
    });
    setFormError(null);
    onFlash(null);
  };

  const handleTest = async (b: BackendView) => {
    setTestingId(b.id);
    onFlash(null);
    try {
      const apiKey = await service.readCredential(b.id);
      if (!apiKey) {
        setTestResults((prev) => ({
          ...prev,
          [b.id]: {
            ok: false,
            failure: {
              code: 'no-key',
              message: '读不到这把 Key',
              hint: '点「编辑」重新填一次 API Key 并保存，然后重试。',
            },
          },
        }));
        return;
      }
      const preset = findPreset(b.provider);
      const result = await testConnection({
        apiKey,
        model: b.model || preset?.defaultModel || 'deepseek-chat',
        provider: b.provider,
        baseUrl: b.baseUrl,
      });
      setTestResults((prev) => ({ ...prev, [b.id]: result }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [b.id]: {
          ok: false,
          failure: {
            code: 'unexpected',
            message: err instanceof Error ? err.message : String(err),
            hint: '这是界面这边出的错，不是你的 Key 的问题。换个浏览器窗口再试一次。',
          },
        },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const handleSave = async () => {
    if (!form) return;
    const { draft, credential, id } = form;
    if (!draft.baseUrl.trim()) {
      setFormError('接口地址不能为空。');
      return;
    }
    if (!draft.model.trim()) {
      setFormError('模型名不能为空。');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await service.save(draft, {
        id: id ?? undefined,
        // undefined = 不动已有凭据；新建时总是传（哪怕空串也算「没有」）
        credential: id ? (credential.trim() ? credential : undefined) : credential,
      });
      setForm(null);
      await onRefresh();
      onFlash({
        tone: 'ok',
        text: id ? `已更新「${draft.label}」。` : `已添加「${draft.label}」。`,
        hint: '可保存配置不代表 Key 有效 —— 点「测试连接」才真的发一次请求。',
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    await service.remove(deleting.id);
    setDeleting(null);
    await onRefresh();
    onFlash({
      tone: 'ok',
      text: `已删除「${deleting.label}」。`,
      hint: '同时删掉了它保存的 API Key。',
    });
  };

  return (
    <>
      <div className="set-section">
        <h2 className="set-section__title">已配置的模型</h2>
        <p className="set-section__lead">
          出题和整理知识点时用这里的模型。默认模型会被出题页直接选中。
        </p>

        {backends.length === 0 ? (
          <p className="set-inline">
            还没有配置后端。没有后端也能用：导入资料、复习已有题目、导出备份都不依赖 AI。
            等你要出题时再来加一个即可。
          </p>
        ) : (
          <ul className="set-list">
            {backends.map((b) => {
              const result = testResults[b.id];
              const preset = findPreset(b.provider);
              return (
                <li key={b.id} className="set-item">
                  <div className="set-item__main">
                    <div className="set-item__title">
                      <span>{b.label}</span>
                      {b.isDefault ? <span className="set-badge set-badge--default">默认</span> : null}
                      <span
                        className={
                          b.status === 'ready'
                            ? 'set-badge set-badge--ok'
                            : b.status === 'unconfigured'
                              ? 'set-badge set-badge--warn'
                              : 'set-badge'
                        }
                      >
                        {STATUS_LABEL[b.status]}
                      </span>
                      {b.kind === 'agent-app' ? <span className="set-badge">agent 应用</span> : null}
                    </div>
                    <div className="set-item__meta">
                      <span className="set-mono">{b.model || '未填模型'}</span>
                      <span className="set-mono">{b.baseUrl || '未填地址'}</span>
                      {preset ? <span>{preset.label}</span> : <span>自定义</span>}
                    </div>
                    <div className="set-item__caps">
                      <span>
                        凭据 {b.credentialHint ?? '未保存'}
                      </span>
                      <span>{b.capabilities.textOrganize ? '✓' : '—'} 文字整理</span>
                      <span>{b.capabilities.visionFormula ? '✓' : '—'} 看图识公式</span>
                    </div>
                    {result ? <TestResultLine result={result} /> : null}
                  </div>
                  <div className="set-item__actions">
                    {!b.isDefault ? (
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => {
                          void service.setDefault(b.id).then(onRefresh);
                        }}
                      >
                        设为默认
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => void handleTest(b)}
                      disabled={testingId !== null || form !== null || !b.hasCredential}
                      title={
                        !b.hasCredential
                          ? '还没有保存 API Key，测试连接会直接失败'
                          : form !== null
                            ? '先把正在编辑的表单关掉'
                            : '发一次真实请求，确认 Key 与地址可用'
                      }
                    >
                      {testingId === b.id ? '测试中…' : '测试连接'}
                    </button>
                    <button type="button" className="btn-ghost" onClick={() => startEdit(b)}>
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => setDeleting(b)}
                      disabled={form !== null}
                    >
                      删除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {form ? null : (
          <div className="set-actions">
            <button type="button" className="btn-ghost" onClick={startNew}>
              添加模型
            </button>
          </div>
        )}
      </div>

      {form ? (
        <BackendForm
          state={form}
          saving={saving}
          error={formError}
          onChange={setForm}
          onCancel={() => {
            setForm(null);
            setFormError(null);
          }}
          onSave={() => void handleSave()}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={`删除「${deleting.label}」？`}
          description="这个后端配置和它保存的 API Key 都会被删掉。已经生成的题目不受影响。"
          confirmLabel="删除"
          onConfirm={handleDelete}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </>
  );
}

function TestResultLine({ result }: { result: ConnectionTestResult }) {
  if (result.ok) {
    return (
      <p className="set-inline set-inline--ok">
        ✓ 连接正常 · {result.model ?? '未知模型'}
        {typeof result.latencyMs === 'number' ? ` · ${result.latencyMs} ms` : ''}
      </p>
    );
  }
  return (
    <p className="set-inline set-inline--error" role="alert">
      ✗ {result.failure?.message ?? '连接失败'}
      {result.failure?.hint ? <span className="set-hint"> {result.failure.hint}</span> : null}
    </p>
  );
}

interface BackendFormProps {
  state: FormState;
  saving: boolean;
  error: string | null;
  onChange: (s: FormState) => void;
  onCancel: () => void;
  onSave: () => void;
}

function BackendForm({ state, saving, error, onChange, onCancel, onSave }: BackendFormProps) {
  const { draft, credential, id } = state;
  const preset = findPreset(draft.provider);

  const patch = (next: Partial<BackendDraft>) => {
    onChange({ ...state, draft: { ...draft, ...next } });
  };

  const handleProviderChange = (providerId: string) => {
    const target = findPreset(providerId);
    if (!target || providerId === CUSTOM_PROVIDER_ID) {
      // 选「自定义」不清空已填的地址与模型 —— 用户常先试通再换中转站
      patch({ provider: providerId });
      return;
    }
    const keepLabel = isPresetLabel(draft.label, draft.provider);
    onChange({
      ...state,
      draft: {
        ...draft,
        provider: providerId,
        baseUrl: target.baseUrl,
        model: target.defaultModel,
        label: keepLabel ? target.label : draft.label,
        capabilities: { ...draft.capabilities, visionFormula: target.vision },
      },
    });
  };

  return (
    <form
      className="set-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="set-form__head">
        <h2 className="set-form__title">{id ? '编辑后端' : '添加后端'}</h2>
      </div>

      <div className="set-grid">
        <label className="set-field">
          <span className="set-label">服务商</span>
          <select
            className="set-select"
            value={draft.provider}
            onChange={(e) => handleProviderChange(e.target.value)}
          >
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {preset && draft.provider !== CUSTOM_PROVIDER_ID ? (
            <span className="set-hint">{preset.note}</span>
          ) : null}
        </label>

        <label className="set-field">
          <span className="set-label">名字</span>
          <input
            className="set-input"
            value={draft.label}
            maxLength={40}
            onChange={(e) => patch({ label: e.target.value })}
            placeholder="给自己看的名字"
          />
        </label>

        <label className="set-field">
          <span className="set-label">接入方式</span>
          <select
            className="set-select"
            value={draft.kind}
            onChange={(e) =>
              patch({ kind: e.target.value as BackendDraft['kind'] })
            }
          >
            <option value="direct-api">直连 API</option>
            {/* agent 应用需要登录流程，这里还没有；只在编辑既有记录时透出，避免新增 */}
            {state.draft.kind === 'agent-app' ? (
              <option value="agent-app">agent 应用（需登录）</option>
            ) : null}
          </select>
        </label>

        <label className="set-field">
          <span className="set-label">接口地址</span>
          <input
            className="set-input set-input--mono"
            value={draft.baseUrl}
            onChange={(e) => patch({ baseUrl: e.target.value })}
            placeholder="https://api.deepseek.com"
            spellCheck={false}
          />
          <span className="set-hint">填到 /v1 为止即可，不要带 /chat/completions（带了也会自动去掉）。</span>
        </label>

        <label className="set-field">
          <span className="set-label">模型名</span>
          <input
            className="set-input set-input--mono"
            value={draft.model}
            onChange={(e) => patch({ model: e.target.value })}
            placeholder={preset?.defaultModel ?? 'deepseek-chat'}
            list="set-model-suggestions"
            spellCheck={false}
          />
          <datalist id="set-model-suggestions">
            {(preset?.models ?? []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {preset?.modelMustBeFilled ? (
            <span className="set-hint">这个服务要求填推理接入点 ID（ep- 开头），不能填模型本名。</span>
          ) : null}
        </label>
      </div>

      <label className="set-field">
        <span className="set-label">API Key</span>
        <input
          className="set-input set-input--mono"
          type="password"
          value={credential}
          onChange={(e) => onChange({ ...state, credential: e.target.value })}
          placeholder={id ? '已保存，留空则保持不变' : 'sk-…'}
          autoComplete="off"
          spellCheck={false}
        />
        <span className="set-hint">
          {preset?.keyHint ?? '这把 Key 只存在本机数据库里，不会进备份文件、不会出现在日志里。'}
        </span>
      </label>

      <fieldset className="set-fieldset">
        <legend className="set-legend">这个后端支持的能力</legend>
        <div className="set-checks">
          <label className="set-check">
            <input
              type="checkbox"
              checked={draft.capabilities.textOrganize}
              onChange={(e) =>
                patch({ capabilities: { ...draft.capabilities, textOrganize: e.target.checked } })
              }
            />
            文字整理与出题
          </label>
          <label className="set-check">
            <input
              type="checkbox"
              checked={draft.capabilities.visionFormula}
              onChange={(e) =>
                patch({ capabilities: { ...draft.capabilities, visionFormula: e.target.checked } })
              }
            />
            看图识公式（多模态）
          </label>
        </div>
      </fieldset>

      {error ? (
        <p className="set-inline set-inline--error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="set-actions">
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={saving}>
          取消
        </button>
        <button type="submit" className="btn-fill btn-fill--sm" disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  );
}

/* ============================ 备份 ============================ */

interface RestorePreview {
  fileName: string;
  size: number;
  summary: string;
  raw: unknown;
}

interface BackupPaneProps {
  meta: LibraryMeta | null;
  counts: Record<string, number>;
  onRefresh: () => Promise<void>;
  onFlash: (f: Flash | null) => void;
}

function BackupPane({ meta, counts, onRefresh, onFlash }: BackupPaneProps) {
  const { library } = useServices();
  const [exporting, setExporting] = useState(false);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // 连续选两个文件时，只认最后一次读取的结果
  const readSeq = useRef(0);

  const totalRecords = useMemo(
    () => Object.values(counts).reduce((sum, n) => sum + n, 0),
    [counts],
  );
  const fileName = meta ? backupFileName(meta) : '学习库备份.openleaner.json';

  const handleExport = async () => {
    setExporting(true);
    onFlash(null);
    try {
      const backup = await library.exportBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], {
        type: 'application/json',
      });
      downloadBlob(blob, backupFileName(backup.meta));
      onFlash({
        tone: 'ok',
        text: `已导出「${backup.meta.name}」，共 ${countOfBackup(backup)} 条记录。`,
        hint: '文件里不含任何 API Key。',
      });
    } catch (err) {
      onFlash({
        tone: 'error',
        text: '导出失败',
        hint: err instanceof LibraryError ? err.hint : err instanceof Error ? err.message : undefined,
      });
    } finally {
      setExporting(false);
    }
  };

  const handlePickFile = async (file: File) => {
    const seq = ++readSeq.current;
    onFlash(null);
    setPreview(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new LibraryError(
          '这个文件不是有效的 JSON',
          '请确认选的是「导出学习库」生成的那个 .json 文件，别选成别的文件。',
        );
      }
      if (seq !== readSeq.current) return;
      setPreview({
        fileName: file.name,
        size: file.size,
        summary: summarizeBackup(parsed),
        raw: parsed,
      });
    } catch (err) {
      onFlash({
        tone: 'error',
        text: err instanceof LibraryError ? err.message : '读不了这个文件',
        hint: err instanceof LibraryError ? err.hint : undefined,
      });
    }
  };

  const doRestore = async () => {
    if (!preview) return;
    await library.importBackup(preview.raw);
    setPreview(null);
    setConfirming(false);
    await onRefresh();
    onFlash({
      tone: 'warn',
      text: '备份已恢复，学习库已是备份里的样子。',
      hint: '页面上的数字还是旧的，重新加载后就对了。',
      offerReload: true,
    });
  };

  return (
    <>
      <div className="set-section">
        <h2 className="set-section__title">导出备份</h2>
        <p className="set-section__lead">
          把整个学习库打包成一个 JSON 文件：课程、资料、知识点、题目、作答与复习记录都在里面。
        </p>
        <dl className="set-kv">
          <dt>将导出</dt>
          <dd>{totalRecords} 条记录</dd>
          <dt>明细</dt>
          <dd>{describeCounts(counts)}</dd>
          <dt>文件名</dt>
          <dd className="set-mono">{fileName}</dd>
          <dt>不含</dt>
          <dd>API Key、资料原始文件（PDF 原文件不进备份，只进解析出的文本）</dd>
        </dl>
        <p className="set-hint">文件会保存到浏览器的下载文件夹。建议改名后另外存一份。</p>
        <div className="set-actions">
          <button
            type="button"
            className="btn-fill btn-fill--sm"
            onClick={() => void handleExport()}
            disabled={exporting}
          >
            {exporting ? '导出中…' : '导出学习库'}
          </button>
        </div>
      </div>

      <div className="set-section">
        <h2 className="set-section__title">从备份恢复</h2>
        <p className="set-section__lead">
          用一个备份文件<strong>整体替换</strong>当前学习库。这是唯一会覆盖数据的操作，所以要先预览再确认。
        </p>
        <p className="set-hint">
          {meta
            ? '恢复后，当前学习库里的资料与题目会被备份里的内容替换掉。想留个后路，先导出一份。'
            : '现在还没有学习库，直接恢复最省事。'}
        </p>

        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void handlePickFile(file);
          }}
        />

        <div className="set-actions">
          <button type="button" className="btn-ghost" onClick={() => fileRef.current?.click()}>
            选择备份文件…
          </button>
        </div>

        {preview ? (
          <div className="set-inline set-inline--warn">
            <div>
              <strong>{preview.fileName}</strong>
              <span className="set-hint"> · {formatBytes(preview.size)}</span>
            </div>
            <div className="set-hint">{preview.summary}</div>
            <div className="set-actions" style={{ marginTop: 'var(--space-3)' }}>
              <button type="button" className="btn-ghost" onClick={() => setPreview(null)}>
                换一个文件
              </button>
              <button
                type="button"
                className="btn-fill btn-fill--sm btn-fill--danger"
                onClick={() => setConfirming(true)}
              >
                用此备份替换当前学习库
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {confirming && preview ? (
        <ConfirmDialog
          title="用这个备份替换学习库？"
          description={`当前学习库里的 ${totalRecords} 条记录会被 ${preview.fileName} 里的内容覆盖，这一步不能撤销。`}
          confirmLabel="替换"
          onConfirm={doRestore}
          onClose={() => setConfirming(false)}
        >
          <p className="set-hint">
            替换后页面上的数字还是旧的，需要重新加载一次才会显示备份里的内容。
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/* ============================ 小工具 ============================ */

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const COUNT_LABELS: Record<string, string> = {
  courses: '课程',
  sources: '资料',
  sourceSegments: '分段',
  sourceAnnotations: '批注',
  knowledgePoints: '知识点',
  generationRuns: '生成记录',
  decks: '题组',
  questions: '题目',
  answerRecords: '作答',
  reviewRecords: '复习状态',
  reviewLogs: '复习记录',
  slideDecks: '幻灯片',
  slideImages: '图片',
  backends: '后端',
  usageRecords: '用量',
};

/** 「资料 3 · 知识点 9 · 题目 0」——只列有内容的，空库时明说 */
function describeCounts(counts: Record<string, number>, backendCount?: number): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([key, n]) => `${COUNT_LABELS[key] ?? key} ${n}`);
  if (typeof backendCount === 'number' && backendCount > 0) {
    parts.push(`后端 ${backendCount}`);
  }
  if (parts.length === 0) return '空的';
  return parts.join(' · ');
}

function countOfBackup(backup: unknown): number {
  if (!backup || typeof backup !== 'object') return 0;
  return Object.values(backup as Record<string, unknown>).reduce<number>(
    (sum, v) => sum + (Array.isArray(v) ? v.length : 0),
    0,
  );
}

/**
 * 备份摘要。
 *
 * 刻意不看 schemaVersion 就下结论：validateBackup 用的是宽松兜底，
 * 所以「能解析」不等于「内容对」。这里只数出真实存在的数组，
 * 数不到就说明白，让用户在点替换之前看见。
 */
function summarizeBackup(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '这个文件里没有可识别的备份内容。';
  const obj = raw as Record<string, unknown>;
  if (obj.format !== 'openleaner-library') {
    return '这个文件不是 OpenLeaner 的备份（缺少 format 标识）。';
  }
  const parts = SUMMARY_STORES.map(({ key, label }) => {
    const v = obj[key];
    return Array.isArray(v) ? { label, n: v.length } : null;
  })
    .filter((x): x is { label: string; n: number } => x !== null && x.n > 0)
    .map((x) => `${x.n} ${x.label}`);
  if (parts.length === 0) return '备份能读，但里面是空的。';
  return parts.join(' · ');
}

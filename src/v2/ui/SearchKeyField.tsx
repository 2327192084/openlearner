/**
 * 搜索 API Key 设置（2026-11-21 深夜）。
 *
 * ## 为什么单独一个组件
 *
 * `SettingsPage.tsx` 已经 1474 行（硬约束：大文件不要插代码）。
 * 而且这一块与「模型后端」「每日一句」那些是并列的独立设置项，
 * 拆出来以后改它不用碰那个大文件。
 *
 * ## 为什么需要这个入口
 *
 * 学习路线的「联网检索」是可选的增强项。没有 Key 时那个勾选框
 * 一直是灰的 —— 功能存在但用不了，等于半个假开关。
 * 所以必须给用户一个填写的地方。
 *
 * ## Key 存哪、怎么保护
 *
 * 存 `settings.webSearchKey`。
 *
 * ⚠️ 与模型 Key 不同：模型 Key 存在 `secrets` 分区（刻意不进备份），
 * 而这里为了少开一张表存在 settings 里 —— 所以必须靠
 * `sanitizeSettingsForExport` 里显式 `delete` 才不进备份。
 * 那条已经加了，并有 2 条回归测试守着（其中一条反向验证过）。
 *
 * ## 为什么不明文回显已保存的 Key
 *
 * 输入框始终以密码形式显示，且**不回填真实值**（只显示「已保存」）。
 * 理由：共享屏幕、录屏、同事经过时不该被看到。
 * 用户想改就直接覆盖填新的。
 */

import { useCallback, useEffect, useState } from 'react';
import type { LibraryService } from '@/core/library.ts';
import { searchWeb } from '@/core/ai/web-search.ts';

export interface SearchKeyFieldProps {
  library: LibraryService;
}

type Phase = 'loading' | 'empty' | 'saved';

export function SearchKeyField({ library }: SearchKeyFieldProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** 测试连接的结果 */
  const [tested, setTested] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await library.getSettings();
      const k = (s as unknown as { webSearchKey?: unknown }).webSearchKey;
      setPhase(typeof k === 'string' && k.trim().length > 0 ? 'saved' : 'empty');
    } catch {
      setPhase('empty');
    }
  }, [library]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    const v = draft.trim();
    if (v.length === 0) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    setTested(null);
    try {
      await library.saveSettings({ webSearchKey: v } as never);
      setDraft('');
      setPhase('saved');
      setMsg('已保存。现在学习路线的「联网检索」可以用勾选了。');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    setTested(null);
    try {
      await library.saveSettings({ webSearchKey: '' } as never);
      setPhase('empty');
      setMsg('已删除。学习路线的联网检索会回到「不可用」。');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  /**
   * 真发一次检索验证 Key 能用。
   *
   * ## 为什么值得做这个按钮
   *
   * 用户填完 Key 之后如果不试，要等到**规划路线时**才发现 Key 无效 ——
   * 那时他的注意力在路线上，会以为是 AI 的问题。
   * 这里试一次，成因就隔离清楚了（Key 的问题 vs 模型的问题）。
   *
   * 用的是极小的查询（一个词），额度消耗可以忽略。
   */
  async function test() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    setTested(null);
    try {
      const s = await library.getSettings();
      const k = (s as unknown as { webSearchKey?: unknown }).webSearchKey;
      const key = typeof k === 'string' ? k : '';
      const r = await searchWeb('高等数学 目录', key);
      if (r.searched) {
        setTested(`连接正常，搜到 ${r.hits.length} 条结果。`);
      } else {
        setErr(`没连上：${r.note}`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '测试失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="skf">
      <h3 className="skf__title">搜索 API Key（学习路线联网检索用）</h3>
      <p className="skf__lead">
        学习路线可以联网查这门课的常规章节结构。不填也能用 —— 只是路线只能
        靠 AI 自己的学科知识排。填了之后，规划时会先搜一轮再排。
      </p>
      <p className="skf__lead">
        用 Tavily 的 Key（有免费额度）。Key 只存在本机，
        <b>不会写进导出的备份文件</b>。
      </p>

      {phase === 'loading' ? (
        <p className="skf__hint">正在读取…</p>
      ) : (
        <>
          <div className="skf__row">
            <input
              className="skf__input"
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={phase === 'saved' ? '已保存（要换就直接填新的）' : 'tvly-…'}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="btn-fill btn-fill--sm"
              onClick={() => void save()}
              disabled={busy || draft.trim().length === 0}
            >
              {busy ? '保存中…' : '保存'}
            </button>
          </div>

          <div className="skf__actions">
            <span className={`skf__state${phase === 'saved' ? ' skf__state--on' : ''}`}>
              {phase === 'saved' ? '● 已配置' : '○ 未配置'}
            </span>
            {phase === 'saved' ? (
              <>
                <button type="button" className="btn-ghost btn-ghost--sm" onClick={() => void test()} disabled={busy}>
                  测试连接
                </button>
                <button type="button" className="btn-ghost btn-ghost--sm" onClick={() => void remove()} disabled={busy}>
                  删除
                </button>
              </>
            ) : null}
          </div>
        </>
      )}

      {msg ? <p className="skf__ok">{msg}</p> : null}
      {tested ? <p className="skf__ok">{tested}</p> : null}
      {err ? <p className="skf__err">{err}</p> : null}
    </section>
  );
}
/**
 * 设置页的「墨墨生词本」面板（2026-11-09）。
 *
 * ## 为什么做成独立文件
 *
 * `SettingsPage.tsx` 已 1400+ 行，而项目对往大文件里插代码有过明确教训
 * （GenerateFile 的 CRLF/LF 混用，改坏过两次）。新增面板一律独立文件。
 *
 * ## 交互设计
 *
 * 三步，顺序不能倒：
 *  1. 填 access token（在墨墨 App 内生成）
 *  2. 点「读取我的词本」→ 拉列表
 *  3. 选一个作为目标
 *
 * 为什么不让用户手填词本 id：那要求他去调接口抄一串 `np-...`，
 * 而我们有列表接口，点一下就行。手填 id 只作为兜底（万一列表接口变了）。
 *
 * ## 「整段替换」这件事必须说清楚
 *
 * 墨墨的导入接口是**整段替换 content**，不是「追加」。也就是说
 * 第二次导入会把第一次的词覆盖掉。这一点社区实现里也是这么做的
 * （EudicSyncToMaiMemo 每次把抓到的全量生词本内容整体提交）。
 *
 * 我们不做「本地维护一份全量再生效」——那要在我们这边存一份镜像，
 * 一旦用户在墨墨里手动改过词本就对不上。所以这里**如实提示**：
 * 「每次导入会覆盖这个词本里上次由本应用写入的内容」。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  MaimemoClient,
  maimemoConfigFromSettings,
  type MaimemoNotepad,
} from '@/core/maimemo.ts';
import './maimemo-settings.css';

export interface MaimemoSettingsProps {
  load: () => Promise<unknown>;
  save: (patch: Record<string, unknown>) => Promise<void>;
  onSaved?: () => void;
}

/**
 * 把手填的 token 做一次「看起来对不对」的检查。
 *
 * 墨墨的 token 是一串字母数字。不做格式硬校验（万一以后变格式），
 * 只挡住明显的粘贴错误（带空格、太长、太短）。
 * 真正的验证靠「读取我的词本」那一步 —— 那才是权威。
 */
function looksLikeToken(t: string): boolean {
  const s = t.trim();
  if (s.length < 8 || s.length > 200) return false;
  return /^[A-Za-z0-9_-]+$/.test(s);
}

export function MaimemoSettings({ load, save, onSaved }: MaimemoSettingsProps) {
  const [token, setToken] = useState('');
  const [notepadId, setNotepadId] = useState('');
  const [notepads, setNotepads] = useState<MaimemoNotepad[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [manualId, setManualId] = useState(false);

  /* 载入已有配置 */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await load();
        if (cancelled) return;
        const cfg = maimemoConfigFromSettings(s);
        setToken(cfg.token);
        setNotepadId(cfg.notepadId);
      } catch {
        /* 读不到就用空值，不打扰用户 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const persist = useCallback(
    async (next: { token?: string; notepadId?: string }) => {
      setBusy(true);
      setError(null);
      setErrorHint(null);
      setFlash(null);
      try {
        await save({
          ...(next.token !== undefined ? { maimemoToken: next.token } : {}),
          ...(next.notepadId !== undefined ? { maimemoNotepadId: next.notepadId } : {}),
        });
        setFlash('已保存');
        onSaved?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : '保存失败');
      } finally {
        setBusy(false);
      }
    },
    [save, onSaved],
  );

  const saveToken = useCallback(async () => {
    const t = token.trim();
    if (t && !looksLikeToken(t)) {
      setError('这个 token 看起来不对。');
      setErrorHint('它是一串字母数字，不含空格。从墨墨 App 里复制后原样粘贴。');
      return;
    }
    await persist({ token: t });
  }, [token, persist]);

  const fetchNotepads = useCallback(async () => {
    setBusy(true);
    setError(null);
    setErrorHint(null);
    setNotepads(null);
    try {
      const client = new MaimemoClient({ token: token.trim() });
      const r = await client.listNotepads();
      if (!r.ok) {
        setError(r.message);
        /*
         * hint 只在**能补充新信息**时给（2026-11-09 截图发现重复）。
         *
         * 之前 unauthorized 和 network 两条的 hint 与客户端给的消息几乎一样，
         * 界面上同一句话显示了两遍（「token 无效或已过期。到墨墨 App 里重新生成一个。」
         * 上面一行、下面一行）。那看起来像程序出错，比只显示一遍更糟。
         *
         * 现在：
         *  - no-token → 需要告诉用户「先填」，客户端消息里没有这一步
         *  - unauthorized → 客户端消息已写清怎么做，不再重复
         *  - network → 只补一句「不影响其它功能」，这是新信息
         */
        setErrorHint(
          r.trouble === 'no-token'
            ? '先在上面填 token 并保存。'
            : r.trouble === 'network'
              ? '断网时读不到词本，但不影响阅读、做题等其它功能。'
              : null,
        );
        return;
      }
      setNotepads(r.data);
      if (r.data.length === 0) {
        setError('你的墨墨账号里还没有云词本。');
        setErrorHint('在墨墨 App 里先建一个云词本（随便叫什么），再回来点一次。');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      setBusy(false);
    }
  }, [token]);

  const pickNotepad = useCallback(
    async (id: string) => {
      setNotepadId(id);
      await persist({ notepadId: id });
    },
    [persist],
  );

  return (
    <div className="mm-set">
      <p className="mm-set__lead">
        在阅读器里划选英文单词，可以一键加进墨墨的云词本 ——
        <strong>我们不重复做背单词</strong>，只负责把「你遇到的新词」送进你已经在用的墨墨。
      </p>

      {error ? (
        <div className="mm-set__error">
          <span>{error}</span>
          {errorHint ? <span className="mm-set__hint">{errorHint}</span> : null}
        </div>
      ) : null}
      {flash ? <p className="mm-set__flash">{flash}</p> : null}

      {/* ---- 1. token ---- */}
      <div className="mm-set__block">
        <h3 className="mm-set__h3">第一步 · 填 access token</h3>
        <p className="mm-set__hint">
          在墨墨 App 内生成（墨墨 → 我的 → 开放 API / 或访问
          open.maimemo.com/open/api/v1/tokens/openapi）。它只存在你这台电脑，不上传。
        </p>
        <div className="mm-set__row">
          <input
            className="mm-set__input"
            type="password"
            value={token}
            placeholder="粘贴 token"
            disabled={busy}
            onChange={(e) => setToken(e.target.value)}
          />
          <button type="button" className="mm-set__btn" disabled={busy} onClick={() => void saveToken()}>
            保存 token
          </button>
        </div>
      </div>

      {/* ---- 2. 选词本 ---- */}
      <div className="mm-set__block">
        <h3 className="mm-set__h3">第二步 · 选目标云词本</h3>
        <div className="mm-set__row">
          <button
            type="button"
            className="mm-set__btn"
            disabled={busy || !token.trim()}
            onClick={() => void fetchNotepads()}
          >
            {busy ? '读取中…' : '读取我的词本'}
          </button>
          <button
            type="button"
            className="mm-set__link"
            disabled={busy}
            onClick={() => setManualId((v) => !v)}
          >
            {manualId ? '不手填了' : '手填词本 id'}
          </button>
        </div>

        {manualId ? (
          <div className="mm-set__row">
            <input
              className="mm-set__input"
              value={notepadId}
              placeholder="np-... （从墨墨网页版地址栏里能抄到）"
              disabled={busy}
              onChange={(e) => setNotepadId(e.target.value)}
            />
            <button
              type="button"
              className="mm-set__btn"
              disabled={busy}
              onClick={() => void persist({ notepadId: notepadId.trim() })}
            >
              保存词本
            </button>
          </div>
        ) : null}

        {notepads && notepads.length > 0 ? (
          <ul className="mm-set__list">
            {notepads.map((n) => (
              <li key={n.id} className={'mm-set__item' + (n.id === notepadId ? ' mm-set__item--on' : '')}>
                <button
                  type="button"
                  className="mm-set__pick"
                  disabled={busy}
                  onClick={() => void pickNotepad(n.id)}
                >
                  <span className="mm-set__name">{n.title}</span>
                  <span className="mm-set__meta">
                    {n.wordCount !== null ? `${n.wordCount} 词 · ` : ''}
                    {n.id === notepadId ? '当前使用' : '选这个'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {notepadId && !notepads ? (
          <p className="mm-set__hint">当前使用：{notepadId}</p>
        ) : null}
      </div>

      {/* ---- 3. 说清行为 ---- */}
      <div className="mm-set__note">
        <p>
          <strong>导入时会覆盖这个词本里上次由本应用写入的内容。</strong>
          墨墨的接口是整段替换，不是追加 —— 所以别把它当成长期词库，
          它更像是「这一批生词」的传送带。你已经背熟的词留在墨墨那边，不受影响。
        </p>
        <p>
          没配也能正常用应用，只是阅读器划词时不会出现「加入墨墨生词本」的浮层。
        </p>
      </div>
    </div>
  );
}

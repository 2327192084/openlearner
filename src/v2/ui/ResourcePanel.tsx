/**
 * 外部资源面板（2026-11-22，方案第 7 步）。
 *
 * ## 两处入口共用这一个组件（方案 7.3）
 *
 * | 位置 | 归属 |
 * |---|---|
 * | 阅读器右栏 | 资料级（`sectionId = null`） |
 * | 小节详情 | 挂到该小节（`sectionId = 小节 id`） |
 *
 * 不写两份的理由：「资源列表长什么样、怎么加、怎么删」两处必然要一致，
 * 写两份迟早漂移，而漂移的表现是"小节里能加、右栏不能加"这种莫名差异。
 *
 * ## 表单：只有网址必填（用户确认过）
 *
 * 标题留空 → 自动回退（抓到的标题 → 域名 → 完整网址）。
 * 「自动抓标题」需要网络，这里**不做**：请求第三方页面拿 <title> 会
 * 引入一条新的网络通道（还有 SSRF 风险）。方案 7.4 说的是"自动抓，
 * 抓不到不阻塞"，所以回退链保证**一定有标题**就够用了。
 *
 * ## 打开外链走主进程
 *
 * `window.openleaner.openExternal` → 主进程 `openExternalSafely`
 * （只允许 http/https）。**不新增网络通道**，与方案 7.2 一致。
 */

import { useState } from 'react';
import {
  checkResourceUrl,
  hostOf,
  isDuplicateUrl,
  makeResource,
  relativeTime,
  type SourceResource,
} from '@/v2/core/resource-store.ts';

export interface ResourcePanelProps {
  /** 这份资料的 id（新资源的归属） */
  sourceId: string;
  /** 当前显示哪些资源（调用方已按资料/小节过滤好） */
  resources: readonly SourceResource[];
  /** 新增 */
  onAdd: (resource: SourceResource) => void;
  /** 删除 */
  onRemove: (id: string) => void;
  /** 挂在哪个小节上（null/省略 = 资料级） */
  sectionId?: string | null;
  /** 面板标题 */
  title?: string;
  /** 没有资源时的说明 */
  emptyHint?: string;
}

export function ResourcePanel(props: ResourcePanelProps) {
  const { sourceId, resources, onAdd, onRemove, sectionId = null, title, emptyHint } = props;

  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [noteText, setNoteText] = useState('');
  /** 校验/重复的错误（不清空输入框 —— 方案 7.5 要求保留内容） */
  const [err, setErr] = useState<string | null>(null);

  const open = (r: SourceResource) => {
    const api = (window as unknown as {
      openleaner?: { openExternal?: (u: string) => Promise<{ ok: boolean; message?: string }> };
    }).openleaner;
    if (!api?.openExternal) {
      setErr('当前环境打不开外部链接（需要在桌面版里使用）。');
      return;
    }
    void api.openExternal(r.url).then((res) => {
      if (!res?.ok) setErr(res?.message ?? '打不开这个网址。');
    }).catch(() => {
      setErr('打不开这个网址。');
    });
  };

  const submit = () => {
    const check = checkResourceUrl(url);
    if (!check.ok) {
      /* 不关表单、不清输入 —— 用户改一个字就能重试 */
      setErr(check.reason);
      return;
    }
    if (isDuplicateUrl(check.url, resources)) {
      setErr('这条已经在列表里了。');
      return;
    }

    onAdd(
      makeResource({
        sourceId,
        url: check.url,
        note: noteText,
        source: 'manual',
        ...(sectionId !== null ? { sectionId } : {}),
      }),
    );
    /* 成功才清空并收起 */
    setUrl('');
    setNoteText('');
    setErr(null);
    setAdding(false);
  };

  return (
    <section className="rpanel">
      <header className="rpanel__head">
        <h4 className="rpanel__title">{title ?? '外部资源'}</h4>
        <span className="rpanel__count">{resources.length}</span>
      </header>

      {resources.length > 0 ? (
        <ul className="rpanel__list">
          {resources.map((r) => (
            <li key={r.id} className="rpanel__item">
              <button
                type="button"
                className="rpanel__link"
                onClick={() => open(r)}
                title={r.url}
              >
                <span className="rpanel__dot" aria-hidden="true" />
                <span className="rpanel__body">
                  <span className="rpanel__name">{r.title}</span>
                  <span className="rpanel__meta">
                    {hostOf(r.url)}
                    <span className="rpanel__src">
                      {r.source === 'search' ? '联网收集' : '人工整理'}
                    </span>
                    {r.addedAt ? (
                      <span className="rpanel__time">{relativeTime(r.addedAt)}</span>
                    ) : null}
                  </span>
                  {r.note ? <span className="rpanel__note">{r.note}</span> : null}
                </span>
              </button>

              <button
                type="button"
                className="rpanel__del"
                onClick={() => onRemove(r.id)}
                aria-label={`删除资源「${r.title}」`}
                title="删除这条资源"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rpanel__empty">
          {emptyHint ?? '还没有外部资源。可以加网课、文档、视频的链接。'}
        </p>
      )}

      {adding ? (
        <div className="rpanel__form">
          <label className="rpanel__field">
            <span className="rpanel__label">
              网址 <span className="rpanel__req">必填</span>
            </span>
            <input
              className="rpanel__input"
              type="text"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setErr(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
                if (e.key === 'Escape') {
                  setAdding(false);
                  setErr(null);
                }
              }}
              placeholder="粘贴网址即可，标题会自动取域名"
              autoFocus
            />
          </label>

          <label className="rpanel__field">
            <span className="rpanel__label">备注（可选）</span>
            <input
              className="rpanel__input"
              type="text"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="如：第 3 节看这个"
            />
          </label>

          {err ? <p className="rpanel__err">{err}</p> : null}

          <div className="rpanel__actions">
            <button type="button" className="btn-fill btn-fill--sm" onClick={submit}>
              添加
            </button>
            <button
              type="button"
              className="btn-ghost btn-ghost--sm"
              onClick={() => {
                setAdding(false);
                setErr(null);
              }}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn-ghost btn-ghost--sm rpanel__add"
          onClick={() => setAdding(true)}
        >
          + 添加资源
        </button>
      )}
    </section>
  );
}
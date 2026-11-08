/**
 * 设置页的「首页小组件」编辑区（2026-11-08）。
 *
 * ## 为什么抽成独立文件
 *
 * `SettingsPage.tsx` 已经 1405 行，而且项目里对这类大文件有过明确教训
 * （交接文档第五节第 3 条：GeneratePage 是 CRLF/LF 混用，按行号批量替换
 * 会错位，历史上改坏过两次）。所以新增 UI 一律独立文件，
 * 宿主里只插一行引用。
 *
 * ## 这一块解决什么
 *
 * 首页右侧原来是一张固定的「下一步」卡，和左侧主区显示同一组数字。
 * 现在换成可自定义的小组件：座右铭、每日一句、待办、番茄钟。
 *
 * ## 关于联网
 *
 * 「每日一句」用**内置语料库**，每天按本地日期轮换，不联网。
 * 理由见 home-widgets.ts：这个应用离线优先，为一句鸡汤引入网络依赖，
 * 断网就空一块，而它正好在首页最显眼的位置。
 * 用户若后续要真联网，换掉 pickDailyQuote 的来源即可。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  clampWidgets,
  DEFAULT_WIDGET_TITLE,
  MAX_WIDGETS,
  normalizeWidgets,
  WIDGET_KIND_LABEL,
  type HomeWidget,
  type WidgetKind,
} from './home-widgets.ts';
import './home-widgets-editor.css';

export interface HomeWidgetsEditorProps {
  /** 读当前配置 */
  load: () => Promise<unknown>;
  /** 存回配置 */
  save: (widgets: HomeWidget[]) => Promise<void>;
  /** 保存成功后通知上层（首页要刷新） */
  onSaved?: () => void;
}

const KINDS: WidgetKind[] = ['quote', 'text', 'todo', 'focus'];

export function HomeWidgetsEditor({ load, save, onSaved }: HomeWidgetsEditorProps) {
  const [widgets, setWidgets] = useState<HomeWidget[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await load();
        if (cancelled) return;
        setWidgets(normalizeWidgets(raw));
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '读不出小组件配置');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const persist = useCallback(
    async (next: HomeWidget[]) => {
      setSaving(true);
      setError(null);
      setFlash(null);
      try {
        const clamped = clampWidgets(next);
        await save(clamped);
        setWidgets(clamped);
        setFlash('已保存');
        onSaved?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : '保存失败');
      } finally {
        setSaving(false);
      }
    },
    [save, onSaved],
  );

  const patch = useCallback((id: string, next: Partial<HomeWidget>) => {
    setWidgets((prev) => prev.map((w) => (w.id === id ? { ...w, ...next } : w)));
  }, []);

  const remove = useCallback((id: string) => {
    setWidgets((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const add = useCallback(() => {
    setWidgets((prev) => {
      if (prev.length >= MAX_WIDGETS) return prev;
      return [
        ...prev,
        {
          /* 用时间戳 + 随机，避免同一毫秒连加两个撞 id */
          id: `w_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
          kind: 'text',
          title: '',
          body: '',
        },
      ];
    });
  }, []);

  if (loading) return <p className="hw-hint">正在读小组件配置…</p>;

  return (
    <div className="hw-editor">
      <p className="hw-lead">
        首页右侧那块区域显示什么，由你决定。可以放座右铭、每日单词、待办，
        也可以放一个番茄钟入口。最多 {MAX_WIDGETS} 个。
      </p>
      <p className="hw-note">
        「每日一句」用内置语料，<strong>不需要联网</strong>，每天自动换一句。
        想固定成自己的话，把内容填进「内容」框即可。
      </p>

      {error ? <p className="hw-error" role="alert">{error}</p> : null}
      {flash ? <p className="hw-flash">{flash}</p> : null}

      <ul className="hw-list">
        {widgets.map((w, i) => (
          <li key={w.id} className="hw-item">
            <div className="hw-item__head">
              <span className="hw-item__no">{i + 1}</span>
              <select
                className="hw-select"
                value={w.kind}
                disabled={saving}
                onChange={(e) => patch(w.id, { kind: e.target.value as WidgetKind })}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {WIDGET_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="hw-remove"
                disabled={saving}
                onClick={() => remove(w.id)}
              >
                移除
              </button>
            </div>

            <label className="hw-field">
              <span className="hw-label">标题（留空用默认「{DEFAULT_WIDGET_TITLE[w.kind]}」）</span>
              <input
                className="hw-input"
                value={w.title}
                disabled={saving}
                placeholder={DEFAULT_WIDGET_TITLE[w.kind]}
                onChange={(e) => patch(w.id, { title: e.target.value })}
              />
            </label>

            {/*
              内容框只对 quote / text 有意义。
              todo 与 focus 是「嵌入已有功能」，没有用户可填的内容 ——
              这两个不显示输入框，免得用户填了却没效果（那是假开关）。
            */}
            {w.kind === 'quote' || w.kind === 'text' ? (
              <label className="hw-field">
                <span className="hw-label">
                  {w.kind === 'quote'
                    ? '内容（留空则每天自动换一句内置的）'
                    : '内容（可以多行：座右铭、每日单词…）'}
                </span>
                <textarea
                  className="hw-textarea"
                  rows={w.kind === 'text' ? 4 : 2}
                  value={w.body}
                  disabled={saving}
                  placeholder={w.kind === 'quote' ? '不填就每天换一句' : '写点什么'}
                  onChange={(e) => patch(w.id, { body: e.target.value })}
                />
              </label>
            ) : (
              <p className="hw-hint">
                {w.kind === 'todo'
                  ? '显示「待办」页里最近几件没完成的，点一下能跳过去。'
                  : '显示一个「开始专注」的入口，点一下进番茄钟。'}
              </p>
            )}
          </li>
        ))}
      </ul>

      <div className="hw-actions">
        <button
          type="button"
          className="hw-btn"
          disabled={saving || widgets.length >= MAX_WIDGETS}
          onClick={add}
        >
          添加一个小组件
        </button>
        <button
          type="button"
          className="hw-btn hw-btn--primary"
          disabled={saving}
          onClick={() => void persist(widgets)}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>

      {widgets.length === 0 ? (
        <p className="hw-hint">
          现在一个都没有。保存后首页右侧会自动放一个「每日一句」——
          首页不能空着。
        </p>
      ) : null}
    </div>
  );
}

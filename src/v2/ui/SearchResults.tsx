/**
 * 搜索结果列表（2026-11-11）。
 *
 * ## 它解决什么
 *
 * 用户反馈：「我搜索关键词『分析』，找到了 24 个结果，但只给我跳转至第一处，
 * 有没有办法把这 24 个结果都展示出来，供用户自行选择跳转。」
 *
 * 旧实现（`ReaderPage.doSearch`）拿到 `SearchHit[]` 之后只用 `hits[0]`，
 * 剩下 23 处连提示都只给了一句「已跳到第 1 处」，用户无从选择。
 * 而 `sourceService.search()` 本来就返回**全部**命中（含页码、字符偏移、
 * 上下文片段），数据一直在，只是没展示。
 *
 * ## 交互设计参考
 *
 * 主流阅读器的做法都是「结果侧栏 + 点击跳转」：
 *  - Apple Preview / 访达：搜索后左侧列出每一处匹配，点哪条跳哪条
 *  - Adobe Acrobat：搜索结果窗口列出全部实例，可保存为 PDF/CSV
 *  - Finder：边栏显示每页匹配数与高亮定位
 * 参阅：
 *  - https://support.apple.com/zh-cn/guide/preview/prvw2014/10.0/mac/10.13
 *  - https://helpx.adobe.com/cn/acrobat/using/searching-pdfs.html
 *
 * ## 为什么单独一个文件
 *
 * `ReaderPage.tsx` 已 1700 行（交接文档硬约束 5：大文件里不要插代码，
 * 新增 UI 一律独立文件，宿主里只插一行引用）。
 *
 * ## 分组与高亮
 *
 * 按页分组（同一页的多处排在一起），与用户在纸上翻找的心智一致。
 * 片段里的关键词用 `<mark>` 标出来 —— 光给片段不标关键词，
 * 用户还得自己在一行字里找位置。
 */

import type { SearchHit } from '@/core/sources.ts';

export interface SearchResultsProps {
  /** 全部命中（按资料顺序） */
  hits: readonly SearchHit[];
  /** 当前正在看的是哪一条（用 index，不是 page —— 同页可能有多处） */
  activeIndex: number;
  /** 点某一条：跳到那一处 */
  onPick: (index: number) => void;
  /** 关掉列表 */
  onClose: () => void;
  /** 搜索的关键词，用于在片段里标出来 */
  keyword: string;
}

/** 把片段里出现的所有关键词包成 <mark>（不区分大小写） */
function renderSnippet(snippet: string, keyword: string) {
  const kw = keyword.trim();
  if (!kw) return snippet;

  const out: React.ReactNode[] = [];
  const lower = snippet.toLowerCase();
  const lowerKw = kw.toLowerCase();
  let from = 0;
  let n = 0;

  for (;;) {
    const at = lower.indexOf(lowerKw, from);
    if (at === -1) break;
    if (at > from) out.push(snippet.slice(from, at));
    out.push(
      <mark className="reader-hits__kw" key={n++}>
        {snippet.slice(at, at + kw.length)}
      </mark>,
    );
    from = at + kw.length;
    /* 防御：关键词为空时上面已 return，这里不会死循环 */
  }
  if (from < snippet.length) out.push(snippet.slice(from));
  return out.length > 0 ? out : snippet;
}

export function SearchResults({
  hits,
  activeIndex,
  onPick,
  onClose,
  keyword,
}: SearchResultsProps) {
  if (hits.length === 0) return null;

  /* 按页分组，保持原有顺序 */
  const groups: { page: number; chapter: string | null; items: { hit: SearchHit; index: number }[] }[] =
    [];
  hits.forEach((hit, index) => {
    const last = groups[groups.length - 1];
    if (last && last.page === hit.page) {
      last.items.push({ hit, index });
    } else {
      groups.push({ page: hit.page, chapter: hit.chapter, items: [{ hit, index }] });
    }
  });

  return (
    <section className="reader-hits" aria-label="搜索结果">
      <header className="reader-hits__head">
        <span className="reader-hits__title">
          「{keyword}」共 {hits.length} 处
          <span className="reader-hits__sub"> · {groups.length} 页</span>
        </span>
        <button type="button" className="btn-ghost reader-hits__close" onClick={onClose}>
          收起
        </button>
      </header>

      <ul className="reader-hits__list">
        {groups.map((g) => (
          <li key={g.page} className="reader-hits__group">
            <p className="reader-hits__page">
              第 {g.page} 页
              {g.chapter ? <span className="reader-hits__chapter">{g.chapter}</span> : null}
              {g.items.length > 1 ? (
                <span className="reader-hits__count">{g.items.length} 处</span>
              ) : null}
            </p>
            <ul className="reader-hits__items">
              {g.items.map(({ hit, index }) => (
                <li key={index}>
                  <button
                    type="button"
                    className={`reader-hits__item${index === activeIndex ? ' reader-hits__item--on' : ''}`}
                    onClick={() => onPick(index)}
                    title="跳到这一处"
                  >
                    <span className="reader-hits__snippet">
                      {renderSnippet(hit.snippet, keyword)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

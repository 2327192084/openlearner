/**
 * 「资料存在哪」说明条（2026-11-16 建 / 2026-11-17 按用户反馈重做）。
 *
 * ## 用户的第一版反馈
 *
 * 「资料的路径不够具体，我按提示打开的是软件本身的库，里面还有很多
 *   其他资料，不是单纯资料保存的库。」
 *
 * 他说得对。第一版显示的是 `app.getPath('userData')` —— 那是 Electron
 * 的整个用户数据目录，打开后能看到：
 *
 *   Cache/  Code Cache/  GPUCache/  Network/  Session Storage/
 *   DawnGraphiteCache/  DIPS/  WebStorage/  IndexedDB/  Local Storage/
 *   mineru-jobs/  mineru-figures/  ...
 *
 * 十几个目录里，**只有 `IndexedDB` 与 `Local Storage` 是学习库**，
 * 其余全是 Chromium 的缓存与状态。用户点「打开文件夹」看到的是一堆
 * 看不懂的东西，当然会觉得「这不是我要找的资料库」。
 *
 * ## 现在说清三件事
 *
 * 1. **库在哪**：显示 `userData` 与 `userData/IndexedDB` 两个层级，
 *    「打开」直接打开 `IndexedDB` —— 那是真正装数据的地方
 * 2. **它长什么样**：里面是 `000004.log`、`000005.ldb` 这种二进制文件，
 *    **不是能双击打开的资料文件**。资料（PDF 原件、正文、知识点、题）
 *    全部装在这些二进制里，由软件读写
 * 3. **为什么不能像普通文件夹那样用**：这是 IndexedDB（浏览器的数据库），
 *    不是「一个 PDF 一个文件」的目录
 *
 * 与其含糊地说「资料保存在某路径」让用户去翻，不如**如实说明它是什么**。
 * 这一页最有用的信息不是路径本身，而是「别指望在这里双击打开 PDF」。
 */

import { useCallback, useEffect, useState } from 'react';

interface LibraryBridge {
  /** 当前库目录与数据目录（绝对路径）。同步 getter —— 见 preload.cjs */
  location?: { dir: string; dataDir: string } | null;
  /** 在资源管理器里打开**库目录**（userData） */
  reveal?: () => Promise<{ ok: boolean; message?: string }>;
  /** 在资源管理器里打开**数据目录**（userData/IndexedDB） */
  revealData?: () => Promise<{ ok: boolean; message?: string }>;
}

/**
 * 取 preload 暴露的桥。
 *
 * ⚠️ 路径是 `window.openleaner.library`，**不是** `window.openleaner`。
 * 第一次写这个组件时少写了一层，界面就显示成「读不到位置」——
 * 明明就是桌面版。截图复核时抓到的。
 */
function bridge(): LibraryBridge | undefined {
  return (typeof window !== 'undefined'
    ? (window as unknown as { openleaner?: { library?: LibraryBridge } }).openleaner?.library
    : undefined);
}

export function SourcesStorageNote() {
  const [dir, setDir] = useState<string | null>(null);
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const loc = bridge()?.location;
    setDir(loc?.dir ?? null);
    setDataDir(loc?.dataDir ?? null);
  }, []);

  const reveal = useCallback(async (which: 'dir' | 'data') => {
    const b = bridge();
    const fn = which === 'data' ? b?.revealData : b?.reveal;
    if (!fn) {
      setNote('这个环境不支持打开文件夹（需要在桌面应用里用）。');
      return;
    }
    try {
      const r = await fn();
      if (!r.ok && r.message) setNote(`打不开：${r.message}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : '打开文件夹失败');
    }
  }, []);

  return (
    <div className="sources-store">
      <div className="sources-store__row">
        <span className="sources-store__label">资料保存位置</span>
        {dataDir ? (
          <code className="sources-store__path" title={dataDir}>
            {dataDir}
          </code>
        ) : (
          <span className="sources-store__unknown">读不到位置（需要在桌面应用里打开）</span>
        )}
        {dataDir ? (
          <button type="button" className="sources-store__btn" onClick={() => void reveal('data')}>
            打开
          </button>
        ) : null}
      </div>

      {/*
       * 这一句是最重要的：告诉用户「点开之后你会看到什么」。
       * 不说的话，用户点开会看到一堆 000004.log / 000005.ldb，
       * 以为找错了地方 —— 这正是上一版被指出的问题。
       */}
      <p className="sources-store__hint">
        里面是 <code>000004.log</code>、<code>000005.ldb</code> 这类
        <strong>数据库文件，不是能双击打开的资料</strong>。
        导入的 PDF / 图片原件、正文、知识点、题目全装在里面，由本软件读写。
      </p>

      {expanded ? (
        <div className="sources-store__more">
          <p className="sources-store__hint">
            <strong>整个软件的数据目录</strong>（含缓存，不是资料本身）：
          </p>
          <div className="sources-store__row">
            <code className="sources-store__path" title={dir ?? ''}>
              {dir ?? '读不到'}
            </code>
            {dir ? (
              <button type="button" className="sources-store__btn" onClick={() => void reveal('dir')}>
                打开
              </button>
            ) : null}
          </div>
          <p className="sources-store__hint">
            这个目录里除了 <code>IndexedDB</code> 与 <code>Local Storage</code>，
            其余（<code>Cache</code>、<code>GPUCache</code>、<code>Network</code> 等）
            都是浏览器内核的缓存，删掉不影响资料。
          </p>
          <p className="sources-store__hint">
            <strong>要备份或搬家</strong>：用「设置 → 导出备份」，那是可读的 JSON；
            直接从磁盘拷这个目录只在软件关闭时才安全。
          </p>
        </div>
      ) : null}

      <button
        type="button"
        className="sources-store__btn sources-store__btn--more"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? '收起说明' : '这个目录里还有什么'}
      </button>

      {note ? <p className="sources-store__note">{note}</p> : null}
    </div>
  );
}

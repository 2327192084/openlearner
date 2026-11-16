/**
 * 「资料存在哪」说明条（2026-11-16）。
 *
 * ## 用户的原话
 *
 * 「解析选择的pdf的时候需要再在文件资源管理器里选择一次要解析的文件。
 *   我的疑问是资料是否在软件里有个单独的储存库，还是单纯链接资料位置。
 *   不管是哪个，我需要你在软件界面内明确标注出资料库在电脑里的保存路径」
 *
 * ## 要回答的两个问题
 *
 * 1. **存在哪** —— 学习库的绝对路径（桌面版可读，浏览器读不到）
 * 2. **是不是只链接** —— 不是。PDF/图片的原件字节确实存在库里
 *    （IndexedDB 的 sourceFiles 表），不依赖磁盘上那份原文件。
 *
 * ## 为什么单独做成组件
 *
 * 资料页（SourcesPage.tsx，700+ 行）已经够大了，不往里塞 UI。
 * 本组件只读、不写库，纯展示 + 一个「打开文件夹」。
 *
 * ## 与 LibraryLocationRow 的关系
 *
 * 那个是「设置页 / 顶栏」里改路径用的，带「更改位置」按钮。
 * 这个是在资料页**告诉用户东西在哪**，不需要改路径的入口 ——
 * 所以只显示路径 + 打开文件夹，并多一句「原件已存进库里」。
 */

import { useCallback, useEffect, useState } from 'react';

interface LibraryBridge {
  /** 当前库目录与数据目录（绝对路径）。同步 getter —— 见 preload.cjs */
  location?: { dir: string; dataDir: string } | null;
  reveal?: () => Promise<{ ok: boolean; message?: string }>;
}

/**
 * 取 preload 暴露的桥。
 *
 * ⚠️ 路径是 `window.openleaner.library`，**不是** `window.openleaner`。
 * 第一次写这个组件时少写了一层 `library`，界面上就显示成
 * 「读不到位置（需要在桌面应用里打开）」—— 明明就是桌面版。
 * 截图复核时抓到了（.verify-shots/storage-note-20261116/）。
 *
 * 这个项目对「界面在说谎」零容忍：读不到就如实说读不到，
 * 但**不能因为自己写错路径就说读不到**。
 */
function bridge(): LibraryBridge | undefined {
  return (typeof window !== 'undefined'
    ? (window as unknown as { openleaner?: { library?: LibraryBridge } }).openleaner?.library
    : undefined);
}

export function SourcesStorageNote() {
  const [dir, setDir] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setDir(bridge()?.location?.dir ?? null);
  }, []);

  const reveal = useCallback(async () => {
    const b = bridge();
    if (!b?.reveal) {
      setNote('这个环境不支持打开文件夹（需要在桌面应用里用）。');
      return;
    }
    try {
      const r = await b.reveal();
      if (!r.ok && r.message) setNote(`打不开：${r.message}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : '打开文件夹失败');
    }
  }, []);

  return (
    <div className="sources-store">
      <div className="sources-store__row">
        <span className="sources-store__label">资料保存在</span>
        {dir ? (
          <code className="sources-store__path" title={dir}>
            {dir}
          </code>
        ) : (
          <span className="sources-store__unknown">读不到位置（需要在桌面应用里打开）</span>
        )}
        {dir ? (
          <button type="button" className="sources-store__btn" onClick={() => void reveal()}>
            打开文件夹
          </button>
        ) : null}
      </div>
      {/*
       * 这句话是要回答「是存了一份，还是只链接原位置」。
       * 说清楚：原件字节确实存进来了，所以移动/删除桌面那份 PDF
       * 不影响阅读原文；只有「本机 MinerU 解析」仍然需要磁盘路径。
       */}
      <p className="sources-store__hint">
        导入的 PDF 与图片<strong>原件就存在这个库里</strong>（不是只记一个位置）——
        移动或删掉电脑上那份原文件，仍然能看原文。
      </p>
      {note ? <p className="sources-store__note">{note}</p> : null}
    </div>
  );
}

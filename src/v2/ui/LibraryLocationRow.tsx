/**
 * 学习库位置（2026-11-11）。
 *
 * ## 为什么要有它
 *
 * 用户原话两条：
 *  1. 「在设置里创建学习库时没有告诉我学习库的具体路径，
 *     到时候用户安装时先让其选择学习库保存路径」
 *  2. 「软件右上角这个工作库按钮应该可以点击，点击后可以自由切换学习库
 *     或是更改库的路径」
 *
 * 在此之前，库位置完全由主进程的探测顺序决定
 * （`ensureUserDataDir()`：默认 userData → `%APPDATA%\OpenLeaner` → exe 旁边）。
 * 用户既看不到、也管不了 —— 这直接导致 11-11 的一次事故：
 * 换了安装方式后程序读到了另一个空目录，用户以为数据全丢了。
 *
 * ## 为什么改位置要重启
 *
 * Chromium 在**进程启动早期**就把 `userData` 与 IndexedDB 绑定了。
 * 运行中换目录做不到：要么写完两边各半库，要么页面里的路径与实际
 * 存储不一致。所以这里只负责「记下用户选的路径 + 告诉他重启生效」，
 * 真正的切换在下次启动时做（见下面的 pending 文件）。
 *
 * ## 为什么用文件而不是 settings 分区
 *
 * 这个路径决定**去哪个库读数据**，不能存在库里 —— 那是循环依赖。
 * 所以在 userData 之外放一个 `library-location.json`。
 * 读完就删（一次性指令），避免它一直覆盖后续的默认探测。
 */

import { useCallback, useEffect, useState } from 'react';
import './library-location.css';

/** preload 暴露的形状（可能不存在：浏览器 / 测试环境） */
interface PickDirResult {
  ok: boolean;
  message: string | null;
  dir: string;
}

interface LibraryBridge {
  location?: { dir?: string; dataDir?: string };
  pickDir?: () => Promise<PickDirResult | null>;
  reveal?: () => Promise<{ ok: boolean; message: string | null }>;
}

function bridge(): LibraryBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { openleaner?: { library?: LibraryBridge } }).openleaner?.library;
}

export interface LibraryLocationRowProps {
  /**
   * 紧凑模式：只显示路径 + 「打开」，不显示「更改位置」。
   * 顶栏那个工作库面板用紧凑模式 —— 那里空间小，改路径属于设置页的事。
   */
  compact?: boolean;
}

export function LibraryLocationRow({ compact = false }: LibraryLocationRowProps) {
  const [dir, setDir] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const loc = bridge()?.location;
    setDir(loc?.dir ?? null);
  }, []);

  const pick = useCallback(async () => {
    const b = bridge();
    if (!b?.pickDir) {
      setNote('这个环境不支持选择目录（需要在桌面应用里用）。');
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const r = await b.pickDir();
      /* null = 用户取消，不提示、不当作错误 */
      if (r === null) return;
      if (!r.ok) {
        setNote(r.message ?? '记下新位置失败');
        return;
      }
      setPicked(r.dir);
      setNote(null);
    } catch (e) {
      setNote(e instanceof Error ? e.message : '选择目录失败');
    } finally {
      setBusy(false);
    }
  }, []);

  const reveal = useCallback(async () => {
    const b = bridge();
    if (!b?.reveal) {
      setNote('这个环境不支持打开目录（需要在桌面应用里用）。');
      return;
    }
    try {
      const r = await b.reveal();
      if (!r.ok && r.message) setNote(`打不开目录：${r.message}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : '打开目录失败');
    }
  }, []);

  /*
   * 拿不到路径（浏览器环境 / preload 没注入）。
   * 如实说明，而不是显示一个空行让人以为路径是空的。
   */
  if (!dir) {
    return (
      <div className="lib-loc">
        <span className="lib-loc__label">保存位置</span>
        <span className="lib-loc__unknown">读不到（需要在桌面应用里打开）</span>
      </div>
    );
  }

  return (
    <div className={`lib-loc${compact ? ' lib-loc--compact' : ''}`}>
      <span className="lib-loc__label">保存位置</span>

      <code className="lib-loc__path" title={picked ?? dir}>
        {picked ?? dir}
      </code>

      <div className="lib-loc__actions">
        <button type="button" className="lib-loc__btn" onClick={() => void reveal()}>
          打开文件夹
        </button>
        {!compact ? (
          <button
            type="button"
            className="lib-loc__btn"
            onClick={() => void pick()}
            disabled={busy}
          >
            {busy ? '选择中…' : '更改位置'}
          </button>
        ) : null}
      </div>

      {picked ? (
        <p className="lib-loc__note lib-loc__note--warn">
          已选新位置 <code>{picked}</code>，<strong>重启软件后生效</strong>。
          重启时会把当前学习库的数据复制到新位置；原位置的数据会保留，确认无误后可自行删除。
        </p>
      ) : null}

      {note ? <p className="lib-loc__note">{note}</p> : null}

      <p className="lib-loc__hint">
        资料、知识点、题目、复习记录都在这个文件夹里。换电脑前把整个文件夹拷走即可。
      </p>
    </div>
  );
}

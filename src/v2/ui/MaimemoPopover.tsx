/**
 * 阅读器里的「加入墨墨生词本」浮层（2026-11-09）。
 *
 * ## 交互
 *
 * 在正文里划选英文 → 浮出一个小气泡「加入墨墨生词本（N 个词）」→ 点一下导入。
 *
 * ## 为什么用浮层而不是右键菜单
 *
 * 右键菜单在 Electron 里要占一个原生菜单，而且会被 `lockDownNavigation`
 * 那套守卫牵连。浮层是纯 DOM，可控、可测、样式统一。
 *
 * ## 为什么只对英文生效
 *
 * 墨墨的词库是英文单词。划中文时浮层根本不出现 —— 不是「点了报错」，
 * 而是「不给一个做不到的入口」（项目里「不做假开关」那条）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { extractWords, MaimemoClient, maimemoConfigFromSettings } from '@/core/maimemo.ts';
import './maimemo-popover.css';

export interface MaimemoPopoverProps {
  /** 阅读器正文容器；监听它的 mouseup 取选中文本 */
  containerRef: React.RefObject<HTMLElement | null>;
  /** 从 settings 读配置（每次点开时现读，设置改了立刻生效） */
  loadSettings: () => Promise<unknown>;
  /** 导入成功后通知上层（可用于刷新小组件等） */
  onImported?: (count: number) => void;
}

/** 浮层状态 */
type Phase =
  | { kind: 'hidden' }
  | { kind: 'ready'; words: string[]; x: number; y: number }
  | { kind: 'busy'; words: string[] }
  | { kind: 'done'; count: number }
  | { kind: 'error'; message: string; hint?: string };

export function MaimemoPopover({ containerRef, loadSettings, onImported }: MaimemoPopoverProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'hidden' });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* 卸载时清掉提示计时器，避免往已卸载组件里写状态 */
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const hide = useCallback(() => setPhase({ kind: 'hidden' }), []);

  /**
   * 监听正文的 mouseup / keyup。
   *
   * keyup 是为了键盘选择（Shift+方向键选词）也能触发 ——
   * 只用 mouseup 会让纯键盘用户用不了这个功能。
   */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onSelectionEnd = () => {
      /*
       * 延迟一帧再取选中内容：mouseup 时浏览器的 selection 有时还没最终确定
       * （拖选的最后一两个字会漏）。setTimeout(0) 稳一些。
       */
      setTimeout(() => {
        const sel = typeof window !== 'undefined' ? window.getSelection() : null;
        const raw = sel ? sel.toString() : '';
        const words = extractWords(raw);

        /* 没有可用的英文词 → 不出现浮层（中文/纯数字划选就此静默） */
        if (words.length === 0) {
          hide();
          return;
        }

        /* 浮层贴着选区的末尾下方，不挡正在读的那一行 */
        let x = 24;
        let y = 80;
        try {
          const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
          const rect = range ? range.getBoundingClientRect() : null;
          if (rect) {
            x = Math.max(12, Math.min(window.innerWidth - 260, rect.left));
            y = rect.bottom + 8;
          }
        } catch {
          /* 取不到位置就用默认值，浮层仍然可用 */
        }

        setPhase({ kind: 'ready', words, x, y });
      }, 0);
    };

    el.addEventListener('mouseup', onSelectionEnd);
    el.addEventListener('keyup', onSelectionEnd);
    return () => {
      el.removeEventListener('mouseup', onSelectionEnd);
      el.removeEventListener('keyup', onSelectionEnd);
    };
  }, [containerRef, hide]);

  const doImport = useCallback(
    async (words: string[]) => {
      setPhase({ kind: 'busy', words });
      try {
        const settings = await loadSettings();
        const cfg = maimemoConfigFromSettings(settings);

        if (!cfg.token) {
          setPhase({
            kind: 'error',
            message: '还没有填墨墨的 access token。',
            hint: '到「设置 → 墨墨生词本」里填一个（在墨墨 App 内生成）。',
          });
          return;
        }
        if (!cfg.notepadId) {
          setPhase({
            kind: 'error',
            message: '还没有选目标云词本。',
            hint: '到「设置 → 墨墨生词本」里点「读取我的词本」，再选一个。',
          });
          return;
        }

        const client = new MaimemoClient({ token: cfg.token });
        const r = await client.importWords({ notepadId: cfg.notepadId, words });

        if (!r.ok) {
          setPhase({
            kind: 'error',
            message: r.message,
            hint:
              r.trouble === 'unauthorized'
                ? 'token 可能过期了。到墨墨 App 里重新生成一个，再填进设置。'
                : r.trouble === 'network'
                  ? '检查一下网络。断网时这个功能用不了，但它不影响阅读。'
                  : undefined,
          });
          return;
        }

        setPhase({ kind: 'done', count: r.data.imported });
        onImported?.(r.data.imported);
        /* 成功提示 2.5 秒后自动收起，不用用户手动关 */
        timerRef.current = setTimeout(hide, 2500);
      } catch (e) {
        setPhase({
          kind: 'error',
          message: e instanceof Error ? e.message : '导入失败',
        });
      }
    },
    [loadSettings, onImported, hide],
  );

  if (phase.kind === 'hidden') return null;

  /*
   * 定位只对 ready 阶段有意义（其它阶段没有坐标）。
   *
   * 用 style 直接写 left/top 而不是 class：坐标是运行时算出来的，
   * 写进 CSS 类做不到。其余外观仍在 mm-pop 类里。
   */
  const pos = positionOf(phase);

  return (
    <div
      className={
        'mm-pop' +
        (phase.kind === 'error' ? ' mm-pop--error' : '') +
        (pos ? ' mm-pop--anchored' : '')
      }
      style={pos ? { left: pos.left, top: pos.top } : undefined}
    >
      {phase.kind === 'ready' ? (
        <>
          <span className="mm-pop__text">
            选中 {phase.words.length} 个英文词
            {phase.words.length <= 3 ? `：${phase.words.join('、')}` : ''}
          </span>
          <button type="button" className="mm-pop__go" onClick={() => void doImport(phase.words)}>
            加入墨墨生词本
          </button>
          <button type="button" className="mm-pop__close" aria-label="关掉" onClick={hide}>
            ×
          </button>
        </>
      ) : null}

      {phase.kind === 'busy' ? <span className="mm-pop__text">正在导入 {phase.words.length} 个词…</span> : null}

      {phase.kind === 'done' ? (
        <span className="mm-pop__text mm-pop__text--ok">✓ 已导入 {phase.count} 个词到墨墨</span>
      ) : null}

      {phase.kind === 'error' ? (
        <>
          <div className="mm-pop__body">
            <span className="mm-pop__text">✕ {phase.message}</span>
            {phase.hint ? <span className="mm-pop__hint">{phase.hint}</span> : null}
          </div>
          <button type="button" className="mm-pop__close" aria-label="关掉" onClick={hide}>
            ×
          </button>
        </>
      ) : null}
    </div>
  );
}

/**
 * 给浮层定位的包装：把 ready 状态里的 x/y 应用上去。
 *
 * 单独抽出来是因为阶段联合类型里只有 ready 有坐标，
 * 直接在组件里写 `phase.x` 会被 TS 拦（其它分支没有）。
 */
export function positionOf(phase: Phase): { left: number; top: number } | null {
  return phase.kind === 'ready' ? { left: phase.x, top: phase.y } : null;
}

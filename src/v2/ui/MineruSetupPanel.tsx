/**
 * 解析工具（MinerU）设置面板（2026-11-11）。
 *
 * ## 它补的是什么缺口
 *
 * 代码里至少三处文案写着「到设置里填 mineru 路径」：
 *   - `electron/mineru.cjs` 的探测失败消息
 *   - `ConvertPanel.tsx` 的 `hintForTrouble('not-installed')`
 *   - 新加的「无文字层」提醒
 *
 * 但设置页**从来没有那一项** —— 只能靠环境变量 `MINERU_EXE`。
 * 用户照着提示来设置里找，找不到。这是「说了没做」，属于硬约束第 7 条
 * 明令禁止的那类问题（不做假开关 / 不指向不存在的地方）。
 *
 * ## 为什么只做「状态 + 手动路径 + 说明」，不做一键安装
 *
 * 用户选了方案一。技术上也确实不该由我们装：
 * MinerU 依赖 torch、几个 GB 的模型权重、还要挑 Python 版本；
 * 由应用替用户装 Python 环境，失败率高且难以验证干净。
 * 如实给出**可复制的命令**比替用户做更可靠。
 *
 * ## 关于镜像地址
 *
 * 用户特别问「官网没装成功能不能给镜像」。所以说明里直接给
 * 国内 pip 镜像与 ModelScope 模型源 —— 这两处是国内安装失败的最常见原因
 * （PyPI 慢、HuggingFace 不通），不是 MinerU 本身的问题。
 *
 * 来源：MinerU 官方 README（GitHub OpenDataLab/MinerU）
 *   pip install uv -i https://mirrors.aliyun.com/pypi/simple
 *   set MINERU_MODEL_SOURCE=modelscope
 * 以及社区实践里反复提到的两个坑（VC++ 运行库、Python 版本）。
 */

import { useCallback, useEffect, useState } from 'react';
import './mineru-setup.css';

/** preload 暴露的 mineru 桥（可能不存在：浏览器 / 测试环境） */
interface MineruBridge {
  available?: boolean;
  unavailableReason?: string;
}

interface MineruCustomBridge {
  path?: string | null;
  pick?: () => Promise<{ ok: boolean; message: string | null; path: string } | null>;
  set?: (p: string | null) => Promise<{ ok: boolean; message: string | null }>;
}

function bridge(): MineruBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { openleaner?: { mineru?: MineruBridge } }).openleaner?.mineru;
}

/** 手工路径那条桥（与 mineru 分开：它管的是「配置」，不是「跑转换」） */
function customBridge(): MineruCustomBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { openleaner?: { mineruCustom?: MineruCustomBridge } }).openleaner
    ?.mineruCustom;
}

/** 一行「命令 + 复制」 */
function Cmd({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板不可用就不提示成功 —— 不撒谎 */
    }
  }, [text]);

  return (
    <div className="mineru-cmd">
      <code>{text}</code>
      <button type="button" className="mineru-cmd__copy" onClick={() => void copy()}>
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}

export function MineruSetupPanel() {
  const [path, setPath] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    const b = bridge();
    setAvailable(Boolean(b?.available));
    setReason(b?.unavailableReason ?? null);
    setPath(customBridge()?.path ?? null);
  }, []);

  const pick = useCallback(async () => {
    const c = customBridge();
    if (!c?.pick) {
      setNote('这个环境不支持选择文件（需要在桌面应用里用）。');
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const r = await c.pick();
      if (r === null) return; /* 用户取消 */
      if (!r.ok) {
        setNote(r.message ?? '设置失败');
        return;
      }
      setPath(r.path);
      setNote('已记下。重启软件后生效。');
    } catch (e) {
      setNote(e instanceof Error ? e.message : '选择失败');
    } finally {
      setBusy(false);
    }
  }, []);

  const clear = useCallback(async () => {
    const c = customBridge();
    if (!c?.set) return;
    setBusy(true);
    try {
      const r = await c.set(null);
      if (r.ok) {
        setPath(null);
        setNote('已清除手动指定，回到自动探测。');
      } else {
        setNote(r.message ?? '清除失败');
      }
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <>
      <div className="set-section">
        <h2 className="set-section__title">文档解析（MinerU）</h2>
        <p className="set-section__lead">
          扫描件、拍照、截图这类文件里的字是「图片」而不是「文本」，
          软件自己读不到。MinerU 能把图里的字转成正文，之后就能整理知识点、出题、搜索。
          <strong>不装也不影响普通 PDF / Word / PPT / Markdown 的导入。</strong>
        </p>

        <div className={`mineru-status${available ? ' mineru-status--on' : ''}`}>
          <span className="mineru-status__dot" aria-hidden="true" />
          <span className="mineru-status__text">
            {available ? '已找到本机的 MinerU' : '本机还没有可用的 MinerU'}
          </span>
        </div>

        {!available && reason ? <p className="set-hint">{reason}</p> : null}

        {/* ---- 手动指定路径 ---- */}
        <div className="mineru-path">
          <span className="set-label">mineru.exe 路径</span>
          <div className="mineru-path__row">
            <code className="mineru-path__value">{path ?? '（自动探测）'}</code>
            <button type="button" className="mineru-btn" onClick={() => void pick()} disabled={busy}>
              {busy ? '处理中…' : '选择文件'}
            </button>
            {path ? (
              <button type="button" className="mineru-btn" onClick={() => void clear()} disabled={busy}>
                清除
              </button>
            ) : null}
          </div>
          <p className="set-hint">
            装到非默认位置时用它指定。默认会依次找：
            环境变量 <code>MINERU_EXE</code>、应用数据目录下的
            <code>mineru\venv\Scripts\mineru.exe</code>、以及几个常见安装位置。
          </p>
        </div>
      </div>

      {/* ---- 安装说明（含镜像）---- */}
      <div className="set-section">
        <h2 className="set-section__title">怎么装 MinerU</h2>
        <p className="set-section__lead">
          下面全部在 <strong>Windows 终端（CMD 或 PowerShell）</strong>里执行。
          国内直连 PyPI 与 HuggingFace 常常很慢，所以每一步都给了镜像。
        </p>

        <ol className="mineru-steps">
          <li>
            <p className="mineru-steps__title">装 Python（3.10 ~ 3.12）</p>
            <p className="mineru-steps__body">
              MinerU 对 Python 版本敏感，别用最新的。到 python.org 下 3.11 或 3.12，
              安装时勾上 <code>Add Python to PATH</code>。
            </p>
          </li>

          <li>
            <p className="mineru-steps__title">装 uv（比 pip 快很多）</p>
            <Cmd text={'pip install uv -i https://mirrors.aliyun.com/pypi/simple'} />
            <p className="mineru-steps__body">
              装不上 uv 也行，把后面的 <code>uv pip install</code> 换成
              <code>pip install</code>（同样带 <code>-i</code> 镜像）。
            </p>
          </li>

          <li>
            <p className="mineru-steps__title">装 MinerU</p>
            <Cmd text={'uv pip install -U "mineru[core]" -i https://mirrors.aliyun.com/pypi/simple'} />
            <p className="mineru-steps__body">
              要命令行工具再加 <code>[cli]</code>；想一次装全用 <code>[all]</code>
              （体积大很多）。
            </p>
          </li>

          <li>
            <p className="mineru-steps__title">把模型源切到国内（关键一步）</p>
            <Cmd text={'set MINERU_MODEL_SOURCE=modelscope'} />
            <p className="mineru-steps__body">
              模型默认从 HuggingFace 下，国内经常卡住或断连；切到 ModelScope 快得多。
              这条只对当前窗口有效，装完可以不管 —— 首次解析时会自动下模型。
              想永久生效就在系统环境变量里加一条同名的。
            </p>
          </li>

          <li>
            <p className="mineru-steps__title">验证</p>
            <Cmd text={'mineru --version'} />
            <p className="mineru-steps__body">
              能打印版本号就成了。然后在上面「mineru.exe 路径」里选中它，重启软件。
            </p>
          </li>
        </ol>

        <h3 className="mineru-sub">装不上时先看这三条</h3>
        <ul className="mineru-tips">
          <li>
            <strong>报 <code>msvcp140.dll</code> 找不到</strong>
            ：装一次微软 VC++ 运行库（x64），不是 MinerU 的问题。
          </li>
          <li>
            <strong>卡在下载模型</strong>：确认执行过
            <code>set MINERU_MODEL_SOURCE=modelscope</code>；
            还不行就设 <code>MINERU_MODEL_CACHE</code> 指到空间大的盘再重试。
          </li>
          <li>
            <strong>装完 <code>mineru</code> 命令不认</strong>
            ：用 <code>where mineru</code> 找真实路径，直接填进上面的输入框，
            不用管 PATH。
          </li>
        </ul>

        <p className="set-hint">
          官方文档：
          <a href="https://github.com/OpenDataLab/MinerU" target="_blank" rel="noreferrer">
            github.com/OpenDataLab/MinerU
          </a>
          。国内镜像可用清华（<code>pypi.tuna.tsinghua.edu.cn/simple</code>）
          或阿里云（<code>mirrors.aliyun.com/pypi/simple</code>）。
        </p>

        {note ? <p className="mineru-note">{note}</p> : null}
      </div>
    </>
  );
}

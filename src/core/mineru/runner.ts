/**
 * 谁去跑 MinerU —— 三种环境，三种答案。
 *
 * ## 为什么不直接在渲染进程 spawn
 *
 * 渲染进程没有 Node 权限（`nodeIntegration: false`，这是安全边界，不能为了
 * 省事去关）。所以真跑子进程的只有**桌面版主进程**，通过 IPC 暴露一个受限接口。
 *
 * ## 三个环境
 *
 * | 环境 | 能跑吗 | 怎么做 |
 * | --- | --- | --- |
 * | 桌面版（Electron） | ✅ | `window.openleaner.mineru` 走 IPC → 主进程 spawn |
 * | 浏览器直开（vite dev / preview） | ❌ | 明确告诉用户「这是桌面版功能」，**不摆假按钮** |
 * | 测试 | ✅ | 注入假 runner |
 *
 * 这里的关键约束是第 2 条：浏览器里跑不了就是跑不了，要说清楚，
 * 而不是转一半失败、或者给一个点了没反应的按钮。
 */

import type { MinerUResult } from './convert.ts';

/** 一次转换请求 */
export interface MinerURequest {
  /** 原文件的绝对路径（桌面版才拿得到真实路径） */
  filePath: string;
  /** MinerU 可执行文件路径（mineru-kit） */
  exePath: string;
  /** 输出目录 */
  outDir: string;
  /** 解析档位：basic（只用 ONNX 小模型）/ standard（小模型 + VLM） */
  tier?: 'flash' | 'basic' | 'standard' | 'advanced';
  /** 取消信号 */
  signal?: AbortSignal;
}

/** 转换进度（MinerU 的 stderr 里有进度，我们抽成结构化事件） */
export interface MinerUProgress {
  /** 阶段：准备 / 模型 / 版面 / OCR / 完成 */
  phase: string;
  /** 0-1，未知时 null（不编造百分比） */
  ratio: number | null;
  /** 额外细节，如「3/12 页」 */
  detail?: string | null;
  /** 原始日志行，用于界面显示「正在做什么」 */
  line?: string;
}

/** 跑一次转换的抽象。桌面版与测试各自实现。 */
export interface MinerURunner {
  readonly available: boolean;
  /** 不可用时给出**具体**原因，界面原样显示 */
  readonly unavailableReason?: string;
  run(request: MinerURequest, onProgress?: (p: MinerUProgress) => void): Promise<MinerUResult>;
}

/**
 * 取当前环境的 runner。
 *
 * 桌面版返回真实现；其余环境返回一个**如实说不能用**的实现。
 * 全局 `Window.openleaner.mineru` 的类型在 src/vite-env.d.ts 里声明，
 * 这里不重复声明（重复会让 TS 报「属性类型不一致」）。
 */
export function getMinerURunner(): MinerURunner {
  const bridge = typeof window !== 'undefined' ? window.openleaner?.mineru : undefined;

  if (bridge && bridge.available) {
    return {
      available: true,
      async run(request, onProgress) {
        const unsubscribe = onProgress ? bridge.onProgress(onProgress) : undefined;
        try {
          const res = await bridge.run({
            filePath: request.filePath,
            exePath: request.exePath,
            outDir: request.outDir,
            ...(request.tier ? { tier: request.tier } : {}),
          });
          if (!res.ok) {
            // 主进程给的 trouble 是分类好的，原样往上传
            const err = new Error(res.message) as Error & { trouble?: string };
            if (res.trouble) err.trouble = res.trouble;
            throw err;
          }
          const { parseMiddleJson } = await import('./convert.ts');
          return parseMiddleJson(res.result);
        } finally {
          unsubscribe?.();
        }
      },
    };
  }

  const reason = bridge?.unavailableReason
    ? bridge.unavailableReason
    : '这个功能需要桌面版：浏览器里没法调用本机的 MinerU。';

  return {
    available: false,
    unavailableReason: reason,
    async run() {
      throw new Error(reason);
    },
  };
}

/**
 * 用于测试与离线验证的假 runner。
 *
 * 它接受一个「文件名 → 结果」的映射，让上层流程（写回分段、
 * 建对照表、进度显示）能在不装 MinerU 的机器上被完整验证。
 */
export function createFakeRunner(
  byFileName: Record<string, MinerUResult>,
): MinerURunner {
  return {
    available: true,
    async run(request, onProgress) {
      const name = request.filePath.split(/[\\/]/).pop() ?? '';
      const hit = byFileName[name];
      if (!hit) {
        throw new Error(`假 runner 里没有「${name}」的预设结果`);
      }
      onProgress?.({ phase: '完成', ratio: 1 });
      return hit;
    },
  };
}

/**
 * 解析引擎的选择逻辑（2026-11-15）。
 *
 * 纯逻辑单独放，理由与项目里其它 `*.ts`（reader-scroll / read-progress /
 * rename）一致：界面里难测的「该不该允许选、选了哪个」抽出来钉住。
 *
 * ## 三条规则
 *
 * 1. **默认本地 MinerU**。它是原有行为，不能因为加了云 OCR 就改变
 *    老用户的默认（那会让「没联网」的用户突然解析不了）。
 * 2. **云 OCR 需要可用的后端**（有 Key）。没有就禁用并说明原因，
 *    而不是让用户选完点了才报错（不做假开关）。
 * 3. **本地不可用时，若云端可用则自动选云端**。反过来不行 ——
 *    云端要花钱，不能悄悄替用户决定花钱。
 */

export type MinerUEngine = 'local' | 'deepseek';

export interface EngineAvailability {
  /** 本地 MinerU 是否可用 */
  localOk: boolean;
  /** 本地不可用的原因（界面原样显示） */
  localReason?: string | null;
  /** 云端是否可用（有可用后端 + 有 Key） */
  cloudOk: boolean;
  /** 云端不可用的原因 */
  cloudReason?: string | null;
}

/**
 * 该默认选哪个引擎。
 *
 * 顺序：优先本地（原有行为、免费）；本地不可用且云端可用 → 云端；
 * 两个都不行 → 仍返回本地（让界面去显示「两边都不能用」的原因，
 * 而不是返回 null 让界面多写一个分支）。
 */
export function defaultEngine(av: EngineAvailability): MinerUEngine {
  if (av.localOk) return 'local';
  if (av.cloudOk) return 'deepseek';
  return 'local';
}

/**
 * 用户当前选的那个引擎现在还能不能用。
 *
 * 用途：用户选了云端、然后又去设置里删掉了后端 —— 回到这一页时
 * 选择器不该还显示「云端」并且可点，那会点了才报错。
 *
 * @returns 纠正后的引擎；无需纠正则原样返回
 */
export function reconcileEngine(
  current: MinerUEngine,
  av: EngineAvailability,
): { engine: MinerUEngine; changed: boolean } {
  if (current === 'local' && !av.localOk) {
    /* 本地挂了：云端能用就切过去，否则留在本地（界面会显示原因） */
    return av.cloudOk ? { engine: 'deepseek', changed: true } : { engine: 'local', changed: false };
  }
  if (current === 'deepseek' && !av.cloudOk) {
    /*
     * 云端不可用：**切回本地**（不是留在云端）。
     * 留在一个用不了的选项上，用户点「开始解析」只会得到报错。
     */
    return av.localOk ? { engine: 'local', changed: true } : { engine: 'deepseek', changed: false };
  }
  return { engine: current, changed: false };
}

/** 这条引擎在界面上显示的名字（日志/提示里用同一份措辞，不各写一遍） */
export function engineLabel(engine: MinerUEngine): string {
  return engine === 'deepseek' ? 'DeepSeek 云 OCR' : '本地 MinerU';
}

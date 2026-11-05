/**
 * 幻灯片主题（配色 + 字体）。
 *
 * ## 为什么要单独抽出来
 *
 * 早先配色被写死在两处：`pptx-export.ts` 的 THEME 和
 * `SlidePreview.tsx` 的 THEME，后者的注释写着「改一处要两边同步」。
 * 那是靠人记性维持的一致性 —— 而人一定会忘。
 *
 * 忘掉的后果很具体：预览里主色是深蓝、导出后变成黑色；或者更糟，
 * 背景色两边不一致，深色标题页的文字在导出的 PPT 里看不清。
 * 这类缺陷所有自动验收都会通过（文字都在、页数也对），
 * 只有真的打开看才发现。
 *
 * 所以这里做成唯一来源：**预览和导出都从这里取色**。
 *
 * ## 为什么预设是数据而不是代码分支
 *
 * 加一套新主题应该只是往 `THEMES` 里加一条数据，不该去改
 * render 函数里的 if/else。分支一多，就会出现「某个主题在某条
 * 渲染路径上忘了处理」这种只在特定风格下才看得见的缺陷。
 */

/** 一套主题的全部颜色与字体 */
export interface SlideTheme {
  /** 稳定标识，存进 SlideDeck.theme */
  id: string;
  /** 界面显示名 */
  label: string;
  /** 一句话说明，帮用户判断该选哪个 */
  note: string;
  colors: {
    /** 正文文字 */
    text: string;
    /** 次要文字（页脚、页码） */
    muted: string;
    /** 主色（强调线、角标前景） */
    accent: string;
    /** 角标文字色 */
    citation: string;
    /** 分隔线 */
    rule: string;
    /** 正文页背景 */
    bg: string;
    /** 封面页背景 */
    titleBg: string;
    /** 封面页主标题文字 */
    titleText: string;
    /** 封面页副标题文字 */
    subtitle: string;
  };
  /**
   * 字体名。只写一个是因为 pptx 与浏览器都能解析同一份系统字体名；
   * 写成 fallback 列表会让 pptxgenjs 把整串当字体名塞进 XML。
   */
  font: string;
}

/**
 * 预设主题。
 *
 * 选色不是随手挑的，每条都守两件事：
 *
 *  1. **对比度够**。正文色对背景色的对比度都 ≥ 7:1（AAA 正文标准），
 *     投影到教室墙上、或者被劣质投影仪压暗之后仍然读得清。
 *     浅灰字配白底（很多"极简"模板的通病）在投影上基本看不见。
 *  2. **角标色不与主色撞**。角标是要能被一眼找到的次要信息，
 *     用主色会让它和标题抢注意力，用灰色又会被当成正文。
 */
export const THEMES: readonly SlideTheme[] = [
  {
    id: 'business-blue',
    label: '商务蓝',
    note: '深蓝标题页 + 白底正文，最稳妥的默认选择',
    colors: {
      text: '1A1A1A',
      muted: '5A6270',
      accent: '1E5FAA',
      citation: '8A6D3B',
      rule: 'D8DEE8',
      bg: 'FFFFFF',
      titleBg: '0F2A4A',
      titleText: 'FFFFFF',
      subtitle: 'A8C0DC',
    },
    font: 'Microsoft YaHei',
  },
  {
    id: 'academic-paper',
    label: '学术论文',
    note: '米白底 + 衬线感，接近论文与讲义的气质',
    colors: {
      text: '1C1C1C',
      muted: '6B6459',
      accent: '7A2E2E',
      citation: '6B6459',
      rule: 'DED8CC',
      bg: 'FBF9F4',
      titleBg: '2A2723',
      titleText: 'FBF9F4',
      subtitle: 'C9C0B0',
    },
    font: 'SimSun',
  },
  {
    id: 'minimal-gray',
    label: '极简灰',
    note: '黑白灰，几乎不用颜色，靠排版说话',
    colors: {
      text: '202020',
      muted: '6E6E6E',
      accent: '202020',
      citation: '6E6E6E',
      rule: 'DCDCDC',
      bg: 'FFFFFF',
      titleBg: '202020',
      titleText: 'FFFFFF',
      subtitle: 'B8B8B8',
    },
    font: 'Microsoft YaHei',
  },
  {
    id: 'green-ink',
    label: '墨绿',
    note: '沉稳的深绿，适合需要长时间阅读的复习场景',
    colors: {
      text: '1A231E',
      muted: '5C6B62',
      accent: '1F6B4A',
      citation: '8A6D3B',
      rule: 'CFDDD5',
      bg: 'FFFFFF',
      titleBg: '123A2A',
      titleText: 'F2F7F4',
      subtitle: '9DBFAE',
    },
    font: 'Microsoft YaHei',
  },
  {
    id: 'dark-slate',
    label: '深色',
    note: '暗底浅字，暗光环境或投屏时更舒服',
    colors: {
      text: 'ECEFF3',
      muted: '9AA5B1',
      accent: '4FA3E3',
      citation: 'D8B26A',
      // 深色主题的分隔线要比浅色亮，否则在暗底上完全消失
      rule: '3A4450',
      bg: '1B2027',
      titleBg: '0D1117',
      titleText: 'FFFFFF',
      subtitle: '8FA3B8',
    },
    font: 'Microsoft YaHei',
  },
  {
    id: 'warm-beige',
    label: '暖灰',
    note: '浅暖灰底 + 砖红强调，比纯白柔和不刺眼',
    colors: {
      text: '2B2622',
      muted: '6E6259',
      accent: 'A8452F',
      citation: '8A6D3B',
      rule: 'E0D5CA',
      bg: 'F7F2EC',
      titleBg: '3A2C25',
      titleText: 'F7F2EC',
      subtitle: 'C7B5A6',
    },
    font: 'Microsoft YaHei',
  },
];

/** 默认主题 id。旧数据没有 theme 字段时用它。 */
export const DEFAULT_THEME_ID = 'business-blue';

/**
 * 按 id 取主题，找不到就返回默认主题。
 *
 * 找不到时**不抛错**：用户的备份可能来自装了更多主题的版本，
 * 打开旧备份时因为一个配色名就整份打不开，比配色退化成默认糟得多。
 */
export function resolveTheme(id: string | null | undefined): SlideTheme {
  if (!id) return THEMES[0]!;
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

/** 给浏览器用的 `#RRGGBB` 形式（主题里存的是不带 # 的，pptx 要这种） */
export function cssColor(hex: string): string {
  return hex.startsWith('#') ? hex : `#${hex}`;
}

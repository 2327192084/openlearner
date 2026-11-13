import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 导航返回栈（2026-11-09）。
 *
 * ## 为什么这组测试是「结构性」的
 *
 * `useNavHistory` 是个 hook，要测它得渲染组件（本项目 vitest 跑在 node
 * 环境，没有 jsdom，也没有 @testing-library）。为这一个 hook 装一整套
 * DOM 测试栈不划算。
 *
 * 所以这里守的是**更容易出错、且错了很难发现的那部分**：约定本身。
 *  - 页面跳转必须走统一入口（散落的 setPage 会让来路记录漏掉）
 *  - 阅读器的返回必须回到来路，而不是一律回「资料」
 *  - 左上角按钮在没有来路时不能渲染（不做点了没反应的箭头）
 *
 * 这些都是源码层面的约定，用「读源码 + 断言关键片段」钉住。
 * 真实交互行为靠 Electron 端到端脚本验证（见提交说明）。
 */

const appSrc = readFileSync(resolve('src/v2/ui/App.tsx'), 'utf8');
const shellSrc = readFileSync(resolve('src/v2/ui/AppShell.tsx'), 'utf8');

describe('导航来路记录', () => {
  it('存在 navStackRef 与 canGoBack 两个抓手', () => {
    expect(appSrc).toContain('navStackRef');
    expect(appSrc).toContain('canGoBack');
  });

  it('阅读器的 8 处入口都走 openReader，不散落 setPage(\'reader\')', () => {
    /*
     * 这条最有价值：漏一处的表现是「从某个页面进去后返回跳到了别处」，
     * 而那个页面用户未必常去，很容易漏测。
     *
     * 只数**代码**里的调用（排除注释与字符串）。注释里为了解释历史
     * 会提到这行字面量，误计会让断言变成噪音。
     */
    const codeOnly = appSrc
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
      })
      .join('\n');

    const bare = codeOnly.split("setPage('reader')").length - 1;
    expect(bare).toBe(0);
    expect(appSrc).toContain('const openReader = useCallback');
  });

  it('openReader 记录来路（setReaderFrom）', () => {
    expect(appSrc).toContain('setReaderFrom(prev)');
  });

  it('阅读器 onBack 用 closeReader 而不是写死回 sources', () => {
    expect(appSrc).toContain('onBack={closeReader}');
    /* 老写法应当不存在了 */
    expect(appSrc).not.toContain("onBack={() => setPage('sources')}\n          }");
  });

  it('返回按钮带上来路的页名（用户要知道自己在哪）', () => {
    expect(appSrc).toContain('PAGE_LABEL_FOR_BACK');
    expect(appSrc).toContain("wrongbook: '错题与待巩固'");
    expect(appSrc).toContain("knowledge: '知识库'");
  });
});

describe('左上角返回按钮', () => {
  it('只有 canGoBack 为真时才渲染（不做点了没反应的箭头）', () => {
    expect(shellSrc).toContain('onBack && canGoBack');
  });

  it('按钮有可读的 aria-label', () => {
    expect(shellSrc).toContain('aria-label={backToLabel');
  });

  it('样式写在 @layer 之外（原生 button 的硬约束）', () => {
    /*
     * base.css 有不在 @layer 内的 `button { font: inherit }`，
     * 级联层级先于特异性。写层内会被盖掉 —— 项目踩过六次以上。
     */
    const css = readFileSync(resolve('src/v2/ui/shell.css'), 'utf8');
    const idx = css.indexOf('.topbar__back {');
    expect(idx).toBeGreaterThan(0);

    /* 找它所在的 @layer 块范围：本文件是单个 @layer study.components { ... } */
    const layerStart = css.indexOf('@layer study.components {');
    /* 块结束：从 layerStart 起找最后一个 '}' 前的闭合（简单起见看是否在括号深度内） */
    let depth = 0;
    let layerEnd = -1;
    for (let i = layerStart; i < css.length; i++) {
      const ch = css[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          layerEnd = i;
          break;
        }
      }
    }
    expect(layerStart).toBeGreaterThan(-1);
    expect(layerEnd).toBeGreaterThan(-1);
    /* .topbar__back 必须落在 layer 块之外 */
    expect(idx > layerEnd || idx < layerStart).toBe(true);
  });
});

describe('「开始复习」不再等于「开始做题」', () => {
  const studySrc = readFileSync(resolve('src/v2/ui/StudyPage.tsx'), 'utf8');

  it('两个选项走不同的回调', () => {
    expect(studySrc).toContain('onStartQuiz');
    /*
     * 2026-11-13 深夜改：回调名从 onStartReview 换成 onOpenReviewBook。
     *
     * 用户原话：「开始复习功能不用这种翻面闪卡样式了，
     * 就做成一个跳转到复习巩固栏目的按钮吧」。
     * 这一项从「就地起一轮复习」变成「跳到那一页」，
     * 回调改名是刻意的 —— 名字要说明它现在只是带路。
     */
    expect(studySrc).toContain('onOpenReviewBook');
  });

  it('review 分支不与做题共用回调（守住「复习≠做题」这条）', () => {
    /*
     * 这条守的意图**没变**：复习这一项绝不能调 onStartQuiz。
     * 原来用户实测指出「两个按钮跳到同一个页面，所以复习功能从未实现」；
     * 现在复习改成跳「复习巩固」，仍然必须与「开始做题」分开。
     *
     * 断言从「必须含 onStartReview」改成「必须含 onOpenReviewBook」——
     * 实现换了，但**要防的那件事完全一样**。
     */
    const reviewBlock = studySrc.slice(
      studySrc.indexOf("if (opt.id === 'review')"),
      studySrc.indexOf("if (opt.id === 'knowledge')"),
    );
    expect(reviewBlock.length).toBeGreaterThan(0);
    expect(reviewBlock).toContain('onOpenReviewBook');
    expect(reviewBlock).not.toContain('onStartQuiz');
  });

  it('★ 复习不再自己起翻面会话（那种交互归闪卡了）', () => {
    /*
     * 用户明确要求把「翻面闪卡样式」从复习里拿掉。
     * 所以这一页不该再引用 startTodayReview（起会话的动作），
     * 也不该再自己判断「今天有没有到期」—— 那是复习巩固页的事。
     */
    expect(studySrc).not.toContain('startTodayReview');
    expect(studySrc).not.toContain('今天没有到期的卡');
  });
});

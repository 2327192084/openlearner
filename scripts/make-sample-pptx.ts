/**
 * 生成一份真实 .pptx 样本，供 python-pptx 交叉验证。
 *
 * 为什么要单独跑这个：jsdom / vitest 里我们是「解压 zip 找 <a:t>」，
 * 只证明字节里有这段文字。计划书要求「在 Office 和 WPS 里正常打开、
 * 不乱版、文字可编辑」，那必须由**另一套独立实现**读一遍才算数。
 *
 * 用法：npx vite-node scripts/make-sample-pptx.ts [--out 路径] [--points 条数]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { KnowledgePoint, SlideDeck } from '../src/core/model.ts';
import { buildOutline } from '../src/core/slides/outline.ts';
import { exportToPptx } from '../src/core/slides/pptx-export.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const outPath = arg('out', '.verify-shots/sample.pptx');
const pointCount = Number(arg('points', '12'));

/** 造 n 条知识点：每 3 条里有 1 条故意不带位置（验证「不给假角标」）。 */
function makePoints(n: number): KnowledgePoint[] {
  const now = new Date().toISOString();
  return Array.from({ length: n }, (_, i) => {
    const located = i % 3 !== 2;
    const no = String(i + 1).padStart(2, '0');
    const chapter = `第 ${(i % 3) + 1} 章`;
    const topic = ['信号与系统', '傅里叶变换', '拉普拉斯变换', '抽样定理'][i % 4];
    const quote = located ? `${topic}的原文摘录第 ${no} 段` : '';
    return {
      id: `kp-${no}`,
      statement:
        i % 2 === 0
          ? `${topic}：这是第 ${no} 条要点的说明文字，用于验证导出后的可编辑性与分页是否正确。`
          : `${topic}：第 ${no} 条要点较长，用来测试自动分页逻辑。当一个页面的要点超过五条、或单条超过八十八字时，应当拆成续页而不是截断内容，这样才不会丢东西。`,
      chapter,
      cognitiveLevel: 'understand',
      tags: [topic],
      anchors: located
        ? [
            {
              sourceId: 'src-01',
              page: (i % 5) + 1,
              chapter,
              charStart: 0,
              charEnd: quote.length,
            },
          ]
        : [],
      quotes: located ? [quote] : [],
      anchorStatus: located ? 'located' : 'unlocated',
      origin: 'material',
      sourceId: 'src-01',
      backendId: 'mock',
      createdAt: now,
      updatedAt: now,
    } satisfies KnowledgePoint;
  });
}

async function main(): Promise<void> {
  const points = makePoints(pointCount);
  const built = buildOutline({
    points,
    sourceTitle: '信号与系统（第 3 版）',
    title: '第 3 章 傅里叶变换复习',
  });

  const now = new Date().toISOString();
  const deck: SlideDeck = {
    id: 'deck-sample',
    title: '第 3 章 傅里叶变换复习',
    courseId: null,
    sourceId: 'src-01',
    status: 'ready',
    pages: built.pages,
    citations: built.citations,
    exports: [],
    createdAt: now,
    updatedAt: now,
  };

  const result = await exportToPptx(deck, 1);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, result.buffer);

  console.log(
    JSON.stringify(
      {
        out: outPath,
        fileName: result.fileName,
        slideCount: result.slideCount,
        outlinePages: built.pages.length,
        citations: built.citations.length,
        bulletsWithoutCitation: built.bulletsWithoutCitation,
        skippedPoints: built.skippedPoints,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

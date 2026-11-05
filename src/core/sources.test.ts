import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CourseService, SourceService, findAllFolded } from './sources.ts';
import { MemoryStorage } from './storage/memory-storage.ts';

/**
 * 资料服务测试。
 *
 * 对应计划书 P1「算做完」的四条：
 *  - 导入一份真实课件，翻页、搜索、目录跳转都对得上原文
 *  - 切分出来的每个片段，位置信息经抽查是准确的
 *  - 删除资料后，学习库不留脏数据
 *  - 一份扫描版 PDF 能被识别并给出下一步建议
 */

const FIXTURES = path.join(process.cwd(), 'src', 'test', 'fixtures');

function fixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
}

let storage: MemoryStorage;
let sources: SourceService;
let courses: CourseService;

beforeEach(() => {
  storage = new MemoryStorage();
  sources = new SourceService(storage);
  courses = new CourseService(storage);
});

describe('导入 PDF', () => {
  it('导入后能读到元信息，页数与段数正确', async () => {
    const source = await sources.importBuffer('数据结构复习.pdf', fixture('course.pdf'));

    expect(source.title).toBe('数据结构复习');
    expect(source.kind).toBe('pdf');
    expect(source.pageCount).toBe(3);
    expect(source.segmentCount).toBe(3);
    expect(source.textStatus).toBe('ready');
    expect(source.fileName).toBe('数据结构复习.pdf');
  });

  /**
   * 这条断言来自一个真实的、只在端到端跑才暴露的缺陷。
   *
   * pdfjs 的 `getDocument({data})` 会把传入的 ArrayBuffer **转移（detach）**走。
   * 早先的顺序是「先 parseAny、后 storeOriginalFile」，于是拿到的永远是
   * 一块 length 为 0 的 buffer，`copy.set()` 抛 TypeError 被空 catch 吞掉，
   * 降级成 fileStored=false —— 表现是「任何 PDF 导进来，图文页入口都置灰」，
   * 而且没有任何错误信息。
   *
   * 单测之所以一直没抓到：`MemoryStorage` 下没有任何断言检查 fileStored，
   * 而界面侧只是「按钮灰了」，不报错。所以这里必须钉住两件事：
   * 字节真的存下来了、取出来和原文件一致。
   */
  it('原始字节真的存下来了，取出来与源文件逐字节一致（pdfjs 会 detach buffer）', async () => {
    const original = fixture('course.pdf');
    // 传入的数组本身也会被 pdfjs detach（这本身就是那个 bug 的证据），
    // 所以基准快照必须在导入之前留下
    const expectedBytes = Buffer.from(original);
    const expectedLength = original.byteLength;
    expect(expectedLength).toBeGreaterThan(0);

    const source = await sources.importBuffer('数据结构复习.pdf', original);

    // 导入后调用方的数组已被转移走 —— 这条断言 simultane 证明「为什么必须提前复制」
    expect(original.byteLength).toBe(0);

    expect(source.fileStored).toBe(true);
    expect(await sources.hasOriginalFile(source.id)).toBe(true);

    const stored = await sources.getOriginalFile(source.id);
    expect(stored).not.toBeNull();
    expect(stored!.byteLength).toBe(expectedLength);
    // 逐字节比对：长度对但内容错（比如存了个空壳）同样不能算通过
    expect(Buffer.from(stored!).equals(expectedBytes)).toBe(true);
  });

  it('非 PDF 不存原始字节（没有「原页」可渲染）', async () => {
    const source = await sources.importBuffer('笔记.md', fixture('notes.md'));
    expect(source.fileStored).toBe(false);
    expect(await sources.hasOriginalFile(source.id)).toBe(false);
  });

  it('切分出的段与页一一对应，正文不为空', async () => {
    const source = await sources.importBuffer('c.pdf', fixture('course.pdf'));
    const segments = await sources.getSegments(source.id);

    expect(segments).toHaveLength(3);
    segments.forEach((seg, i) => {
      expect(seg.index).toBe(i + 1);
      expect(seg.page).toBe(i + 1);
      expect(seg.sourceId).toBe(source.id);
      expect(seg.text.length).toBeGreaterThan(50);
      expect(seg.charCount).toBe(seg.text.length);
    });
  });

  /**
   * 这条是计划书点名的抽查项：
   * 「随机抽查任意一条，点『看原文』必须落到正确的那一页那一段」
   */
  it('抽查：任意一句话都能定位到正确页码', async () => {
    const source = await sources.importBuffer('c.pdf', fixture('course.pdf'));

    const cases = [
      { query: '数据结构研究的是数据元素之间的关系', page: 1 },
      { query: '线性表是由 n 个数据元素构成的有限序列', page: 2 },
      { query: '循环队列用取模运算', page: 3 },
    ];

    for (const { query, page } of cases) {
      const hits = await sources.search(source.id, query);
      expect(hits.length, `「${query}」应命中`).toBeGreaterThan(0);
      expect(hits[0].page, `「${query}」应落在第 ${page} 页`).toBe(page);
    }
  });
});

describe('导入其他格式', () => {
  it('PPTX 按幻灯片切分', async () => {
    const source = await sources.importBuffer('课件.pptx', fixture('course.pptx'));
    expect(source.kind).toBe('pptx');
    expect(source.segmentCount).toBe(3);
  });

  it('DOCX 按章节切分', async () => {
    const source = await sources.importBuffer('讲义.docx', fixture('course.docx'));
    expect(source.kind).toBe('docx');
    expect(source.segmentCount).toBe(3);

    const segments = await sources.getSegments(source.id);
    expect(segments[0].chapter).toBe('第一章 数据结构绪论');
  });

  it('Markdown 按标题切分', async () => {
    const source = await sources.importBuffer('笔记.md', fixture('notes.md'));
    expect(source.kind).toBe('markdown');
    expect(source.segmentCount).toBe(3);
  });

  it('纯文本也能导入', async () => {
    const source = await sources.importBuffer('说明.txt', fixture('plain.txt'));
    expect(source.kind).toBe('text');
    expect(source.segmentCount).toBeGreaterThan(0);
  });
});

describe('扫描件：识别并如实标记，不当失败', () => {
  it('扫描版 PDF 导入成功但标记为无文本层', async () => {
    const source = await sources.importBuffer('扫描件.pdf', fixture('scanned.pdf'));

    // 计划书要求「能被识别并给出下一步建议」
    // 识别 = textStatus 为 no-text-layer；建议由界面根据这个状态给出
    expect(source.textStatus).toBe('no-text-layer');
    expect(source.pageCount).toBe(3);
  });

  it('扫描件的搜索返回空结果，而不是报错或返回假内容', async () => {
    const source = await sources.importBuffer('扫描件.pdf', fixture('scanned.pdf'));
    const hits = await sources.search(source.id, '数据结构');

    expect(hits).toEqual([]);
  });
});

describe('导入失败：逐份给出原因，不影响其他份', () => {
  it('坏文件失败并带 code 与 hint', async () => {
    const outcomes = await sources.importFiles([]); // 占位，避免未使用告警
    expect(outcomes).toEqual([]);

    const error = await sources
      .importBuffer('坏文件.pdf', fixture('broken.pdf'))
      .then(() => null, (e: unknown) => e as { code: string; hint: string; message: string });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('corrupted');
    expect(error!.hint.length).toBeGreaterThan(10);
  });

  it('不支持格式说清支持哪些', async () => {
    const error = await sources
      .importBuffer('表格.xlsx', fixture('unsupported.xlsx.rename'))
      .then(() => null, (e: unknown) => e as { code: string; hint: string });

    expect(error!.code).toBe('unsupported-format');
    expect(error!.hint).toMatch(/PDF|Word|PPT|Markdown|纯文本/);
  });

  it('批量导入里单份失败不吞掉其他份', async () => {
    // 用 Mock File 模拟浏览器的 File
    const makeFile = (name: string, data: Uint8Array) =>
      ({
        name,
        size: data.byteLength,
        arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      }) as unknown as File;

    const outcomes = await sources.importFiles([
      makeFile('好的.pdf', fixture('course.pdf')),
      makeFile('坏的.pdf', fixture('broken.pdf')),
      makeFile('笔记.md', fixture('notes.md')),
    ]);

    expect(outcomes).toHaveLength(3);
    expect(outcomes[0].ok).toBe(true);
    expect(outcomes[1].ok).toBe(false);
    expect(outcomes[1].failure!.code).toBe('corrupted');
    // 关键：第三份仍然成功，说明失败没有中断整批
    expect(outcomes[2].ok).toBe(true);
  });
});

describe('粘贴文本存成资料', () => {
  it('能存并读到内容', async () => {
    const source = await sources.importText('复习要点', '第一段内容。\n\n第二段内容。');

    expect(source.kind).toBe('text');
    expect(source.fileName).toBeNull();
    expect(source.title).toBe('复习要点');

    const segments = await sources.getSegments(source.id);
    expect(segments.map((s) => s.text).join('\n')).toContain('第一段内容');
  });

  it('空内容被拒绝并说明原因', async () => {
    await expect(sources.importText('空的', '   ')).rejects.toThrow(/空/);
  });

  it('标题留空时用默认名，不存空标题', async () => {
    const source = await sources.importText('', '有内容');
    expect(source.title).toBe('粘贴的资料');
  });
});

describe('按课程分组', () => {
  it('未归类资料进「未分类」组', async () => {
    await sources.importBuffer('a.pdf', fixture('course.pdf'));
    const groups = await sources.listByCourse();

    const unclassified = groups.find((g) => g.course === null);
    expect(unclassified).toBeDefined();
    expect(unclassified!.sources).toHaveLength(1);
  });

  it('建了课程后能按课程归类', async () => {
    const course = await courses.create('数据结构');
    const source = await sources.importBuffer('a.pdf', fixture('course.pdf'), {
      courseId: course.id,
    });

    expect(source.courseId).toBe(course.id);

    const groups = await sources.listByCourse();
    const group = groups.find((g) => g.course?.id === course.id);
    expect(group!.sources).toHaveLength(1);
  });

  it('空课程也出现在分组里（刚建完就应看得到）', async () => {
    await courses.create('还没放资料的课程');
    await sources.importBuffer('a.pdf', fixture('course.pdf'));

    const groups = await sources.listByCourse();
    const empty = groups.find((g) => g.course?.name === '还没放资料的课程');
    // 不保留空课程的话，用户建完课程会以为没成功
    expect(empty).toBeDefined();
    expect(empty!.sources).toHaveLength(0);
  });

  it('换课程生效', async () => {
    const course = await courses.create('新课程');
    const source = await sources.importBuffer('a.pdf', fixture('course.pdf'));

    const updated = await sources.setCourse(source.id, course.id);
    expect(updated!.courseId).toBe(course.id);

    const moved = await sources.setCourse(source.id, null);
    expect(moved!.courseId).toBeNull();
  });

  it('课程被删时资料保留并回到未分类，不被一并删除', async () => {
    const course = await courses.create('临时课程');
    const source = await sources.importBuffer('a.pdf', fixture('course.pdf'), {
      courseId: course.id,
    });

    const affected = await courses.remove(course.id);

    expect(affected).toBe(1);
    const after = await sources.get(source.id);
    // 资料是用户辛苦导入的，删课程名不该把它们带走
    expect(after).not.toBeNull();
    expect(after!.courseId).toBeNull();
  });
});

describe('删除资料：级联清理，不留脏数据', () => {
  it('删除后资料与它的全部段都没了', async () => {
    const source = await sources.importBuffer('c.pdf', fixture('course.pdf'));
    expect(await storage.getAll('sourceSegments')).toHaveLength(3);

    await sources.remove(source.id);

    expect(await sources.get(source.id)).toBeNull();
    // 这是计划书 P1 的验收项：「删除资料后，学习库不留脏数据」
    expect(await storage.getAll('sourceSegments')).toHaveLength(0);
  });

  it('删除一份不影响另一份', async () => {
    const a = await sources.importBuffer('a.pdf', fixture('course.pdf'));
    const b = await sources.importBuffer('b.md', fixture('notes.md'));

    await sources.remove(a.id);

    expect(await sources.get(b.id)).not.toBeNull();
    const remaining = await storage.getAll('sourceSegments');
    expect(remaining.every((s) => s.sourceId === b.id)).toBe(true);
    expect(remaining).toHaveLength(3);
  });

  it('删除不存在的资料不报错', async () => {
    await expect(sources.remove('不存在')).resolves.toBeUndefined();
  });
});

describe('全文搜索', () => {
  it('跨段落换行也能命中（PDF 文本段落间有 \\n\\n）', async () => {
    const source = await sources.importBuffer('c.pdf', fixture('course.pdf'));

    // 这句话在 PDF 里被行尾断成两行，规范化后能整句搜到
    const hits = await sources.search(source.id, '非线性结构包括树与图');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('返回的偏移能精确切回原文', async () => {
    const source = await sources.importBuffer('c.pdf', fixture('course.pdf'));
    const segments = await sources.getSegments(source.id);

    const hits = await sources.search(source.id, '假溢出');
    expect(hits.length).toBe(1);

    const hit = hits[0];
    const seg = segments.find((s) => s.id === hit.segmentId)!;
    // P2 会拿这组偏移去高亮，必须能原样切回命中词
    expect(seg.text.slice(hit.charStart, hit.charEnd)).toBe('假溢出');
  });

  it('snippet 前后带上下文，且标出省略位置', async () => {
    const source = await sources.importBuffer('c.pdf', fixture('course.pdf'));
    const hits = await sources.search(source.id, '假溢出');

    expect(hits[0].snippet).toContain('假溢出');
    // 命中在段中间时，前后应当有省略号表示截断
    expect(hits[0].snippet).toMatch(/[….]+/);
  });

  it('大小写不敏感（英文资料）', async () => {
    await sources.importText('英文', 'The Quick Brown Fox jumps.');
    const all = await sources.list();
    const hits = await sources.search(all[0].id, 'quick brown');
    expect(hits.length).toBe(1);
  });

  it('空查询返回空结果，不是全部', async () => {
    const source = await sources.importBuffer('c.pdf', fixture('course.pdf'));
    expect(await sources.search(source.id, '   ')).toEqual([]);
  });

  it('搜不到时返回空数组，不报错', async () => {
    const source = await sources.importBuffer('c.pdf', fixture('course.pdf'));
    expect(await sources.search(source.id, '这里绝对没有的词')).toEqual([]);
  });

  it('多次出现全部返回，按页码排序', async () => {
    await sources.importText('重复', '关键词 出现在第一段。\n\n关键词 又出现在第二段。');
    const all = await sources.list();
    const hits = await sources.search(all[0].id, '关键词');

    expect(hits.length).toBe(2);
    expect(hits[0].charStart).toBeLessThan(hits[1].charStart);
  });
});

describe('findAllFolded：跨行匹配的偏移必须可回到原文', () => {
  it('换行不阻止匹配', () => {
    const text = '前半句\n后半句';
    const hits = findAllFolded(text, '句后');
    // 原文里「句」和「后」之间有个换行，仍应命中
    expect(hits).toHaveLength(1);
    expect(text.slice(hits[0].start, hits[0].end)).toBe('句\n后');
  });

  it('偏移是原文本坐标，不是折叠后的坐标', () => {
    const text = 'AB\nCD';
    const hits = findAllFolded(text, 'BCD');
    expect(hits).toHaveLength(1);
    // 若用了变长压缩，这里会取到 'D' 之外的东西
    expect(text.slice(hits[0].start, hits[0].end)).toBe('B\nCD');
  });

  it('允许重叠命中', () => {
    expect(findAllFolded('aaa', 'aa')).toHaveLength(2);
  });

  it('查询里的多余空格被归一', () => {
    expect(findAllFolded('甲 乙', '甲  乙')).toHaveLength(1);
  });

  it('空查询返回空', () => {
    expect(findAllFolded('内容', '  ')).toEqual([]);
  });
});

describe('导入的原子性', () => {
  it('解析失败时不留下任何半截数据', async () => {
    await sources
      .importBuffer('坏的.pdf', fixture('broken.pdf'))
      .catch(() => undefined);

    // 计划书要求「不留脏数据」：失败的导入不能留下孤儿段或空资料
    expect(await storage.getAll('sources')).toHaveLength(0);
    expect(await storage.getAll('sourceSegments')).toHaveLength(0);
  });
});

describe('writeSegments：OCR 写回的入口', () => {
  let storage: MemoryStorage;
  let svc: SourceService;

  beforeEach(() => {
    storage = new MemoryStorage();
    svc = new SourceService(storage);
  });

  /** 造一份带原始文件的扫描件（正文为空） */
  async function seedScanned(pageCount: number): Promise<string> {
    const ts = new Date().toISOString();
    await storage.put('sources', {
      id: 'src_scan',
      title: '扫描件',
      fileName: 'a.pdf',
      kind: 'pdf' as const,
      courseId: null,
      pageCount,
      byteSize: 10,
      textStatus: 'no-text-layer' as const,
      segmentCount: pageCount,
      fileStored: true,
      createdAt: ts,
      updatedAt: ts,
    });
    await storage.putMany(
      'sourceSegments',
      Array.from({ length: pageCount }, (_, i) => ({
        id: `old_${i + 1}`,
        sourceId: 'src_scan',
        index: i + 1,
        page: i + 1,
        chapter: null,
        text: '',
        charCount: 0,
      })),
    );
    return 'src_scan';
  }

  it('整篇替换：旧的空段一条不留', async () => {
    const id = await seedScanned(3);

    const out = await svc.writeSegments(
      id,
      [
        { page: 1, text: '第一页正文' },
        { page: 2, text: '第二页正文' },
        { page: 3, text: '第三页正文' },
      ],
      'ready',
    );

    expect(out).not.toBeNull();
    const all = await storage.getAll('sourceSegments');
    expect(all).toHaveLength(3);
    expect(all.some((s) => s.id.startsWith('old_'))).toBe(false);
  });

  it('新段数比旧段少时不留下多余的段', async () => {
    const id = await seedScanned(5);

    // OCR 只认出了 2 页有字
    await svc.writeSegments(id, [{ page: 1, text: '甲' }, { page: 4, text: '乙' }], 'ready');

    const all = await storage.getAll('sourceSegments');
    // 若只 putMany 不删除，另外 3 条空段会留下来，用户点开原文会看到前几页是空的
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.page).sort()).toEqual([1, 4]);
  });

  it('index 连续从 1 开始，不受传入页码影响', async () => {
    const id = await seedScanned(10);

    // 跳着传页码（只识别了第 3、7、8 页）
    await svc.writeSegments(
      id,
      [{ page: 3, text: 'a' }, { page: 7, text: 'b' }, { page: 8, text: 'c' }],
      'ready',
    );

    const segs = await svc.getSegments(id);
    // index 由 writeSegments 重新编号：不能留空洞，否则翻页会跳
    expect(segs.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(segs.map((s) => s.page)).toEqual([3, 7, 8]);
  });

  it('charCount 跟着正文长度算，不信任调用方', async () => {
    const id = await seedScanned(1);
    await svc.writeSegments(id, [{ page: 1, text: '一二三四五' }], 'ready');

    const segs = await svc.getSegments(id);
    expect(segs[0]!.charCount).toBe(5);
  });

  it('资料的 segmentCount 与 textStatus 一起更新', async () => {
    const id = await seedScanned(4);

    const out = await svc.writeSegments(
      id,
      [{ page: 1, text: '甲' }, { page: 2, text: '乙' }],
      'ready',
    );

    expect(out!.source.segmentCount).toBe(2);
    expect(out!.source.textStatus).toBe('ready');

    // 落库的也要是 SP：不能只改返回值
    const stored = await svc.get(id);
    expect(stored!.segmentCount).toBe(2);
    expect(stored!.textStatus).toBe('ready');
  });

  it('chapter 缺省补 null 而不是 undefined（JSON 往返后要还在）', async () => {
    const id = await seedScanned(1);
    await svc.writeSegments(id, [{ page: 1, text: '甲' }], 'ready');

    const segs = await svc.getSegments(id);
    expect(segs[0]!.chapter).toBeNull();
    expect(JSON.parse(JSON.stringify(segs[0]))).toHaveProperty('chapter', null);
  });

  it('每段拿到新的 id，不复用旧段 id', async () => {
    const id = await seedScanned(2);
    await svc.writeSegments(id, [{ page: 1, text: '甲' }, { page: 2, text: '乙' }], 'ready');

    const segs = await svc.getSegments(id);
    expect(segs.every((s) => !s.id.startsWith('old_'))).toBe(true);
    // id 各不相同
    expect(new Set(segs.map((s) => s.id)).size).toBe(2);
  });

  it('资料不存在时返回 null，不写任何东西', async () => {
    expect(await svc.writeSegments('nope', [{ page: 1, text: 'x' }], 'ready')).toBeNull();
    expect(await storage.getAll('sourceSegments')).toHaveLength(0);
  });

  it('写回后全文搜索能命中识别出的文字', async () => {
    const id = await seedScanned(2);
    await svc.writeSegments(
      id,
      [{ page: 1, text: '线性表是由有限个数据元素构成的序列' }],
      'ready',
    );

    // 这是整条链路的真实目的：扫描件要变得能搜索、能出题
    const hits = await svc.search(id, '线性表');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.page).toBe(1);
  });

  it('空数组写回会清空分段并把段数记为 0（而不是留着旧段）', async () => {
    const id = await seedScanned(3);
    const out = await svc.writeSegments(id, [], 'no-text-layer');

    expect(out!.source.segmentCount).toBe(0);
    expect(await svc.getSegments(id)).toEqual([]);
  });
});

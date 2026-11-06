import type { SourceAnnotation, InkStroke, TextNote, ShapeElement } from './model.ts';
import type { StorageAdapter } from './storage/types.ts';
import { createAnnotation, hasContent } from './annotations.ts';

/**
 * 资料页面注释的读写。
 *
 * ## 为什么按「资料 + 页」一条记录
 *
 * 一条记录对应一页的全部注释（所有笔迹 + 所有文本框）。
 * 不拆成「一笔一条」的原因：画笔动起来每笔都要写库，拆开会让
 * 628 页教材的注释变成几千条小记录，读一页要扫全表。
 *
 * ## 为什么用确定性 id
 *
 * id 用 `${sourceId}:${page}` 而不是随机 id：
 * 同一页反复保存时直接覆盖，不需要先查再决定新增还是更新。
 * 也天然保证「一页只有一条注释记录」。
 */

/** 页注释的确定性 id */
export function annotationId(sourceId: string, page: number): string {
  return `${sourceId}:${page}`;
}

export class AnnotationService {
  constructor(private readonly storage: StorageAdapter) {}

  /** 取某份资料的全部注释（可能很多页，用于列表与目录标记） */
  async listForSource(sourceId: string): Promise<SourceAnnotation[]> {
    const all = await this.storage.getAll('sourceAnnotations');
    return all.filter((a) => a.sourceId === sourceId);
  }

  /** 取某一页的注释。没有则返回 null */
  async get(sourceId: string, page: number): Promise<SourceAnnotation | null> {
    return this.storage.get('sourceAnnotations', annotationId(sourceId, page));
  }

  /**
   * 保存某一页的注释。
   *
   * 空注释会被**删除**而不是存一条空记录：否则用户点一下画笔又取消，
   * 就会留下「这页有笔记」的假标记，翻过去却什么都没有。
   *
   * @returns 保存后的注释；若为空则返回 null（表示已清除）
   */
  async save(
    sourceId: string,
    page: number,
    content: { strokes?: InkStroke[]; texts?: TextNote[]; shapes?: ShapeElement[] },
  ): Promise<SourceAnnotation | null> {
    const id = annotationId(sourceId, page);
    const existing = await this.storage.get('sourceAnnotations', id);
    const now = new Date().toISOString();

    const merged: SourceAnnotation = {
      ...(existing ?? createAnnotation(id, sourceId, page, now)),
      id,
      sourceId,
      page,
      strokes: content.strokes ?? existing?.strokes ?? [],
      texts: content.texts ?? existing?.texts ?? [],
      // 老记录没有 shapes 字段，按空数组处理（见 model.ts 的注释）
      shapes: content.shapes ?? existing?.shapes ?? [],
      updatedAt: now,
    };

    if (!hasContent(merged)) {
      if (existing) await this.storage.remove('sourceAnnotations', id);
      return null;
    }

    await this.storage.put('sourceAnnotations', merged);
    return merged;
  }

  /** 追加一笔笔迹（画笔抬起时调用） */
  async addStroke(sourceId: string, page: number, stroke: InkStroke): Promise<SourceAnnotation | null> {
    const existing = await this.get(sourceId, page);
    return this.save(sourceId, page, {
      strokes: [...(existing?.strokes ?? []), stroke],
    });
  }

  /** 追加一个文本框 */
  async addText(sourceId: string, page: number, note: TextNote): Promise<SourceAnnotation | null> {
    const existing = await this.get(sourceId, page);
    return this.save(sourceId, page, {
      texts: [...(existing?.texts ?? []), note],
    });
  }

  /** 更新某个文本框（改文字、移动位置） */
  async updateText(
    sourceId: string,
    page: number,
    noteId: string,
    patch: Partial<Omit<TextNote, 'id'>>,
  ): Promise<SourceAnnotation | null> {
    const existing = await this.get(sourceId, page);
    if (!existing) return null;
    const texts = existing.texts.map((t) => (t.id === noteId ? { ...t, ...patch } : t));
    return this.save(sourceId, page, { texts });
  }

  /** 删除一个文本框 */
  async removeText(sourceId: string, page: number, noteId: string): Promise<SourceAnnotation | null> {
    const existing = await this.get(sourceId, page);
    if (!existing) return null;
    return this.save(sourceId, page, { texts: existing.texts.filter((t) => t.id !== noteId) });
  }

  /** 追加一个图形 */
  async addShape(sourceId: string, page: number, shape: ShapeElement): Promise<SourceAnnotation | null> {
    const existing = await this.get(sourceId, page);
    return this.save(sourceId, page, {
      shapes: [...(existing?.shapes ?? []), shape],
    });
  }

  /** 删除一个图形 */
  async removeShape(sourceId: string, page: number, shapeId: string): Promise<SourceAnnotation | null> {
    const existing = await this.get(sourceId, page);
    if (!existing) return null;
    return this.save(sourceId, page, {
      shapes: (existing.shapes ?? []).filter((s) => s.id !== shapeId),
    });
  }

  /**
   * 整页覆盖写回。
   *
   * 擦除、套索移动、批量删除这类操作会一次改掉多个元素，
   * 逐个调用 add/remove 会产生很多次写库。整页覆盖写一次更省，
   * 语义也更清楚：「这一页现在长这样」。
   *
   * 空内容会被删除（与 save 一致），不留假标记。
   */
  async replacePage(
    sourceId: string,
    page: number,
    content: { strokes: InkStroke[]; texts: TextNote[]; shapes: ShapeElement[] },
  ): Promise<SourceAnnotation | null> {
    return this.save(sourceId, page, {
      strokes: content.strokes,
      texts: content.texts,
      shapes: content.shapes,
    });
  }

  /** 撤销最后一笔 */
  async undoLastStroke(sourceId: string, page: number): Promise<SourceAnnotation | null> {
    const existing = await this.get(sourceId, page);
    if (!existing || existing.strokes.length === 0) return existing;
    return this.save(sourceId, page, { strokes: existing.strokes.slice(0, -1) });
  }

  /** 清空某一页的全部注释 */
  async clearPage(sourceId: string, page: number): Promise<void> {
    await this.storage.remove('sourceAnnotations', annotationId(sourceId, page));
  }

  /**
   * 删资料时级联清理注释。
   *
   * 与 sourceSegments 同理：留着孤儿注释会永远占空间，
   * 而且下次同 id 的资料导入时会莫名其妙冒出旧笔记。
   */
  async removeForSource(sourceId: string): Promise<number> {
    const all = await this.listForSource(sourceId);
    for (const a of all) await this.storage.remove('sourceAnnotations', a.id);
    return all.length;
  }
}

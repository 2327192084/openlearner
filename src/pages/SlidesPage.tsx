import { PlaceholderPage } from '@/components/PlaceholderPage.tsx';

export function SlidesPage() {
  return (
    <PlaceholderPage
      title="生成 PPT"
      phase="P4"
      summary="从知识点生成真实可编辑的幻灯片，每条要点带引用角标，点击回到原文。导出的是 .pptx，不是图片拼贴。"
      items={[
        '选知识点范围 → 先出大纲（可编辑：调顺序、改标题、增删页）',
        '大纲确认 → 生成幻灯片：标题页 / 要点页 / 图文页，版式规整',
        '每条要点带引用角标，点击回到原文位置',
        '末尾自动附「资料来源」页：文档名 + 页码 + 网上资料的链接',
        '导出真实 .pptx（可编辑，不是图片拼贴）；重复导出不覆盖旧版本',
        '内容超长时合理分页，不截断、不溢出',
      ]}
    />
  );
}

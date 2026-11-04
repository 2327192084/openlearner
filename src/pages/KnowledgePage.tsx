import { PlaceholderPage } from '@/components/PlaceholderPage.tsx';

export function KnowledgePage() {
  return (
    <PlaceholderPage
      title="知识点"
      phase="P2"
      summary="AI 从资料里整理出知识点，这是 PPT 和习题共用的唯一中间层。核心是给人校对的地方：左边原文高亮，右边知识点，每一条都要能指回真正的位置。"
      items={[
        '选择资料（整份，或按章节/页范围）→ 调用 AI 整理出知识点',
        '每条知识点：概念表述 + 归属章节 + 认知层级 + 标签 + 锚定的原文片段与位置',
        '知识点与原文对照的校对界面：可编辑表述、可删除、可重新指认位置',
        '整理结果存进学习库，可反复查看与编辑',
        '生成过程显示进度，可中途停止，已完成的部分保留',
        '生成前显示预计用量，生成后显示实际用量',
        '指认不到原文位置的条目单独标出来等人处理，不自动填位置',
      ]}
    />
  );
}

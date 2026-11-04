import { PlaceholderPage } from '@/components/PlaceholderPage.tsx';

export function DecksPage() {
  return (
    <PlaceholderPage
      title="习题集"
      phase="P3"
      summary="从知识点出题，先落草稿人工检查再发布。每题必须带答案、解析和能点通的出处，这是「不是 AI 瞎编」最直接的证据。"
      items={[
        '选题范围与出题参数：题型（单选/多选/填空/问答）、题数、难度、语言',
        '生成习题集 → 先落草稿，人工检查后才发布；发布时逐题再校验一遍',
        '每题必带：答案、解析、出处（点得回原文）',
        '练习界面：作答 → 判分 → 看解析 → 不懂可以继续追问',
        '错题自动归集，可按习题集/状态/关键词筛，可重做，可只刷错题',
        '已有题目能从软件外导入；也能把题目补进已存在的习题集，不动原有进度',
        '导出：Markdown、JSON、可打印的 Word/PDF',
        '不确定练什么时，让 AI 根据资料标题和目录推荐范围',
      ]}
    />
  );
}

import { PlaceholderPage } from '@/components/PlaceholderPage.tsx';

/**
 * 六个页面各自写成独立模块并自注册。
 *
 * 注意：注册动作发生在**模块被 import 时**，而不是集中在一个数组里。
 * 这样新增页面只需加一个文件 + 一行 import，不必回头改导航或路由。
 */
export function SourcesPage() {
  return (
    <PlaceholderPage
      title="资料库"
      phase="P1"
      summary="把教材、课件、讲义放进来，按课程分组管理，能翻页、能搜索、能跳目录。这里是「点回原文」的位置信息来源，也是全项目的地基。"
      items={[
        '导入 PDF / Word / PPT / Markdown / 纯文本，支持一次多份，也支持直接粘贴一段文字',
        '资料按页或按章节切开，保留位置信息',
        '资料库列表：按课程分组，显示名称、页数、导入时间、已生成多少内容',
        '阅读器：翻页、目录跳转、全文搜索',
        '资料详情：出处信息可查，删除时提示关联影响',
        '导入失败给明确原因（格式不支持/文件损坏/有密码）',
      ]}
    />
  );
}

import { PlaceholderPage } from '@/components/PlaceholderPage.tsx';

export function PracticePage() {
  return (
    <PlaceholderPage
      title="练习"
      phase="P3"
      summary="作答、判分、看解析、重刷错题。跨习题集的错题归集也在这里。"
      items={[
        '按习题集或按错题开始练习',
        '作答后立即判分并展示解析，解析里带出处，可点回原文',
        '错题自动收进错题本，可筛、可重做、可只刷错题',
        '间隔复习（P6）：按到期时间推送该复习的题',
      ]}
    />
  );
}

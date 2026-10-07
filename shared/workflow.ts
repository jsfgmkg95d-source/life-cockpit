import { METRICS, type Project } from './contracts.ts';
import type { DeltaMetric } from './day-contracts.ts';

export function recommendedMetrics(project?: Project): DeltaMetric[] {
  if (project?.project_type === 'publication') return ['accepted_articles', 'published_articles', 'submission_batches'];
  if (project?.project_type === 'novel') return ['accepted_chapters', 'accepted_words', 'published_chapters', 'submission_batches'];
  return ['milestone_completed', 'learning_outputs', 'health_sessions'];
}
export function orderedMetrics(project?: Project) {
  const preferred = recommendedMetrics(project);
  return METRICS.filter(metric => metric.key !== 'followers').sort((a, b) => {
    const rank = (key: string) => { const index = preferred.indexOf(key as DeltaMetric); return index < 0 ? 100 : index; };
    return rank(a.key) - rank(b.key);
  });
}
export function metricWarning(project: Project | undefined, metric: string | null, acceptance = ''): string | null {
  if (project?.project_type === 'publication' && metric?.endsWith('_chapters')) return '这个项目是内容账号，当前却按“章”计量。请核对是否应使用“文章”；已有记录不会自动改写。';
  if (project?.project_type === 'novel' && metric?.endsWith('_articles')) return '这个项目是小说，当前按“篇”计量。请核对是否应使用“章节”。';
  if (metric?.startsWith('published_') && /上传|提交|推送|定稿/u.test(acceptance) && !/公开|可读|发布/u.test(acceptance)) return '当前指标要求公开发布；上传、定稿或推送本身不足以证明。请核对验收条件与指标。';
  return null;
}

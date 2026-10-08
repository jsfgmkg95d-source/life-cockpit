import { DIMENSIONS, DIMENSION_LABELS, DIMENSION_WEIGHTS, type PlanDraft } from '../shared/day-contracts';

export default function PlanDimensionSummary({ draft }: { draft: PlanDraft }) {
  const total = DIMENSIONS.reduce((sum, dimension) => sum + (draft.dimensions[dimension].applicable ? DIMENSION_WEIGHTS[dimension] : 0), 0);
  return <section aria-label="自动分配的评分维度">
    <h3 className="form-section-title">评分维度 · 随任务自动调整</h3>
    <p className="field-hint">有任务的维度自动纳入，没有任务的自动排除。添加、移除或更换分类后，权重会重新分配。</p>
    <div className="dimensions-grid">{DIMENSIONS.map(dimension => {
      const count = draft.tasks.filter(task => task.scoring_dimension === dimension).length;
      return <div key={dimension}><strong>{DIMENSION_LABELS[dimension]}</strong>
        <p className={count ? 'dimension-ok' : 'field-hint'}>{count ? `${count} 项任务 · 占当天评分 ${Number((DIMENSION_WEIGHTS[dimension] / total * 100).toFixed(1))}%` : '今天未安排，不计入评分'}</p>
      </div>;
    })}</div>
  </section>;
}

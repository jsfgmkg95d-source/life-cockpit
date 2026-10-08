import { DIMENSIONS, DIMENSION_LABELS, DIMENSION_WEIGHTS, type PlanDraft } from './day-contracts.ts';
import { apportion } from './plan-weights.ts';

/** Derive applicable dimensions and a complete allocation without changing the source draft. */
export function normalizePlanScoring(source: PlanDraft): PlanDraft {
  const draft = structuredClone(source);
  // A malformed rest plan must still be rejected; never silently discard its tasks.
  if (draft.day_mode === 'rest') return draft;
  for (const dimension of DIMENSIONS) {
    const members = draft.tasks.filter(task => task.scoring_dimension === dimension);
    const budget = DIMENSION_WEIGHTS[dimension];
    if (!members.length) {
      draft.dimensions[dimension] = { applicable: false, reason: draft.dimensions[dimension].reason.trim() || '本日未安排此维度任务' };
      continue;
    }
    if (members.length > budget) throw new Error(`${DIMENSION_LABELS[dimension]}最多安排 ${budget} 项任务，请合并同类任务后再确认。`);
    if (members.some(task => !Number.isSafeInteger(task.raw_points) || task.raw_points < 0)) {
      throw new Error(`${DIMENSION_LABELS[dimension]}的相对权重须为不小于 0 的整数。`);
    }
    draft.dimensions[dimension] = { applicable: true, reason: '' };
    const positive = members.filter(task => task.raw_points > 0);
    const total = positive.reduce((sum, task) => sum + task.raw_points, 0);
    // Preserve an already valid allocation exactly, including previous manual choices.
    if (positive.length === members.length && total === budget) continue;
    const defaultWeight = positive.length ? total / positive.length : 1;
    const points = apportion(members.map(task => task.raw_points || defaultWeight), budget);
    members.forEach((task, index) => { task.raw_points = points[index]; });
  }
  return draft;
}

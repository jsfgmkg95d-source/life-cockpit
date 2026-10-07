import { DIMENSION_WEIGHTS, type DayState, type PlanDraft } from './day-contracts.ts';
import { apportion } from './plan-weights.ts';

/** Remove one candidate without changing the source draft or unrelated dimensions. */
export function removeDraftCandidate(source: PlanDraft, candidateId: string): PlanDraft {
  const removed = source.tasks.find(task => task.candidate_id === candidateId);
  if (!removed) throw new Error('这项任务已不在当前安排中，请读取最新内容。');
  const draft = structuredClone(source);
  draft.tasks = draft.tasks.filter(task => task.candidate_id !== candidateId);
  draft.work_blocks = draft.work_blocks.filter(block => block.id !== removed.work_block_id || draft.tasks.some(task => task.work_block_id === block.id));
  const dimension = removed.scoring_dimension;
  const remaining = draft.tasks.filter(task => task.scoring_dimension === dimension);
  if (remaining.length > DIMENSION_WEIGHTS[dimension]) {
    // Drafts may be incomplete or overfull. Always let the user reduce them;
    // confirmation still requires a valid positive integer allocation.
    return draft;
  }
  if (remaining.length) {
    const points = apportion(remaining.map(task => task.raw_points), DIMENSION_WEIGHTS[dimension]);
    remaining.forEach((task, index) => { task.raw_points = points[index]; });
  } else {
    draft.dimensions[dimension] = { applicable: false, reason: '该维度的当日任务已移除' };
  }
  return draft;
}

/** Adjust only the confirmed plan; a separately saved draft remains independent. */
export function buildRemoveTaskDraft(state: DayState, taskId: string, reason: string): PlanDraft {
  const plan = state.log?.plan_snapshots.find(snapshot => snapshot.plan_version === state.log?.current_plan_version);
  const task = plan?.tasks.find(item => item.task_id === taskId);
  if (!plan || !task) throw new Error('这项任务已不在当前安排中，请读取最新内容。');
  const draft = removeDraftCandidate({
    day_mode: plan.day_mode, available_minutes: plan.available_minutes,
    dimensions: structuredClone(plan.dimensions),
    tasks: plan.tasks.map(({ project_name: _name, ...candidate }) => ({ ...candidate })),
    work_blocks: structuredClone(plan.work_blocks), notes: plan.notes,
    change_reason: `移除「${task.title}」：${reason}`,
  }, task.candidate_id);
  return draft;
}

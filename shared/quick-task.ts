import type { AppState } from './contracts.ts';
import { DIMENSIONS, DIMENSION_WEIGHTS } from './day-contracts.ts';
import type { DayState, DayWrite, DeltaMetric, Dimension, PlanDraft } from './day-contracts.ts';
import { apportion } from './plan-weights.ts';

/** Adds one explicit daily commitment; never imports a suggested or saved draft. */
export interface QuickTaskInput {
  project_id: string;
  project_revision: number;
  title: string;
  acceptance: string;
  result_type: 'binary' | 'quant';
  metric_key: DeltaMetric | null;
  target_value: number | null;
  /** Used only for a new block. Existing shared budgets remain unchanged. */
  budget_minutes: number | null;
  /** Used for a first work plan or a switch from rest; an existing work capacity is preserved. */
  available_minutes: number | null;
  resume_project: boolean;
  acknowledgeOverCapacity: boolean;
}
export type QuickTaskWrite = QuickTaskInput & DayWrite;

export function buildQuickTaskDraft(
  state: DayState,
  app: AppState,
  input: QuickTaskInput,
  ids?: { candidate_id: string; block_id: string },
): PlanDraft {
  const project = app.projects.find(item => item.id === input.project_id);
  if (!project) throw new Error('未找到所选项目，请刷新后重新选择。');
  const current = state.log?.plan_snapshots.find(snapshot => snapshot.plan_version === state.log?.current_plan_version);
  const base = current?.day_mode === 'work' ? current : null;
  const draft: PlanDraft = {
    day_mode: 'work',
    available_minutes: base ? base.available_minutes : input.available_minutes,
    dimensions: base ? structuredClone(base.dimensions) : Object.fromEntries(DIMENSIONS.map(dimension => [dimension, { applicable: false, reason: '今日未安排此维度任务' }])) as PlanDraft['dimensions'],
    tasks: base ? base.tasks.map(({ project_name: _name, ...task }) => ({ ...task })) : [],
    work_blocks: base ? structuredClone(base.work_blocks) : [],
    change_reason: current ? `添加「${project.name}」的当日任务：${input.title}` : '',
    notes: current?.notes ?? '',
  };
  if (draft.tasks.length >= 100) throw new Error('当天最多安排 100 项任务，请先整理已有安排。');
  const group = app.settings.shared_budget_groups.find(item => item.project_ids.includes(project.id));
  const related = new Set(group?.project_ids ?? [project.id]);
  const blockIds = [...new Set(draft.tasks.filter(task => related.has(task.project_id)).map(task => task.work_block_id))];
  const reuse = blockIds.length === 1 ? draft.work_blocks.find(block => block.id === blockIds[0]) : null;
  const blockId = reuse?.id ?? ids?.block_id ?? `quick-block-${project.id}-${(current?.plan_version ?? 0) + 1}`;
  if (!reuse) draft.work_blocks.push({ id: blockId, title: group?.title ?? project.name, budget_minutes: input.budget_minutes });
  const dimension: Dimension = project.operating_role === 'cashflow' ? 'cashflow' : project.operating_role === 'maintenance' ? (project.primary_metric_key === 'learning_outputs' ? 'learning' : 'health') : 'asset';
  const members = draft.tasks.filter(task => task.scoring_dimension === dimension);
  const oldTotal = members.reduce((sum, task) => sum + task.raw_points, 0);
  const points = apportion([...members.map(task => task.raw_points), members.length ? oldTotal / members.length : DIMENSION_WEIGHTS[dimension]], DIMENSION_WEIGHTS[dimension]);
  members.forEach((task, index) => { task.raw_points = points[index]; });
  draft.dimensions[dimension] = { applicable: true, reason: '' };
  draft.tasks.push({
    candidate_id: ids?.candidate_id ?? `quick-candidate-${project.id}-${(current?.plan_version ?? 0) + 1}`,
    task_id: null, project_id: project.id, title: input.title, acceptance: input.acceptance,
    result_type: input.result_type, metric_key: input.result_type === 'binary' ? null : input.metric_key,
    target_value: input.result_type === 'binary' ? 1 : input.target_value,
    scoring_dimension: dimension, raw_points: points.at(-1)!, estimated_minutes: null, work_block_id: blockId,
  });
  return draft;
}

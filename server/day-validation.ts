import { METRICS } from '../shared/contracts.ts';
import { DIMENSIONS, EVENT_STAGES } from '../shared/day-contracts.ts';
import type { ActualWrite, CompletionWrite, ConfirmPlanWrite, CorrectionWrite, DeltaMetric, DraftWrite, EventInput, EventWrite, FinishWrite, PlanDraft, RemoveTaskWrite, ResultWrite, StatusWrite } from '../shared/day-contracts.ts';
import { invalid } from './errors.ts';
import { checkedChapters } from './chapter-store.ts';
import { integer, object, requestId } from './validation.ts';
import type { QuickTaskWrite } from '../shared/quick-task.ts';

export const DELTA_METRICS = METRICS.filter((metric) => metric.key !== 'followers').map((metric) => metric.key) as DeltaMetric[];

export function dayText(value: unknown, label: string, max = 1000, allowEmpty = false): string {
  if (typeof value !== 'string') invalid(`${label}必须是文字。`);
  const result = value.trim();
  if ((!allowEmpty && !result) || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(result)) invalid(`${label}不能为空或超过 ${max} 个字符。`);
  return result;
}
function flag(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label}必须为是或否。`);
  return value;
}
function nullableNumber(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number | null {
  return value === null ? null : integer(value, label, 0, max);
}
function choose<T extends string>(value: unknown, label: string, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid(`${label}不是支持的选项。`);
  return value as T;
}
export function businessDate(value: unknown): string {
  const date = dayText(value, '业务日期', 10);
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) invalid('业务日期必须为有效的 YYYY-MM-DD。');
  return date;
}

export function parseDraft(value: unknown): PlanDraft {
  const input = object(value, '计划草案', ['day_mode', 'available_minutes', 'dimensions', 'tasks', 'work_blocks', 'change_reason', 'notes']);
  const dimensions = object(input.dimensions, '维度安排', [...DIMENSIONS]);
  const checkedDimensions = Object.fromEntries(DIMENSIONS.map((dimension) => {
    const choice = object(dimensions[dimension], '维度安排', ['applicable', 'reason']);
    return [dimension, { applicable: flag(choice.applicable, '适用状态'), reason: dayText(choice.reason, '维度说明', 1000, true) }];
  })) as PlanDraft['dimensions'];
  if (!Array.isArray(input.tasks) || input.tasks.length > 100) invalid('每日任务必须为列表，最多 100 项。');
  if (!Array.isArray(input.work_blocks) || input.work_blocks.length > 100) invalid('投入块必须为列表，最多 100 个。');
  const tasks = input.tasks.map((value) => {
    const task = object(value, '候选任务', ['candidate_id', 'task_id', 'project_id', 'title', 'acceptance', 'result_type', 'metric_key', 'target_value', 'scoring_dimension', 'raw_points', 'estimated_minutes', 'work_block_id']);
    return {
      candidate_id: dayText(task.candidate_id, '候选标识', 160), task_id: task.task_id === null ? null : dayText(task.task_id, '任务标识', 160),
      project_id: dayText(task.project_id, '项目标识', 160, true), title: dayText(task.title, '任务名称', 240, true), acceptance: dayText(task.acceptance, '验收标准', 2000, true),
      result_type: choose(task.result_type, '验收类型', ['quant', 'binary'] as const), metric_key: task.metric_key === null ? null : choose(task.metric_key, '成果指标', DELTA_METRICS),
      target_value: nullableNumber(task.target_value, '目标数量'), scoring_dimension: choose(task.scoring_dimension, '计分维度', DIMENSIONS),
      raw_points: integer(task.raw_points, '原始权重', 0, 100), estimated_minutes: nullableNumber(task.estimated_minutes, '任务估时', 1440), work_block_id: dayText(task.work_block_id, '投入块标识', 160, true),
    };
  });
  const blocks = input.work_blocks.map((value) => {
    const block = object(value, '投入块', ['id', 'title', 'budget_minutes']);
    return { id: dayText(block.id, '投入块标识', 160), title: dayText(block.title, '投入块名称', 240, true), budget_minutes: nullableNumber(block.budget_minutes, '投入块预算', 1440) };
  });
  if (new Set(tasks.map((task) => task.candidate_id)).size !== tasks.length) invalid('候选任务标识不能重复。');
  const taskIds = tasks.map((task) => task.task_id).filter((id) => id !== null);
  if (new Set(taskIds).size !== taskIds.length) invalid('同一任务不能在计划中重复出现。');
  if (new Set(blocks.map((block) => block.id)).size !== blocks.length) invalid('投入块标识不能重复。');
  return { day_mode: choose(input.day_mode, '日类型', ['work', 'rest'] as const), available_minutes: nullableNumber(input.available_minutes, '可用容量', 1440), dimensions: checkedDimensions, tasks, work_blocks: blocks, change_reason: dayText(input.change_reason, '调整原因', 2000, true), notes: dayText(input.notes, '当日备注', 5000, true) };
}

function writeBase(input: Record<string, unknown>) { return { requestId: requestId(input.requestId), revision: integer(input.revision, '日期版本', 0) }; }
export function draftWrite(value: unknown): DraftWrite {
  const input = object(value, '保存草稿', ['requestId', 'revision', 'draft']);
  return { ...writeBase(input), draft: parseDraft(input.draft) };
}
export function confirmWrite(value: unknown): ConfirmPlanWrite {
  const input = object(value, '确认计划', ['requestId', 'revision', 'draft', 'acknowledgeOverCapacity']);
  return { ...writeBase(input), draft: parseDraft(input.draft), acknowledgeOverCapacity: flag(input.acknowledgeOverCapacity, '超容量确认') };
}
export function quickTaskWrite(value: unknown): QuickTaskWrite {
  const input = object(value, '添加当日任务', ['requestId', 'revision', 'project_id', 'project_revision', 'title', 'acceptance', 'result_type', 'metric_key', 'target_value', 'budget_minutes', 'available_minutes', 'resume_project', 'acknowledgeOverCapacity']);
  const result: QuickTaskWrite = {
    ...writeBase(input), project_id: dayText(input.project_id, '项目', 160), project_revision: integer(input.project_revision, '项目版本', 1),
    title: dayText(input.title, '今天要做的事', 240), acceptance: dayText(input.acceptance, '完成标准', 2000),
    result_type: choose(input.result_type, '验收类型', ['binary', 'quant'] as const),
    metric_key: input.metric_key === null ? null : choose(input.metric_key, '成果指标', DELTA_METRICS), target_value: nullableNumber(input.target_value, '目标数量'),
    budget_minutes: nullableNumber(input.budget_minutes, '预计分钟', 1440), available_minutes: nullableNumber(input.available_minutes, '今天可用分钟', 1440),
    resume_project: flag(input.resume_project, '恢复项目'), acknowledgeOverCapacity: flag(input.acknowledgeOverCapacity, '超容量确认'),
  };
  if (result.result_type === 'binary' && (result.metric_key !== null || result.target_value !== 1)) invalid('按完成标准核对的任务，指标须为空且目标固定为 1。');
  if (result.result_type === 'quant' && (result.metric_key === null || result.target_value === null || result.target_value <= 0)) invalid('按数量记录的任务，请选择成果指标并填写大于零的目标。');
  return result;
}
export function statusWrite(value: unknown): StatusWrite {
  const input = object(value, '任务状态', ['requestId', 'revision', 'status']);
  return { ...writeBase(input), status: choose(input.status, '任务状态', ['todo', 'doing', 'done', 'cancelled'] as const) };
}
export function completionWrite(value: unknown): CompletionWrite {
  const input = object(value, '完成任务', ['requestId', 'revision', 'completed', 'source', 'marker']);
  return { ...writeBase(input), completed: flag(input.completed, '完成状态'),
    source: input.source === undefined ? 'manual' : dayText(input.source, '完成标志来源', 120),
    marker: input.marker === undefined ? '' : dayText(input.marker, '完成标志说明', 2000, true),
  };
}
export function removeTaskWrite(value: unknown): RemoveTaskWrite {
  const input = object(value, '移除当日任务', ['requestId', 'revision', 'reason']);
  return { ...writeBase(input), reason: dayText(input.reason, '移除原因', 1500) };
}
export function resultWrite(value: unknown): ResultWrite {
  const input = object(value, '确认结果', ['requestId', 'revision', 'binary_value', 'explanation', 'clear']);
  return { ...writeBase(input), binary_value: input.binary_value === null ? null : integer(input.binary_value, '离散验收结果', 0, 1), explanation: dayText(input.explanation, '结果说明', 2000, true), clear: flag(input.clear, '恢复未知') };
}
export function parseEvent(value: unknown): EventInput {
  const input = object(value, '成果', ['project_id', 'task_id', 'artifact_key', 'metric_key', 'value', 'stage', 'summary', 'source', 'chapter_numbers']);
  const event = { project_id: dayText(input.project_id, '成果项目', 160), task_id: input.task_id === null ? null : dayText(input.task_id, '成果任务', 160), artifact_key: dayText(input.artifact_key, '稳定成果标识', 300), metric_key: choose(input.metric_key, '成果指标', DELTA_METRICS), value: integer(input.value, '成果数量', 0), stage: choose(input.stage, '成果阶段', EVENT_STAGES), summary: dayText(input.summary, '成果说明', 2000), source: dayText(input.source, '来源或回执说明', 2000) };
  return { ...event, chapter_numbers: checkedChapters(input.chapter_numbers, event.metric_key, event.value, event.artifact_key) };
}
export function eventWrite(value: unknown): EventWrite {
  const input = object(value, '记录成果', ['requestId', 'revision', 'event']);
  return { ...writeBase(input), event: parseEvent(input.event) };
}
export function correctionWrite(value: unknown): CorrectionWrite {
  const input = object(value, '更正成果', ['requestId', 'revision', 'kind', 'value', 'stage', 'summary', 'source', 'reason', 'chapter_numbers']);
  const result: CorrectionWrite = { ...writeBase(input), kind: choose(input.kind, '更正方式', ['replace', 'void'] as const), value: nullableNumber(input.value, '更正后完整数量'), stage: choose(input.stage, '更正后阶段', EVENT_STAGES), summary: dayText(input.summary, '更正后说明', 2000), source: dayText(input.source, '更正依据', 2000), reason: dayText(input.reason, '更正原因', 2000) };
  if ((result.kind === 'void') !== (result.value === null)) invalid('撤销的数量须为空，完整替换的数量须填写。');
  if (input.chapter_numbers !== undefined) {
    if (!Array.isArray(input.chapter_numbers) || input.chapter_numbers.length > 500 || input.chapter_numbers.some(n => !Number.isSafeInteger(n) || Number(n) < 1) || new Set(input.chapter_numbers).size !== input.chapter_numbers.length) invalid('更正章号必须是不重复的正整数，每次最多500章。');
    result.chapter_numbers = input.chapter_numbers as number[];
  }
  return result;
}
export function actualWrite(value: unknown): ActualWrite {
  const input = object(value, '实际投入', ['requestId', 'revision', 'block_id', 'minutes', 'source']);
  return { ...writeBase(input), block_id: dayText(input.block_id, '投入块标识', 160), minutes: nullableNumber(input.minutes, '实际分钟数', 1440), source: dayText(input.source, '实际投入来源', 2000) };
}

export function finishWrite(value: unknown): FinishWrite {
  const input = object(value, '结束本次工作', ['requestId', 'revision', 'event', 'result', 'actual', 'mark_done', 'github_chapters']);
  if (input.github_chapters !== undefined && (!Array.isArray(input.github_chapters) || input.github_chapters.length > 100 || input.github_chapters.some(n => !Number.isSafeInteger(n) || Number(n) < 1) || new Set(input.github_chapters).size !== input.github_chapters.length)) invalid('请选择不同的 GitHub 章节。');
  const result = input.result === null ? null : object(input.result, '验收结果', ['binary_value', 'explanation']);
  const actual = input.actual === null ? null : object(input.actual, '实际投入', ['minutes', 'source']);
  return { ...writeBase(input), event: input.event === null ? null : parseEvent(input.event),
    result: result === null ? null : { binary_value: result.binary_value === null ? null : integer(result.binary_value, '验收结果', 0, 1), explanation: dayText(result.explanation, '结果说明', 2000, true) },
    actual: actual === null ? null : { minutes: integer(actual.minutes, '实际分钟数', 0, 1440), source: dayText(actual.source, '时间来源', 2000) },
    mark_done: flag(input.mark_done, '结束任务'), github_chapters: input.github_chapters as number[] | undefined,
  };
}

export function validateStage(metric: DeltaMetric, stage: EventInput['stage']): void {
  let allowed: EventInput['stage'][];
  if (metric.startsWith('published_')) allowed = ['published'];
  else if (metric === 'submission_batches') allowed = ['submitted'];
  else if (metric.startsWith('accepted_')) allowed = ['finalized', 'approved', 'published'];
  else allowed = ['completed', 'finalized', 'approved'];
  if (!allowed.includes(stage)) invalid('所选成果阶段不能证明该指标；提交成功不能当作公开或验收完成。');
}

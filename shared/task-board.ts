import type { DailyTask } from './day-contracts.ts';

export type TaskBoardColumn = 'todo' | 'doing' | 'review' | 'done' | 'cancelled';
export type TaskBoardOutcome = 'unknown' | 'unmet' | 'partial' | 'achieved';

export interface TaskBoardState {
  column: TaskBoardColumn;
  completed: boolean;
  outcome: TaskBoardOutcome;
  actual: number | null;
  target: number;
  progress: number | null;
}

/** The user's completion flag controls completion; measured results stay independent. */
export function taskBoardState(task: DailyTask): TaskBoardState {
  const target = task.result_type === 'binary' ? 1
    : task.target_value !== null && Number.isFinite(task.target_value) && task.target_value > 0 ? task.target_value : Infinity;
  const value = task.result_state === 'confirmed' ? task.confirmed_result?.actual_value : null;
  const actual = typeof value === 'number' && Number.isFinite(value) && value >= 0
    && (task.result_type === 'quant' || value === 0 || value === 1) ? value : null;
  const outcome: TaskBoardOutcome = actual === null ? 'unknown'
    : actual >= target ? 'achieved' : actual === 0 ? 'unmet' : 'partial';
  return {
    column: task.status, completed: task.status === 'done', outcome, actual, target,
    progress: actual === null || !Number.isFinite(target) ? null : Math.min(actual / target, 1),
  };
}

import type { DayState } from './day-contracts.ts';
import { taskBoardState } from './task-board.ts';

/** Use only today's current confirmed plan; archived plans and drafts are not commitments. */
export function widgetSummary(day: DayState, activeTaskId: string | null = null) {
  const plan = day.log?.plan_snapshots.find(item => item.plan_version === day.log?.current_plan_version);
  const ids = new Set(plan?.tasks.map(item => item.task_id) ?? []);
  const tasks = day.tasks.filter(task => ids.has(task.task_id));
  const pinned = new Set(day.pinned_task_ids ?? []);
  const results = tasks.map(taskBoardState);
  const completed = results.filter(result => result.completed).length;
  const achieved = results.filter(result => result.outcome === 'achieved').length;
  const confirmed = results.filter(result => result.actual !== null).length;
  const rank = (task: typeof tasks[number]) => task.task_id === activeTaskId ? -2
    : pinned.has(task.task_id) ? -1 : task.status === 'doing' ? 0
    : task.status === 'todo' ? 1 : 2;
  return {
    plan, total: tasks.length, completed, remaining: tasks.length - completed,
    achieved, confirmed, unknown: tasks.length - confirmed,
    progress: tasks.length ? completed / tasks.length : null,
    tasks: [...tasks].sort((a, b) => rank(a) - rank(b)),
  };
}

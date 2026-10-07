import type { DayState } from './day-contracts.ts';
import { taskBoardState } from './task-board.ts';

export function projectProgress(day: DayState, projectId: string) {
  const plan = day.log?.plan_snapshots.find(item => item.plan_version === day.log?.current_plan_version);
  const ids = new Set(plan?.tasks.map(item => item.task_id) ?? []);
  const tasks = day.tasks.filter(item => ids.has(item.task_id) && item.project_id === projectId);
  const results = tasks.map(taskBoardState);
  const completed = results.filter(item => item.completed).length;
  const confirmed = results.filter(item => item.actual !== null).length;
  const achieved = results.filter(item => item.outcome === 'achieved').length;
  const events = day.effective_events.filter(item => item.project_id === projectId);
  const label = !tasks.length ? events.length ? '今日已有成果 · 无计划任务' : '今日未安排任务'
    : completed === tasks.length ? '今日任务全部完成'
    : `今日 ${completed}/${tasks.length} 项已完成`;
  return { tasks, events, completed, remaining: tasks.length - completed, confirmed, achieved, label };
}

export function projectStageLabel(stage: string) {
  return !stage.trim() || stage === '待确认' ? '项目阶段未设置' : stage;
}

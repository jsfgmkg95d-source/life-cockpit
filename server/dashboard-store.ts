import type { Store } from './store.ts';
import { DayStore } from './day-store.ts';
import { scoreInput } from './score-store.ts';
import { calculateScore } from '../shared/scoring.ts';
import { DIMENSIONS, type AssetEvent } from '../shared/day-contracts.ts';
import type { DashboardDay, DashboardView, MetricTotal } from '../shared/dashboard-contracts.ts';

export function shiftDate(date: string, delta: number): string {
  const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + delta);
  return value.toISOString().slice(0, 10);
}
function totals(events: AssetEvent[]): MetricTotal[] {
  const groups = new Map<string, MetricTotal>();
  for (const event of events) {
    if (event.value === null) continue;
    const key = `${event.metric_key}:${event.stage}`;
    const group = groups.get(key) ?? { metric: event.metric_key, stage: event.stage, value: '0', records: 0 };
    group.value = String(BigInt(group.value) + BigInt(event.value)); group.records++; groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => `${a.metric}:${a.stage}`.localeCompare(`${b.metric}:${b.stage}`));
}
export function dashboard(store: Store, end: string): DashboardView {
  store.database.exec('BEGIN');
  try {
    const reader = new DayStore(store);
    const states = Array.from({ length: 7 }, (_, i) => reader.getState(shiftDate(end, i - 6)));
    const allEvents = states.flatMap(state => state.effective_events);
    const days: DashboardDay[] = states.map(state => {
      const plan = state.log?.plan_snapshots.find(item => item.plan_version === state.log!.current_plan_version) ?? null;
      const tasks = state.tasks.filter(task => plan?.tasks.some(item => item.task_id === task.task_id));
      const actuals = state.log?.work_block_actuals ?? [];
      return { date: state.business_date, timezone: state.timezone, recorded: !!state.log, settled: state.log?.record_state === 'complete',
        mode: plan?.day_mode ?? null, score: calculateScore(scoreInput(state, plan)), policy: plan ? `${plan.policy.id} / v${plan.policy.version}` : null,
        dimensions: DIMENSIONS.filter(dimension => plan?.dimensions[dimension].applicable), planVersion: plan?.plan_version ?? 0,
        plannedTasks: tasks.length, completedTasks: tasks.filter(task => task.status === 'done').length,
        confirmedTasks: tasks.filter(task => task.result_state === 'confirmed').length,
        achievedTasks: tasks.filter(task => task.result_state === 'confirmed' && task.confirmed_result && task.confirmed_result.actual_value >= (task.target_value ?? 1)).length,
        actualMinutes: actuals.length ? actuals.reduce((sum, item) => sum + item.minutes, 0) : null, recordedBlocks: actuals.length,
        missingBlocks: plan?.work_blocks.filter(block => !actuals.some(item => item.block_id === block.id)).length ?? 0,
        budgetMinutes: plan?.work_blocks.some(block => block.budget_minutes !== null) ? plan.work_blocks.reduce((sum, block) => sum + (block.budget_minutes ?? 0), 0) : null,
        missingBudgets: plan?.work_blocks.filter(block => block.budget_minutes === null).length ?? 0,
        capacity: plan?.available_minutes ?? null, totals: totals(state.effective_events) };
    });
    const projects = store.getState().projects.map(project => {
      const events = allEvents.filter(event => event.project_id === project.id);
      const plannedDays = states.filter(state => state.log?.plan_snapshots.find(plan => plan.plan_version === state.log!.current_plan_version)?.tasks.some(task => task.project_id === project.id)).length;
      const attention: string[] = [];
      if (['preparing', 'active'].includes(project.status)) {
        if (!project.next_action) attention.push('下一步行动尚未明确');
        if (project.target_date && project.target_date < end) attention.push('目标日期已过，请核对目标是否完成');
        if (plannedDays && !events.length) attention.push('窗口内有计划，未见有效成果记录；请补录或检查安排');
      }
      return { id: project.id, name: project.name, status: project.status, plannedDays, eventDays: new Set(events.map(event => event.occurred_on)).size,
        latestEvent: events.map(event => event.occurred_on).sort().at(-1) ?? null, totals: totals(events), attention };
    });
    const timeDays = days.filter(day => day.actualMinutes !== null);
    const result: DashboardView = { start: states[0].business_date, end, days, totals: totals(allEvents),
      actualMinutes: timeDays.length ? timeDays.reduce((sum, day) => sum + day.actualMinutes!, 0) : null,
      recordedTimeDays: timeDays.length, settledDays: days.filter(day => day.settled).length, projects,
      dimensions: DIMENSIONS.map(dimension => ({ dimension, applicableDays: days.filter(day => day.mode === 'work' && day.dimensions.includes(dimension)).length, workDays: days.filter(day => day.mode === 'work').length })) };
    store.database.exec('COMMIT'); return result;
  } catch (error) { store.database.exec('ROLLBACK'); throw error; }
}

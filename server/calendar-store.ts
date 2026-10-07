import type { CalendarDay, CalendarMonth } from '../shared/calendar-contracts.ts';
import type { MetricTotal } from '../shared/dashboard-contracts.ts';
import { EVENT_STAGES, type AssetEvent } from '../shared/day-contracts.ts';
import { isChapterMetric } from '../shared/chapters.ts';
import { taskBoardState } from '../shared/task-board.ts';
import { chaptersFor } from './chapter-store.ts';
import { DayStore } from './day-store.ts';
import { businessDate } from './day-validation.ts';
import { invalid } from './errors.ts';
import type { Store } from './store.ts';

export function calendarMonth(store: Store, month: string, now = new Date()): CalendarMonth {
  if (!/^\d{4}-\d{2}$/u.test(month)) invalid('日历月份必须为有效的 YYYY-MM。');
  const first = businessDate(`${month}-01`);
  const end = new Date(`${first}T12:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  const last = end.toISOString().slice(0, 10);
  const dayCount = end.getUTCDate();
  const db = store.database;
  db.exec('BEGIN');
  try {
    const timeZone = store.getState().settings.timezone;
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const datePart = (name: string) => parts.find(part => part.type === name)!.value;
    const today = `${datePart('year')}-${datePart('month')}-${datePart('day')}`;

    // Check identities across history through the displayed month, so duplicates
    // on different days cannot be added back together by calendar aggregation.
    const effective = db.prepare(`SELECT e.* FROM asset_events e WHERE e.occurred_on<=? AND e.change_kind!='void'
      AND NOT EXISTS(SELECT 1 FROM asset_events n WHERE n.supersedes_event_id=e.id)`).all(last) as unknown as AssetEvent[];
    const identities = new Map<string, number>();
    const chapters = new Map<string, number[]>();
    for (const event of effective) {
      if (!isChapterMetric(event.metric_key)) continue;
      const numbers = chaptersFor(store, event.root_event_id);
      chapters.set(event.id, numbers);
      for (const number of numbers) {
        const key = `${event.project_id}:${event.metric_key}:${number}`;
        identities.set(key, (identities.get(key) ?? 0) + 1);
      }
    }
    const unresolved = new Set(effective.filter(event => {
      if (!isChapterMetric(event.metric_key)) return false;
      const numbers = chapters.get(event.id)!;
      return numbers.length !== event.value || numbers.some(number => (identities.get(`${event.project_id}:${event.metric_key}:${number}`) ?? 0) > 1);
    }).map(event => event.id));
    const reader = new DayStore(store);
    const days: CalendarDay[] = Array.from({ length: dayCount }, (_, index) => {
      const date = `${month}-${String(index + 1).padStart(2, '0')}`;
      const state = reader.getState(date);
      const plan = state.log?.plan_snapshots.find(item => item.plan_version === state.log!.current_plan_version);
      const taskIds = new Set(plan?.tasks.map(task => task.task_id));
      const tasks = state.tasks.filter(task => taskIds.has(task.task_id));
      const taskStates = tasks.map(taskBoardState);
      const events = state.effective_events;
      const groups = new Map<string, MetricTotal>();
      for (const event of events) {
        if (event.value === null || event.value <= 0 || unresolved.has(event.id) || !EVENT_STAGES.includes(event.stage)) continue;
        const key = `${event.metric_key}:${event.stage}`;
        const group = groups.get(key) ?? { metric: event.metric_key, stage: event.stage, value: '0', records: 0 };
        group.value = String(BigInt(group.value) + BigInt(event.value));
        group.records++;
        groups.set(key, group);
      }
      const totals = [...groups.values()].sort((a, b) => `${a.metric}:${a.stage}`.localeCompare(`${b.metric}:${b.stage}`));
      const positiveResultTasks = taskStates.filter(task => task.actual !== null && task.actual > 0).length;
      return {
        date, recorded: !!state.log, mode: plan?.day_mode ?? null,
        plannedTasks: tasks.length, completedTasks: taskStates.filter(task => task.completed).length,
        confirmedTasks: taskStates.filter(task => task.actual !== null).length,
        achievedTasks: taskStates.filter(task => task.outcome === 'achieved').length,
        endedTasks: tasks.filter(task => task.status === 'done').length,
        positiveResultTasks, hasHarvest: positiveResultTasks > 0 || totals.length > 0,
        unresolvedEvents: events.filter(event => unresolved.has(event.id)).length, totals,
      };
    });
    db.exec('COMMIT');
    return { month, today, days };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { widgetSummary } from '../shared/widget-summary.ts';
import type { DayState, DailyTask, PlanDraft } from '../shared/day-contracts.ts';

const task = (id: string, value: number | null, status: DailyTask['status'] = 'done') => ({
  task_id: id, title: id, result_type: 'binary', target_value: 1, status,
  result_state: value === null ? 'unknown' : 'confirmed',
  confirmed_result: value === null ? null : { actual_value: value },
} as DailyTask);
function day(tasks: DailyTask[], current = tasks): DayState {
  const draft: PlanDraft = { day_mode: 'work', available_minutes: null, tasks: [], work_blocks: [], notes: '', change_reason: '',
    dimensions: { cashflow: { applicable: true, reason: '' }, asset: { applicable: false, reason: 'test' }, health: { applicable: false, reason: 'test' }, learning: { applicable: false, reason: 'test' } } };
  const snapshot = (version: number, items: DailyTask[]) => ({ ...draft, schema_version: 1 as const, plan_version: version, previous_plan_version: null, confirmed_at: '2026-10-06T00:00:00Z', tasks: items,
    policy: { id: 'default-v1' as const, version: 1 as const, dimension_weights: { cashflow: 50, asset: 30, health: 10, learning: 10 } }, over_capacity_acknowledged: false });
  return { tasks, pinned_task_ids: [], business_date: '2026-10-06', timezone: 'Asia/Shanghai', events: [], effective_events: [], suggested_draft: draft,
    log: { id: 'day', business_date: '2026-10-06', timezone: 'Asia/Shanghai', revision: 1, current_plan_version: 2,
      draft_plan: null, work_block_actuals: [], record_state: 'incomplete', created_at: '', updated_at: '',
      plan_snapshots: [snapshot(1, tasks), snapshot(2, current)],
    } };
}

test('marked completion counts directly without inventing measured results', () => {
  const state = day([task('unknown', null), task('zero', 0), task('yes', 1)]);
  const summary = widgetSummary(state);
  assert.equal(summary.total, 3);
  assert.equal(summary.confirmed, 2);
  assert.equal(summary.achieved, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.completed, 3);
  assert.equal(summary.remaining, 0);
  assert.equal(summary.progress, 1);
});

test('measured achievement does not mark pending work complete, and reopening updates completion', () => {
  const state = day([task('pending', 1, 'todo'), task('completed', null)]);
  assert.equal(widgetSummary(state).completed, 1);
  assert.equal(widgetSummary(state).progress, 1 / 2);
  state.tasks[1].status = 'todo';
  assert.equal(widgetSummary(state).completed, 0);
  assert.equal(widgetSummary(state).achieved, 1);
});

test('removed old-plan tasks and unconfirmed drafts do not inflate progress', () => {
  const current = task('today', null, 'todo');
  const state = day([task('removed', 1), current], [current]);
  const summary = widgetSummary(state);
  assert.equal(summary.total, 1);
  assert.equal(summary.achieved, 0);
  assert.equal(summary.completed, 0);
  assert.equal(widgetSummary({ ...state, log: null }).progress, null);
  assert.equal(widgetSummary(day([], [])).progress, null);
});

test('active task precedes pinned and pending work without mutating the ledger snapshot', () => {
  const state = day([task('done', 1), task('todo', null, 'todo'), task('pinned', null, 'todo'), task('active', null, 'doing')]);
  state.pinned_task_ids = ['pinned'];
  const before = JSON.stringify(state);
  assert.deepEqual(widgetSummary(state, 'active').tasks.map(item => item.task_id), ['active', 'pinned', 'todo', 'done']);
  assert.equal(JSON.stringify(state), before);
});

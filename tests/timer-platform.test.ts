import { setupTestWorkspace } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { DayStore } from '../server/day-store.ts';
import { Store } from '../server/store.ts';
import { TimerStore, timerStopWrite } from '../server/timer-store.ts';

const root = resolve(import.meta.dirname, '../.runtime/tests');
const date = '2026-09-20';
function fixture() {
  mkdirSync(root, { recursive: true }); const folder = mkdtempSync(resolve(root, 'platform-timer-'));
  const store = new Store(resolve(folder, 'data'));
  const app = setupTestWorkspace(store, randomUUID(), 'Asia/Shanghai', 180), project = app.projects[0];
  const days = new DayStore(store), timer = new TimerStore(days);
  const base = () => ({ requestId: randomUUID(), revision: days.findLog(date)?.revision ?? 0 });
  const day = days.quickTask(date, { ...base(), project_id: project.id, project_revision: project.revision,
    title: '平台暂停检查', acceptance: '用户独立核对结果', result_type: 'binary', metric_key: null, target_value: 1,
    budget_minutes: 25, available_minutes: 180, resume_project: false, acknowledgeOverCapacity: false });
  const start = () => { timer.start(date, day.tasks[0].work_block_id, { ...base(), task_id: day.tasks[0].task_id }); return timer.view(date).active!; };
  return { store, days, timer, base, start, close() { store.close(); assert.equal(dirname(folder), root); rmSync(folder, { recursive: true, force: true }); } };
}

test('delayed platform pause counts only the captured pre-sleep interval, keeps save audit time and retries without duplication', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(`${date}T09:00:00+08:00`) });
  const f = fixture();
  try {
    const active = f.start(); t.mock.timers.tick(120_000);
    const stopped_at = new Date().toISOString(); t.mock.timers.tick(3_600_000);
    const input = { ...f.base(), discard: false, expected_session_id: active.id, stopped_at };
    const saved = f.timer.stop(date, input), view = f.timer.view(date);
    assert.equal(view.active, null); assert.equal(view.sessions[0].elapsed_seconds, 120);
    assert.equal(view.sessions[0].stopped_at, stopped_at); assert.equal(view.summary.todayMinutes, 2);
    assert.equal(saved.log!.work_block_actuals[0].updated_at, new Date().toISOString());
    assert.equal(saved.tasks[0].result_state, 'unknown'); assert.equal(saved.events.length, 0);
    assert.deepEqual(f.timer.stop(date, input), saved); assert.equal(f.timer.view(date).sessions.length, 1);
    const next = f.start(), before = f.days.getState(date);
    assert.throws(() => f.timer.stop(date, { ...f.base(), discard: false, expected_session_id: active.id, stopped_at }), /已结束或在其他页面切换/u);
    assert.equal(f.timer.view(date).active!.id, next.id); assert.deepEqual(f.days.getState(date), before);
  } finally { f.close(); }
});

test('platform stop rejects malformed, future, pre-start, cross-day and overlong endpoints with full rollback', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(`${date}T09:00:00+08:00`) });
  const f = fixture();
  try {
    const active = f.start(); t.mock.timers.tick(60_000);
    const write = (stopped_at: string) => ({ ...f.base(), discard: false, expected_session_id: active.id, stopped_at });
    const before = f.days.getState(date);
    assert.throws(() => timerStopWrite({ ...f.base(), discard: false, stopped_at: new Date().toISOString() }), /身份/u);
    assert.throws(() => f.timer.stop(date, write('invalid')), /有效时间/u);
    assert.throws(() => f.timer.stop(date, write(`${date}T08:59:59+08:00`)), /不能早于/u);
    assert.throws(() => f.timer.stop(date, write(`${date}T09:02:00+08:00`)), /已经发生/u);
    assert.deepEqual(f.days.getState(date), before);
    t.mock.timers.tick(24 * 3_600_000);
    assert.throws(() => f.timer.stop(date, write('2026-09-21T08:59:00+08:00')), /跨过业务日期/u);
    assert.throws(() => f.timer.stop(date, write(`${date}T17:00:01+08:00`)), /超过8小时/u);
    assert.deepEqual(f.days.getState(date), before); assert.equal(f.timer.view(date).active!.id, active.id);
  } finally { f.close(); }
});

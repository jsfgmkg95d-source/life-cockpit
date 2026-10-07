import { setupTestWorkspace } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.ts';
import { DayStore } from '../server/day-store.ts';
import { TimerStore } from '../server/timer-store.ts';
import type { PlanDraft } from '../shared/day-contracts.ts';

function fixture() {
  const root = resolve(import.meta.dirname, '..', '.runtime', 'tests'); mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(resolve(root, 'manual-timer-'));
  const store = new Store(resolve(folder, 'data'));
  const app = setupTestWorkspace(store, randomUUID(), 'Asia/Shanghai', 180);
  const project = app.projects.find(p => p.name === '示例长篇甲')!;
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const days = new DayStore(store), timers = new TimerStore(days);
  const base = () => ({ requestId: randomUUID(), revision: days.findLog(date)?.revision ?? 0 });
  const draft: PlanDraft = { day_mode: 'work', available_minutes: 180, notes: '', change_reason: '', dimensions: { cashflow: { applicable: true, reason: '' }, asset: { applicable: false, reason: '隔离测试' }, health: { applicable: false, reason: '隔离测试' }, learning: { applicable: false, reason: '隔离测试' } }, work_blocks: [{ id: 'a', title: '时段A', budget_minutes: 60 }, { id: 'b', title: '时段B', budget_minutes: 60 }], tasks: ['a', 'b'].map(id => ({ candidate_id: id, task_id: null, project_id: project.id, title: `隔离测试${id}`, acceptance: `指定${id}批次已定稿`, result_type: 'quant', metric_key: 'accepted_chapters', target_value: 2, scoring_dimension: 'cashflow', raw_points: 25, estimated_minutes: null, work_block_id: id })) };
  days.confirm(date, { ...base(), draft, acknowledgeOverCapacity: false });
  const start = (block = 'a') => {
    timers.start(date, block, base());
    store.database.prepare('UPDATE work_sessions SET started_at=? WHERE stopped_at IS NULL').run(new Date(Date.now() - 600000).toISOString());
  };
  const edit = () => { const plan = days.getState(date).log!.plan_snapshots.at(-1)!; return { ...structuredClone(plan), change_reason: '隔离测试调整' }; };
  return { store, days, timers, date, base, start, edit, close() { store.close(); assert.ok(folder.startsWith(root)); rmSync(folder, { recursive: true, force: true }); } };
}

test('手填累计用时先暂停同一时段计时，以输入累计值为准且重复请求不重复计入', () => {
  const f = fixture(); try {
    f.start();
    const input = { ...f.base(), block_id: 'a', minutes: 10, source: '用户核对累计10分钟' };
    const saved = f.days.actual(f.date, input);
    assert.equal(saved.log!.work_block_actuals.find(a => a.block_id === 'a')!.minutes, 10);
    assert.equal(f.timers.view(f.date).active, null);
    assert.equal(f.timers.view(f.date).sessions.length, 1);
    assert.ok(Number(f.timers.view(f.date).sessions[0].elapsed_seconds) >= 600);
    assert.deepEqual(f.days.actual(f.date, input), saved);
    f.timers.stop(f.date, { ...f.base(), discard: false });
    assert.equal(f.days.getState(f.date).log!.work_block_actuals[0].minutes, 10);
  } finally { f.close(); }
});

test('手填其他时段不会停止正在计时的时段；清空本时段累计值暂停计时并恢复未知', () => {
  const f = fixture(); try {
    f.start();
    f.days.actual(f.date, { ...f.base(), block_id: 'b', minutes: 12, source: '用户核对' });
    assert.equal(f.timers.view(f.date).active!.block_id, 'a');
    f.days.actual(f.date, { ...f.base(), block_id: 'a', minutes: null, source: '用户核对后恢复未知' });
    assert.equal(f.timers.view(f.date).active, null);
    assert.deepEqual(f.days.getState(f.date).log!.work_block_actuals.map(a => [a.block_id, a.minutes]), [['b', 12]]);
  } finally { f.close(); }
});

test('手填总用时校验失败时暂停及分钟变更一起回滚', () => {
  const f = fixture(); try {
    f.days.actual(f.date, { ...f.base(), block_id: 'b', minutes: 100, source: '用户核对' });
    f.start();
    const before = f.days.getState(f.date), timerBefore = f.timers.view(f.date);
    assert.throws(() => f.days.actual(f.date, { ...f.base(), block_id: 'a', minutes: 1400, source: '超出一天' }), /1440/u);
    assert.deepEqual(f.days.getState(f.date), before);
    assert.deepEqual(f.timers.view(f.date), timerBefore);
  } finally { f.close(); }
});

test('计划调整替换或移除正在计时的时段时要求先暂停；休息日切换同样保护', () => {
  const f = fixture(); try {
    f.start();
    const before = f.days.getState(f.date), timerBefore = f.timers.view(f.date);
    const changed = f.edit(); changed.tasks[0].acceptance = '验收对象已变更';
    assert.throws(() => f.days.confirm(f.date, { ...f.base(), draft: changed, acknowledgeOverCapacity: false }), /先暂停/u);
    const removed = f.edit(); removed.tasks = removed.tasks.filter(t => t.work_block_id !== 'a'); removed.tasks[0].raw_points = 50; removed.work_blocks = removed.work_blocks.filter(b => b.id !== 'a');
    assert.throws(() => f.days.confirm(f.date, { ...f.base(), draft: removed, acknowledgeOverCapacity: false }), /先暂停/u);
    const rest = f.edit(); rest.day_mode = 'rest'; rest.tasks = []; rest.work_blocks = []; for (const dimension of Object.values(rest.dimensions)) { dimension.applicable = false; dimension.reason = '休息'; }
    assert.throws(() => f.days.confirm(f.date, { ...f.base(), draft: rest, acknowledgeOverCapacity: false }), /先暂停/u);
    assert.deepEqual(f.days.getState(f.date), before); assert.deepEqual(f.timers.view(f.date), timerBefore);
    f.timers.stop(f.date, { ...f.base(), discard: false });
    assert.equal(f.days.confirm(f.date, { ...f.base(), draft: changed, acknowledgeOverCapacity: false }).log!.current_plan_version, 2);
  } finally { f.close(); }
});

test('只改其他时段或正在计时时段的预算仍可确认，既有计时保持原归属', () => {
  const f = fixture(); try {
    f.start();
    const edited = f.edit(); edited.tasks[1].acceptance = '另一时段修改验收'; edited.work_blocks[0].budget_minutes = 70;
    const saved = f.days.confirm(f.date, { ...f.base(), draft: edited, acknowledgeOverCapacity: false });
    assert.equal(saved.log!.current_plan_version, 2);
    assert.equal(f.timers.view(f.date).active!.block_id, 'a');
    const task = saved.tasks.find(t => t.eligible && t.work_block_id === 'a')!;
    f.days.finish(f.date, task.task_id, { ...f.base(), event: null, actual: null, result: { binary_value: null, explanation: '本次未产出，明确结束' }, mark_done: true });
    assert.equal(f.timers.view(f.date).active, null);
    assert.equal(f.days.getState(f.date).log!.work_block_actuals.find(a => a.block_id === 'a')!.minutes, 10);
  } finally { f.close(); }
});

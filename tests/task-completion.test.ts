import { setupTestWorkspace, testFetch } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../server/app.ts';
import { BackupStore } from '../server/backup-store.ts';
import { DayStore } from '../server/day-store.ts';
import { completionWrite } from '../server/day-validation.ts';
import { AppError } from '../server/errors.ts';
import { Store } from '../server/store.ts';
import { RestoreStore } from '../server/restore-store.ts';
import { TimerStore } from '../server/timer-store.ts';
import type { AppState } from '../shared/contracts.ts';
import type { DayState, PlanDraft } from '../shared/day-contracts.ts';

const ROOT = resolve(import.meta.dirname, '..', '.runtime', 'tests');
const DATE = '2026-10-06';
const NOON = Date.parse('2026-10-06T04:00:00Z');
const code = (expected: string) => (error: unknown) => error instanceof AppError && error.code === expected;
function directory() { mkdirSync(ROOT, { recursive: true }); return mkdtempSync(resolve(ROOT, 'task-completion-')); }
function remove(directory: string) { assert.equal(resolve(directory, '..'), ROOT); rmSync(directory, { recursive: true, force: true }); }

function plan(projects: AppState['projects']): PlanDraft {
  return { day_mode: 'work', available_minutes: 60,
    dimensions: { cashflow: { applicable: true, reason: '' }, asset: { applicable: false, reason: '测试未安排' },
      health: { applicable: false, reason: '测试未安排' }, learning: { applicable: false, reason: '测试未安排' } },
    tasks: [
      { candidate_id: 'test-a', task_id: null, project_id: projects[0].id, title: '测试计量任务', acceptance: '测试旧计划标准', result_type: 'quant', metric_key: 'accepted_words', target_value: 1000, scoring_dimension: 'cashflow', raw_points: 25, estimated_minutes: null, work_block_id: 'shared-test-block' },
      { candidate_id: 'test-b', task_id: null, project_id: projects[1].id, title: '测试普通任务', acceptance: '测试旧计划标准', result_type: 'binary', metric_key: null, target_value: 1, scoring_dimension: 'cashflow', raw_points: 25, estimated_minutes: null, work_block_id: 'shared-test-block' },
    ], work_blocks: [{ id: 'shared-test-block', title: '测试共享时段', budget_minutes: 30 }], change_reason: '', notes: '',
  };
}
function fixture() {
  const folder = directory(), store = new Store(resolve(folder, 'data'));
  const initial = setupTestWorkspace(store, randomUUID(), 'Asia/Shanghai', 60), days = new DayStore(store), timers = new TimerStore(days);
  const base = () => ({ requestId: randomUUID(), revision: days.findLog(DATE)?.revision ?? 0 });
  const state = days.confirm(DATE, { ...base(), draft: plan(initial.projects), acknowledgeOverCapacity: false });
  return { folder, store, days, timers, base, tasks: state.tasks,
    close() { store.close(); remove(folder); } };
}

test('完成与恢复待办无需成果或验收，不合成数量、结果或实际投入', () => {
  const f = fixture();
  try {
    for (const task of f.tasks) {
      const completed = f.days.completion(DATE, task.task_id, { ...f.base(), completed: true });
      const saved = completed.tasks.find(item => item.task_id === task.task_id)!;
      assert.equal(saved.status, 'done'); assert.equal(saved.result_state, 'unknown'); assert.equal(saved.confirmed_result, null);
      assert.deepEqual(completed.events, []); assert.deepEqual(completed.log!.work_block_actuals, []);
      const restored = f.days.completion(DATE, task.task_id, { ...f.base(), completed: false });
      assert.equal(restored.tasks.find(item => item.task_id === task.task_id)!.status, 'todo');
      assert.deepEqual(restored.events, []);
    }
  } finally { f.close(); }
});

test('完成及撤销完成保留已有成果、数量、结果和手填投入', () => {
  const f = fixture();
  try {
    const task = f.tasks[0];
    f.days.event(DATE, { ...f.base(), event: { project_id: task.project_id, task_id: task.task_id, artifact_key: 'fixture-artifact', metric_key: 'accepted_words', value: 37, stage: 'finalized', summary: '隔离测试已有记录', source: '隔离测试来源' } });
    f.days.result(DATE, task.task_id, { ...f.base(), binary_value: null, explanation: '原数量记录', clear: false });
    f.days.actual(DATE, { ...f.base(), block_id: task.work_block_id, minutes: 10, source: '已核对的测试投入' });
    const before = f.days.getState(DATE);
    f.days.completion(DATE, task.task_id, { ...f.base(), completed: true });
    const after = f.days.completion(DATE, task.task_id, { ...f.base(), completed: false });
    assert.deepEqual(after.events, before.events); assert.deepEqual(after.effective_events, before.effective_events);
    assert.deepEqual(after.tasks[0].confirmed_result, before.tasks[0].confirmed_result);
    assert.equal(after.tasks[0].confirmed_result!.actual_value, 37);
    assert.deepEqual(after.log!.work_block_actuals, before.log!.work_block_actuals);
  } finally { f.close(); }
});

test('完成原子保存本任务计时；重复请求不重复入账，标志保留在已有回执中', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON });
  const f = fixture();
  try {
    const task = f.tasks[0];
    f.timers.start(DATE, task.work_block_id, { ...f.base(), task_id: task.task_id });
    t.mock.timers.tick(65_000);
    const input = { ...f.base(), completed: true, source: 'my-local-check', marker: 'receipt-7' };
    const completed = f.days.completion(DATE, task.task_id, input);
    assert.equal(completed.tasks[0].status, 'done'); assert.equal(f.timers.view(DATE).active, null);
    assert.equal(f.timers.view(DATE).summary.todayMinutes, 1);
    assert.equal(f.timers.view(DATE).sessions[0].elapsed_seconds, 65);
    assert.deepEqual(f.days.completion(DATE, task.task_id, input), completed);
    assert.equal(f.timers.view(DATE).summary.todayMinutes, 1);
    const receipt = f.store.database.prepare('SELECT response_json FROM request_dedup WHERE scope=? AND request_id=?').get(`day:${DATE}:completion:${task.task_id}`, input.requestId)!;
    assert.deepEqual(JSON.parse(String(receipt.response_json)).completion,
      { task_id: task.task_id, completed: true, source: 'my-local-check', marker: 'receipt-7' });
  } finally { f.close(); }
});

test('共享时段其他任务和无task归属计时不被停止，恢复待办也不会误停', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON });
  const f = fixture();
  try {
    const [a, b] = f.tasks;
    assert.equal(a.work_block_id, b.work_block_id);
    f.timers.start(DATE, b.work_block_id, { ...f.base(), task_id: b.task_id });
    const activeId = f.timers.view(DATE).active!.id;
    f.days.completion(DATE, a.task_id, { ...f.base(), completed: true });
    f.days.completion(DATE, a.task_id, { ...f.base(), completed: false });
    assert.equal(f.timers.view(DATE).active!.id, activeId);
    assert.equal(f.days.getState(DATE).tasks[1].status, 'doing');
    f.timers.stop(DATE, { ...f.base(), discard: true });
    f.timers.start(DATE, a.work_block_id, f.base());
    const unlinkedId = f.timers.view(DATE).active!.id;
    f.days.completion(DATE, a.task_id, { ...f.base(), completed: true });
    assert.equal(f.timers.view(DATE).active!.id, unlinkedId);
    assert.equal(f.timers.view(DATE).active!.task_id, null);
  } finally { f.close(); }
});

test('恢复待办只保存该任务自己的活动计时；不自动重开计时', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON });
  const f = fixture();
  try {
    const task = f.tasks[0];
    f.timers.start(DATE, task.work_block_id, { ...f.base(), task_id: task.task_id });
    t.mock.timers.tick(61_000);
    assert.equal(f.days.completion(DATE, task.task_id, { ...f.base(), completed: false }).tasks[0].status, 'todo');
    assert.equal(f.timers.view(DATE).active, null); assert.equal(f.timers.view(DATE).summary.todayMinutes, 1);
  } finally { f.close(); }
});

test('标志冲突、旧版本均拒绝；撤销后重试旧完成请求不会重新完成', () => {
  const f = fixture();
  try {
    const task = f.tasks[0], input = { ...f.base(), completed: true };
    f.days.completion(DATE, task.task_id, input);
    assert.throws(() => f.days.completion(DATE, task.task_id, { ...input, marker: 'different' }), code('IDEMPOTENCY_CONFLICT'));
    assert.throws(() => f.days.completion(DATE, task.task_id, { ...input, completed: false }), code('IDEMPOTENCY_CONFLICT'));
    assert.throws(() => f.days.completion(DATE, task.task_id, { ...input, requestId: randomUUID() }), code('REVISION_CONFLICT'));
    const restored = f.days.completion(DATE, task.task_id, { ...f.base(), completed: false });
    assert.deepEqual(f.days.completion(DATE, task.task_id, input), restored);
    assert.equal(f.days.getState(DATE).tasks[0].status, 'todo');
  } finally { f.close(); }
});

test('不安全计时导致整次完成回滚，任务状态、会话与版本不变', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON });
  const f = fixture();
  try {
    const task = f.tasks[0];
    f.timers.start(DATE, task.work_block_id, { ...f.base(), task_id: task.task_id });
    const before = f.days.getState(DATE), activeId = f.timers.view(DATE).active!.id, input = { ...f.base(), completed: true };
    t.mock.timers.tick(9 * 3600_000);
    assert.throws(() => f.days.completion(DATE, task.task_id, input), /超过8小时/);
    assert.deepEqual(f.days.getState(DATE), before); assert.equal(f.timers.view(DATE).active!.id, activeId);
    assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM request_dedup WHERE request_id=?').get(input.requestId)!.n, 0);
  } finally { f.close(); }
});

test('不存在、跨日期和已移出计划的任务不能由完成标志复活', () => {
  const f = fixture();
  try {
    const task = f.tasks[0];
    assert.throws(() => f.days.completion(DATE, 'missing-task', { ...f.base(), completed: true }), code('TASK_NOT_FOUND'));
    assert.throws(() => f.days.completion('2026-10-05', task.task_id, { requestId: randomUUID(), revision: 0, completed: true }), code('TASK_NOT_FOUND'));
    assert.equal(f.days.findLog('2026-10-05'), null);
    f.days.removeTask(DATE, task.task_id, { ...f.base(), reason: '测试移除' });
    assert.throws(() => f.days.completion(DATE, task.task_id, { ...f.base(), completed: true }), code('TASK_NOT_CURRENT'));
  } finally { f.close(); }
});

test('完成标志严格验证为布尔值与有限纯文字，不接受可执行配置或多余字段', () => {
  const base = { requestId: randomUUID(), revision: 0, completed: true };
  assert.deepEqual(completionWrite(base), { ...base, source: 'manual', marker: '' });
  for (const change of [{ completed: 'true' }, { completed: 1 }, { source: '' }, { source: 'x'.repeat(121) },
    { marker: null }, { marker: 'x'.repeat(2001) }, { marker: '\0' }, { script: 'execute()' }]) {
    assert.throws(() => completionWrite({ ...base, ...change }), code('VALIDATION_ERROR'));
  }
  assert.equal(completionWrite({ ...base, marker: 'https://example.com/my-check' }).marker, 'https://example.com/my-check');
});

test('schema 9完整备份恢复保留完成标志、来源及去重回执，恢复后旧请求不重复写', () => {
  const f = fixture();
  try {
    const task = f.tasks[0], input = { ...f.base(), completed: true, source: 'local-check', marker: 'receipt-keep-123' };
    const completed = f.days.completion(DATE, task.task_id, input);
    const getReceipt = () => f.store.database.prepare('SELECT * FROM request_dedup WHERE scope=? AND request_id=?').get(`day:${DATE}:completion:${task.task_id}`, input.requestId);
    const originalReceipt = getReceipt();
    const backups = new BackupStore(f.store, resolve(f.folder, 'backups')), backup = backups.create(randomUUID());
    assert.equal(backup.schemaVersion, 9);
    const exported = JSON.parse(backups.download(backup.id, 'export.json').bytes.toString('utf8'));
    assert.deepEqual(exported.tables.request_dedup.find((row: { request_id: string }) => row.request_id === input.requestId), { ...originalReceipt });
    f.days.completion(DATE, task.task_id, { ...f.base(), completed: false, source: 'manual', marker: 'after-backup' });
    const restore = new RestoreStore(f.store, backups, () => false), preview = restore.preview(backup.id);
    restore.restore(randomUUID(), preview.token, '恢复本地账本');
    assert.deepEqual(getReceipt(), originalReceipt);
    assert.deepEqual(f.days.completion(DATE, task.task_id, input), completed);
    assert.equal(f.days.getState(DATE).events.length, 0);
  } finally { f.close(); }
});

test('公开本机完成接口沿用CSRF/Origin与版本控制，无成果也能完成和恢复', async () => {
  const folder = directory(), app = createApp({ dataDir: resolve(folder, 'data'), port: 0 });
  try {
    const { url } = await app.listen();
    const { csrfToken } = await (await testFetch(url + '/api/session')).json();
    const headers = { Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
    async function post(path: string, body: object, selectedHeaders = headers) {
      const response = await testFetch(url + path, { method: 'POST', headers: selectedHeaders, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    }
    const initial = await post('/api/setup', { requestId: randomUUID(), timezone: 'Asia/Shanghai', availableMinutes: 60 });
    const planned = await post(`/api/days/${DATE}/confirm`, { requestId: randomUUID(), revision: 0, draft: plan(initial.body.projects), acknowledgeOverCapacity: false });
    assert.equal(planned.status, 200);
    const task = (planned.body as DayState).tasks[0], path = `/api/days/${DATE}/tasks/${task.task_id}/completion`;
    const input = { requestId: randomUUID(), revision: planned.body.log.revision, completed: true };
    assert.equal((await post(path, input, { ...headers, 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await post(path, input, { ...headers, Origin: 'https://example.com' })).status, 403);
    assert.equal((await post(path, { ...input, completed: 'true' })).status, 400);
    const completed = await post(path, input);
    assert.equal(completed.status, 200); assert.equal(completed.body.tasks[0].status, 'done');
    assert.deepEqual(completed.body.events, []); assert.equal(completed.body.tasks[0].result_state, 'unknown');
    assert.deepEqual((await post(path, input)).body, completed.body);
    assert.equal((await post(path, { ...input, requestId: randomUUID() })).status, 409);
    const restored = await post(path, { requestId: randomUUID(), revision: completed.body.log.revision, completed: false, source: 'fixture-client', marker: 'reopened' });
    assert.equal(restored.status, 200); assert.equal(restored.body.tasks[0].status, 'todo');
  } finally { await app.close(); remove(folder); }
});

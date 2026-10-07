import { setupTestWorkspace, testFetch } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../server/app.ts';
import { DayStore } from '../server/day-store.ts';
import { FocusImportStore, focusImportWrite, type FocusImportSession } from '../server/focus-import-store.ts';
import { ScoreStore } from '../server/score-store.ts';
import { Store } from '../server/store.ts';
import type { PlanDraft } from '../shared/day-contracts.ts';

const MINUTE = 60_000;
const TEST_ROOT = resolve(import.meta.dirname, '..', '.runtime', 'tests');
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(Date.now() - 2 * 86_400_000));
const NOON = Date.parse(`${date}T04:00:00.000Z`);

function plan(projectIds: string[]): PlanDraft {
  return {
    day_mode: 'work', available_minutes: 180, notes: '', change_reason: '',
    dimensions: { cashflow: { applicable: true, reason: '' }, asset: { applicable: false, reason: '隔离测试' },
      health: { applicable: false, reason: '隔离测试' }, learning: { applicable: false, reason: '隔离测试' } },
    work_blocks: [{ id: 'shared', title: '两项目共用时段', budget_minutes: 60 }, { id: 'other', title: '另一时段', budget_minutes: 60 }],
    tasks: [
      { candidate_id: 'a', task_id: null, project_id: projectIds[0], title: '任务 A', acceptance: '指定内容已完成', result_type: 'binary', metric_key: null, target_value: 1, scoring_dimension: 'cashflow', raw_points: 20, estimated_minutes: null, work_block_id: 'shared' },
      { candidate_id: 'b', task_id: null, project_id: projectIds[1], title: '任务 B', acceptance: '另一内容已完成', result_type: 'binary', metric_key: null, target_value: 1, scoring_dimension: 'cashflow', raw_points: 20, estimated_minutes: null, work_block_id: 'shared' },
      { candidate_id: 'c', task_id: null, project_id: projectIds[0], title: '任务 C', acceptance: '第三内容已完成', result_type: 'binary', metric_key: null, target_value: 1, scoring_dimension: 'cashflow', raw_points: 10, estimated_minutes: null, work_block_id: 'other' },
    ],
  } as PlanDraft;
}

function fixture() {
  mkdirSync(TEST_ROOT, { recursive: true });
  const folder = mkdtempSync(resolve(TEST_ROOT, 'focus-import-'));
  const store = new Store(resolve(folder, 'data'));
  const initial = setupTestWorkspace(store, randomUUID(), 'Asia/Shanghai', 180);
  const days = new DayStore(store);
  const projectIds = initial.projects.slice(0, 2).map((project) => project.id);
  days.confirm(date, { requestId: randomUUID(), revision: 0, draft: plan(projectIds), acknowledgeOverCapacity: false });
  const imports = new FocusImportStore(days);
  const base = () => ({ requestId: randomUUID(), revision: days.findLog(date)!.revision });
  const session = (id: string, offset = 0, minutes = 25, blockId = 'shared'): FocusImportSession => ({
    id, startedAt: NOON + offset * MINUTE, completedAt: NOON + (offset + minutes) * MINUTE,
    durationMs: minutes * MINUTE, blockId,
  });
  const write = (sessions: FocusImportSession[]) => focusImportWrite({ ...base(), sessions });
  return { store, days, imports, session, write, base, folder, close() { store.close(); rmSync(folder, { recursive: true, force: true }); } };
}

test('导入完整专注按共享时段累计一次，重复文件不增加分钟或版本，评分失效但任务事实不变', () => {
  const f = fixture();
  try {
    const scoreBefore = new ScoreStore(f.store).write(date, f.base(), false);
    assert.ok(scoreBefore.current_score_id);
    const before = f.days.getState(date);
    const input = f.write([f.session('timer-a', 0), f.session('timer-b', 30)]);
    const imported = f.imports.import(date, input);
    assert.equal(imported.log!.work_block_actuals.length, 1);
    assert.equal(imported.log!.work_block_actuals[0].block_id, 'shared');
    assert.equal(imported.log!.work_block_actuals[0].minutes, 50);
    assert.match(imported.log!.work_block_actuals[0].source, /一刻导入/u);
    assert.equal(f.store.database.prepare("SELECT count(*) AS count FROM work_sessions WHERE id LIKE 'still-focus:%'").get()!.count, 2);
    assert.deepEqual(imported.tasks.map((task) => [task.status, task.result_state]), before.tasks.map((task) => [task.status, task.result_state]));
    assert.equal(new ScoreStore(f.store).getView(date).current_score_id, null);
    assert.equal(f.imports.import(date, input).log!.revision, imported.log!.revision);
    assert.equal(f.imports.import(date, f.write([f.session('timer-a', 0), f.session('timer-b', 30)])).log!.revision, imported.log!.revision);
    assert.equal(f.days.getState(date).log!.work_block_actuals[0].minutes, 50);
  } finally { f.close(); }
});

test('相同源会话 ID 的内容变化与重叠批次均原子拒绝', () => {
  const f = fixture();
  try {
    const saved = f.imports.import(date, f.write([f.session('timer-a', 0)]));
    const rowsBefore = f.store.database.prepare('SELECT count(*) AS count FROM work_sessions').get()!.count;
    assert.throws(() => f.imports.import(date, f.write([f.session('timer-a', 0, 24)])), /已导入|不同内容/u);
    assert.throws(() => f.imports.import(date, f.write([f.session('timer-new', 10)])), /重叠/u);
    assert.throws(() => f.imports.import(date, f.write([f.session('timer-b', 30), f.session('timer-c', 40)])), /重叠/u);
    assert.equal(f.days.getState(date).log!.revision, saved.log!.revision);
    assert.equal(f.store.database.prepare('SELECT count(*) AS count FROM work_sessions').get()!.count, rowsBefore);
    assert.equal(f.days.getState(date).log!.work_block_actuals[0].minutes, 25);
  } finally { f.close(); }
});

test('已有本机计时时段重叠拒绝，非重叠计时与导入仅按聚合秒数取整', () => {
  const f = fixture();
  try {
    const logId = f.days.findLog(date)!.id;
    f.store.database.prepare('INSERT INTO work_sessions VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), logId, 'shared', new Date(NOON).toISOString(), new Date(NOON + 59_000).toISOString(), 59);
    f.store.database.prepare('UPDATE daily_logs SET work_block_actuals_json=? WHERE id=?')
      .run(JSON.stringify([{ block_id: 'shared', minutes: 0, source: '计时记录（开始至暂停，已按整分钟累计）', updated_at: new Date().toISOString() }]), logId);
    assert.throws(() => f.imports.import(date, f.write([f.session('timer-overlap', 0)])), /重叠/u);
    const result = f.imports.import(date, f.write([f.session('timer-adjacent', 1, 1)]));
    assert.equal(result.log!.work_block_actuals[0].minutes, 1);
    assert.match(result.log!.work_block_actuals[0].source, /本机计时与一刻导入/u);
  } finally { f.close(); }
});

test('手填累计、跨业务日、活动计时及无计划映射均拒绝且不触碰已有记录', () => {
  const f = fixture();
  try {
    f.days.actual(date, { ...f.base(), block_id: 'shared', minutes: 25, source: '用户核对' });
    const before = f.days.getState(date);
    assert.throws(() => f.imports.import(date, f.write([f.session('timer-manual', 0)])), /手填/u);
    assert.throws(() => f.imports.import(date, f.write([f.session('timer-unmapped', 0, 25, 'missing')])), /当前已确认计划/u);
    const across = { ...f.session('timer-midnight'), startedAt: Date.parse(`${date}T15:50:00.000Z`),
      completedAt: Date.parse(`${date}T16:10:00.000Z`), durationMs: 20 * MINUTE };
    assert.throws(() => f.imports.import(date, f.write([across])), /跨越业务日期/u);
    assert.deepEqual(f.days.getState(date), before);
    const logId = f.days.findLog(date)!.id;
    f.store.database.prepare('INSERT INTO work_sessions VALUES(?,?,?,?,NULL,NULL)')
      .run(randomUUID(), logId, 'other', new Date(NOON).toISOString());
    assert.throws(() => f.imports.import(date, f.write([f.session('timer-active', 60, 25, 'other')])), /仍有计时在运行/u);
  } finally { f.close(); }
});

test('另一投入时段的手填分钟也会阻止自动叠加，因为没有可验证的不重叠时刻', () => {
  const f = fixture();
  try {
    f.days.actual(date, { ...f.base(), block_id: 'other', minutes: 10, source: '用户核对' });
    const before = f.days.getState(date);
    assert.throws(() => f.imports.import(date, f.write([f.session('timer-shared', 0)])), /手填/u);
    assert.deepEqual(f.days.getState(date), before);
    assert.equal(f.store.database.prepare('SELECT count(*) AS count FROM work_sessions').get()!.count, 0);
  } finally { f.close(); }
});

test('请求严格校验长度、时间和毫秒完整性', () => {
  const valid = { requestId: randomUUID(), revision: 1, sessions: [{ id: 'timer-valid', startedAt: NOON, completedAt: NOON + MINUTE, durationMs: MINUTE, blockId: 'shared' }] };
  for (const payload of [
    { ...valid, sessions: [] },
    { ...valid, sessions: Array.from({ length: 101 }, (_, i) => ({ ...valid.sessions[0], id: `timer-${i}` })) },
    { ...valid, sessions: [{ ...valid.sessions[0], durationMs: MINUTE + 1 }] },
    { ...valid, sessions: [{ ...valid.sessions[0], durationMs: MINUTE, completedAt: NOON + 1 }] },
    { ...valid, sessions: [{ ...valid.sessions[0], completedAt: Date.now() + 60_000 }] },
    { ...valid, sessions: [{ ...valid.sessions[0], mode: 'shortBreak' }] },
  ]) assert.throws(() => focusImportWrite(payload));
});

test('同源 HTTP 入口返回 DayState，现有 CSRF 规则仍保护写入', async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const folder = mkdtempSync(resolve(TEST_ROOT, 'focus-import-http-'));
  const app = createApp({ dataDir: resolve(folder, 'data'), port: 0 });
  try {
    const { url } = await app.listen();
    const csrf = (await (await testFetch(`${url}/api/session`)).json()).csrfToken as string;
    const call = async (path: string, body: unknown, token = csrf) => {
      const response = await testFetch(`${url}${path}`, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const setup = await call('/api/setup', { requestId: randomUUID(), timezone: 'Asia/Shanghai', availableMinutes: 180 });
    assert.equal(setup.status, 200);
    const confirmed = await call(`/api/days/${date}/confirm`, { requestId: randomUUID(), revision: 0,
      draft: plan(setup.body.projects.slice(0, 2).map((project: { id: string }) => project.id)), acknowledgeOverCapacity: false });
    assert.equal(confirmed.status, 200);
    const body = { requestId: randomUUID(), revision: confirmed.body.log.revision, sessions: [{ id: 'timer-http', startedAt: NOON,
      completedAt: NOON + MINUTE, durationMs: MINUTE, blockId: 'shared' }] };
    assert.equal((await call(`/api/days/${date}/focus-import`, body, 'invalid')).status, 403);
    const imported = await call(`/api/days/${date}/focus-import`, body);
    assert.equal(imported.status, 200);
    assert.equal(imported.body.log.work_block_actuals[0].minutes, 1);
  } finally { await app.close(); rmSync(folder, { recursive: true, force: true }); }
});

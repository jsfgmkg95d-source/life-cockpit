import { setupTestWorkspace, testFetch } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../server/app.ts';
import { BackupStore } from '../server/backup-store.ts';
import { DayStore } from '../server/day-store.ts';
import { AppError } from '../server/errors.ts';
import { InboxStore, inboxCaptureWrite, inboxPromoteWrite, inboxRestoreWrite } from '../server/inbox-store.ts';
import { SCHEMA_VERSION } from '../server/migrations.ts';
import { RestoreStore } from '../server/restore-store.ts';
import { ScheduleStore, scheduleSaveWrite } from '../server/schedule-store.ts';
import { Store } from '../server/store.ts';
import { TimerStore, timerStartWrite, timerStopWrite } from '../server/timer-store.ts';
import type { PlanDraft } from '../shared/day-contracts.ts';
import type { BackupManifest } from '../shared/dashboard-contracts.ts';
import type { QuickTaskInput } from '../shared/quick-task.ts';

const ROOT = resolve(import.meta.dirname, '..', '.runtime', 'tests');
const DATE = '2026-09-20';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const code = (expected: string) => (error: unknown) => error instanceof AppError && error.code === expected;

function fixture() {
  mkdirSync(ROOT, { recursive: true }); const folder = mkdtempSync(resolve(ROOT, 'planning-')), dataDir = resolve(folder, 'data');
  const store = new Store(dataDir), initial = setupTestWorkspace(store, randomUUID(), 'Asia/Shanghai', 180);
  const days = new DayStore(store), schedules = new ScheduleStore(days), inbox = new InboxStore(days), timers = new TimerStore(days);
  const base = (date = DATE) => ({ requestId: randomUUID(), revision: days.findLog(date)?.revision ?? 0 });
  const quick = (index = 0): QuickTaskInput => ({ project_id: initial.projects[index].id, project_revision: initial.projects[index].revision,
    title: '核对本轮写作成果', acceptance: '指定稿件已核对', result_type: 'binary', metric_key: null, target_value: 1,
    budget_minutes: 30, available_minutes: 180, resume_project: false, acknowledgeOverCapacity: false });
  const plan = (date = DATE) => days.quickTask(date, { ...base(date), ...quick() });
  const schedule = (start = 540, duration = 30, task: string | null = null) => ({ ...base(), task_id: task, title: '预留写作时间', start_minute: start, duration_minutes: duration });
  return { folder, dataDir, store, initial, days, schedules, inbox, timers, base, quick, plan, schedule,
    close() { store.close(); assert.equal(resolve(folder, '..'), ROOT); rmSync(folder, { recursive: true, force: true }); } };
}

test('时间安排与实际记录独立，边界相邻允许、重叠与跨日原子拒绝；更新及软删除可重试', () => {
  const f = fixture(); try {
    const firstInput = f.schedule(), first = f.schedules.save(DATE, firstInput);
    assert.equal(first.plannedMinutes, 30); assert.equal(first.revision, 1); assert.equal(first.blocks[0].task_eligible, null);
    assert.deepEqual(f.schedules.save(DATE, firstInput), first);
    assert.equal(f.days.findLog(DATE)!.current_plan_version, 0); assert.deepEqual(f.days.findLog(DATE)!.work_block_actuals, []);
    assert.equal(f.timers.view(DATE).summary.todayMinutes, null);
    f.store.database.prepare("UPDATE daily_logs SET record_state='complete' WHERE business_date=?").run(DATE);
    f.schedules.save(DATE, f.schedule(570, 30)); assert.equal(f.days.findLog(DATE)!.record_state, 'complete');
    const before = f.days.getState(DATE), beforeView = f.schedules.view(DATE);
    assert.throws(() => f.schedules.save(DATE, f.schedule(560, 20)), code('SCHEDULE_OVERLAP'));
    assert.deepEqual(f.days.getState(DATE), before); assert.deepEqual(f.schedules.view(DATE), beforeView);
    assert.throws(() => f.schedules.save(DATE, f.schedule(1439, 2)), /跨日/u);
    assert.throws(() => f.schedules.save(DATE, { ...f.schedule(), revision: 0 }), code('REVISION_CONFLICT'));
    const changed = f.schedules.save(DATE, { ...f.schedule(600, 45), id: first.blocks[0].id });
    assert.equal(changed.plannedMinutes, 75); assert.equal(changed.blocks.find(block => block.id === first.blocks[0].id)!.start_minute, 600);
    const remove = { ...f.base(), id: first.blocks[0].id }; const deleted = f.schedules.delete(DATE, remove);
    assert.equal(deleted.plannedMinutes, 30); assert.deepEqual(f.schedules.delete(DATE, remove), deleted);
    assert.ok(f.store.database.prepare('SELECT deleted_at FROM day_schedule WHERE id=?').get(remove.id)!.deleted_at);
    f.schedules.save(DATE, f.schedule(1439, 1));
    assert.throws(() => scheduleSaveWrite({ ...f.schedule(), duration_minutes: 721 }));
  } finally { f.close(); }
});

test('同任务可以分段安排；跨日关联拒绝，计划替换保留原块且提示旧任务', () => {
  const f = fixture(); try {
    const initial = f.plan(), task = initial.tasks[0];
    f.schedules.save(DATE, f.schedule(540, 20, task.task_id)); f.schedules.save(DATE, f.schedule(600, 25, task.task_id));
    assert.equal(f.schedules.view(DATE).blocks.filter(block => block.task_id === task.task_id).length, 2);
    f.days.quickTask('2026-09-19', { ...f.base('2026-09-19'), ...f.quick() });
    const other = f.days.getState('2026-09-19').tasks[0];
    assert.throws(() => f.schedules.save(DATE, f.schedule(660, 20, other.task_id)), code('TASK_NOT_FOUND'));
    const draft = structuredClone(f.days.findLog(DATE)!.plan_snapshots.at(-1)!); draft.tasks[0].title = '修订后的明确行动'; draft.change_reason = '重新核对行动内容';
    f.days.confirm(DATE, { ...f.base(), draft, acknowledgeOverCapacity: false });
    assert.ok(f.schedules.view(DATE).blocks.every(block => block.task_eligible === false));
    assert.throws(() => f.schedules.save(DATE, f.schedule(660, 20, task.task_id)), /当前安排/u);
    assert.equal(f.schedules.view(DATE).plannedMinutes, 45); assert.deepEqual(f.days.findLog(DATE)!.work_block_actuals, []);
  } finally { f.close(); }
});

test('收件箱只捕获文字且无正式任务；捕获和归档幂等，严格校验项目/估时/额外字段', () => {
  const f = fixture(); try {
    const input = { requestId: randomUUID(), title: '读完材料后记下一个想法' };
    const captured = f.inbox.capture(input);
    assert.equal(captured.inboxCount, 1); assert.equal(captured.item.project_id, null); assert.equal(captured.item.estimated_minutes, null);
    assert.deepEqual(f.inbox.capture(input), captured); assert.equal(f.days.findLog(DATE), null);
    assert.throws(() => f.inbox.capture({ ...input, title: '重试内容变了' }), code('IDEMPOTENCY_CONFLICT'));
    assert.throws(() => f.inbox.capture({ requestId: randomUUID(), title: '错误项目', project_id: 'missing' }), code('PROJECT_NOT_FOUND'));
    assert.equal(f.inbox.view().items.length, 1);
    assert.throws(() => inboxCaptureWrite({ ...input, estimated_minutes: -1 })); assert.throws(() => inboxCaptureWrite({ ...input, unexpected: true }));
    const archive = { requestId: randomUUID(), revision: 1 }, archived = f.inbox.archive(captured.item.id, archive);
    assert.equal(archived.inboxCount, 0); assert.equal(archived.item.status, 'archived'); assert.equal(archived.item.revision, 2);
    assert.deepEqual(f.inbox.archive(captured.item.id, archive), archived);
    assert.throws(() => f.inbox.archive(captured.item.id, { requestId: randomUUID(), revision: 1 }), code('REVISION_CONFLICT'));
  } finally { f.close(); }
});

test('收件箱晋升与计划同事务，只加入一项且保留草稿；重试不会重复任务或自动确认成果', () => {
  const f = fixture(); try {
    const pending = f.inbox.capture({ requestId: randomUUID(), title: '初步想法', project_id: f.initial.projects[0].id, estimated_minutes: 20 }).item;
    const savedDraft = structuredClone(f.days.suggestedDraft()); savedDraft.notes = '待核对的其他候选不能导入';
    f.days.saveDraft(DATE, { ...f.base(), draft: savedDraft });
    const input = { ...f.base(), ...f.quick(), inbox_id: pending.id, inbox_revision: 1 };
    const state = f.inbox.promote(DATE, input), planned = f.inbox.get(pending.id);
    assert.equal(state.tasks.length, 1); assert.deepEqual(state.log!.draft_plan, savedDraft); assert.equal(state.tasks[0].result_state, 'unknown');
    assert.equal(state.effective_events.length, 0); assert.deepEqual(state.log!.work_block_actuals, []);
    assert.equal(planned.status, 'planned'); assert.equal(planned.planned_task_id, state.tasks[0].task_id); assert.equal(planned.planned_date, DATE);
    assert.deepEqual(f.inbox.promote(DATE, input), state); assert.equal(f.inbox.view().items.length, 1);
    const before = f.days.getState(DATE);
    assert.throws(() => f.inbox.promote(DATE, { ...input, ...f.base(), inbox_revision: planned.revision }), code('INBOX_ALREADY_PLANNED'));
    assert.deepEqual(f.days.getState(DATE), before);
    assert.throws(() => inboxPromoteWrite({ ...input, acceptance: '' }), /完成标准/u);
  } finally { f.close(); }
});

test('收件箱归档可恢复且幂等，旧版本冲突；恢复后可正常晋升，已晋升项不能重复恢复', () => {
  const f = fixture(); try {
    const captured = f.inbox.capture({ requestId: randomUUID(), title: '暂时放下的写作事项', project_id: f.initial.projects[0].id, estimated_minutes: 20 }).item;
    assert.throws(() => f.inbox.restore(captured.id, { requestId: randomUUID(), revision: 1 }), code('INBOX_NOT_ARCHIVED'));
    f.inbox.archive(captured.id, { requestId: randomUUID(), revision: 1 });
    const request = { requestId: randomUUID(), revision: 2 }, restored = f.inbox.restore(captured.id, request);
    assert.equal(restored.item.status, 'inbox'); assert.equal(restored.item.revision, 3); assert.equal(restored.inboxCount, 1);
    assert.equal(restored.item.title, captured.title); assert.equal(restored.item.project_id, captured.project_id); assert.equal(restored.item.estimated_minutes, 20);
    assert.equal(restored.item.planned_date, null); assert.equal(f.days.findLog(DATE), null);
    assert.deepEqual(f.inbox.restore(captured.id, request), restored);
    assert.throws(() => f.inbox.restore(captured.id, { requestId: randomUUID(), revision: 2 }), code('REVISION_CONFLICT'));
    assert.throws(() => inboxRestoreWrite({ ...request, unexpected: true }));
    const promoted = f.inbox.promote(DATE, { ...f.base(), ...f.quick(), inbox_id: captured.id, inbox_revision: 3 });
    const item = f.inbox.get(captured.id), before = f.days.getState(DATE);
    assert.equal(promoted.tasks.length, 1); assert.equal(item.status, 'planned');
    assert.throws(() => f.inbox.restore(item.id, { requestId: randomUUID(), revision: item.revision }), code('INBOX_ALREADY_PLANNED'));
    f.inbox.archive(item.id, { requestId: randomUUID(), revision: item.revision });
    const archivedPlan = f.inbox.get(item.id);
    assert.throws(() => f.inbox.restore(item.id, { requestId: randomUUID(), revision: archivedPlan.revision }), code('INBOX_ALREADY_PLANNED'));
    assert.equal(f.inbox.get(item.id).revision, archivedPlan.revision); assert.deepEqual(f.days.getState(DATE), before);
  } finally { f.close(); }
});

test('过期收件箱或无效任务使晋升全回滚，包括项目恢复、当天日志和计划版本', () => {
  const f = fixture(); try {
    const pending = f.inbox.capture({ requestId: randomUUID(), title: '尚未决定如何做' }).item;
    const project = f.store.getProject(f.initial.projects[0].id); f.store.updateProject(project.id, project.revision, { ...project, status: 'paused' });
    const paused = f.store.getProject(project.id), input = { ...f.base(), ...f.quick(), project_revision: paused.revision, resume_project: true, inbox_id: pending.id, inbox_revision: 99 };
    assert.throws(() => f.inbox.promote(DATE, input), code('REVISION_CONFLICT'));
    assert.equal(f.days.findLog(DATE), null); assert.equal(f.store.getProject(project.id).status, 'paused'); assert.equal(f.inbox.get(pending.id).revision, 1);
    assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM tasks').get()!.n, 0);
  } finally { f.close(); }
});

test('任务专注归属与目标持久化；共享时段只计一次，暂停不会确认成果或复活已结束任务', () => {
  const f = fixture(); try {
    const date = today(); const first = f.plan(date), task = first.tasks[0];
    const input = { ...f.base(date), task_id: task.task_id, target_minutes: 25 };
    const started = f.timers.start(date, task.work_block_id, input);
    assert.equal(started.tasks[0].status, 'doing'); assert.equal(started.tasks[0].result_state, 'unknown');
    const active = f.timers.view(date).active!;
    assert.equal(active.task_id, task.task_id); assert.equal(active.task_title, task.title); assert.equal(active.target_minutes, 25);
    assert.deepEqual(f.timers.start(date, task.work_block_id, input), started);
    assert.throws(() => f.timers.start(date, task.work_block_id, { ...f.base(date), task_id: task.task_id }), /已有计时/u);
    const begin = new Date(Date.now() - 65_000).toISOString(); f.store.database.prepare('UPDATE work_sessions SET started_at=? WHERE id=?').run(begin, active.id);
    const stopped = f.timers.stop(date, { ...f.base(date), discard: false });
    assert.equal(f.timers.view(date).summary.todayMinutes, 1); assert.equal(stopped.tasks[0].result_state, 'unknown'); assert.equal(stopped.tasks[0].status, 'doing');
    assert.equal(f.timers.view(date).sessions[0].task_title, task.title);
    f.days.status(date, task.task_id, { ...f.base(date), status: 'done' });
    assert.throws(() => f.timers.start(date, task.work_block_id, { ...f.base(date), task_id: task.task_id, target_minutes: 25 }), /已经结束/u);
    assert.equal(f.timers.view(date).active, null); assert.throws(() => timerStartWrite({ ...f.base(), block_id: 'a', target_minutes: 0 }));
    assert.throws(() => timerStartWrite({ ...f.base(), block_id: 'a', target_minutes: 241 }));
    f.days.status(date, task.task_id, { ...f.base(date), status: 'todo' });
    const sharedDraft: PlanDraft = structuredClone(f.days.findLog(date)!.plan_snapshots.at(-1)!);
    sharedDraft.change_reason = '安排同一共享时段内的另一任务'; sharedDraft.tasks[0].raw_points = 25;
    sharedDraft.tasks.push({ ...sharedDraft.tasks[0], candidate_id: randomUUID(), task_id: null, title: '同一时段的另一行动', raw_points: 25 });
    f.days.confirm(date, { ...f.base(date), draft: sharedDraft, acknowledgeOverCapacity: false });
    const tasks = f.days.getState(date).tasks.filter(item => item.eligible), next = tasks.find(item => item.title === '同一时段的另一行动')!;
    f.timers.start(date, next.work_block_id, { ...f.base(date), task_id: next.task_id, target_minutes: 50 });
    assert.equal(f.timers.view(date).active!.task_title, next.title); f.timers.stop(date, { ...f.base(date), discard: true });
    assert.equal(f.timers.view(date).summary.todayMinutes, 1);
  } finally { f.close(); }
});

test('专注拒绝跨日、错时段和已移出计划的任务，失败没有会话或状态残留', () => {
  const f = fixture(); try {
    const date = today(), state = f.plan(date), task = state.tasks[0];
    const previous = f.plan(DATE).tasks[0];
    const before = f.days.getState(date);
    assert.throws(() => f.timers.start(date, task.work_block_id, { ...f.base(date), task_id: previous.task_id }), code('TASK_NOT_FOUND'));
    assert.throws(() => f.timers.start(date, task.work_block_id, { ...f.base(date), task_id: task.task_id, target_minutes: 999 }));
    assert.deepEqual(f.days.getState(date), before); assert.equal(f.timers.view(date).active, null);
    const newState = f.days.quickTask(date, { ...f.base(date), ...f.quick(1) }), other = newState.tasks.find(item => item.project_id === f.initial.projects[1].id)!;
    assert.throws(() => f.timers.start(date, task.work_block_id, { ...f.base(date), task_id: other.task_id }), /所选投入/u);
    assert.equal(f.days.getState(date).tasks.find(item => item.task_id === other.task_id)!.status, 'todo');
  } finally { f.close(); }
});

test('旧专注 A 的暂停拒绝误停后来启动的 B；A 丢响应重放回执也不影响 B', () => {
  const f = fixture(); try {
    const date = today(); f.plan(date); f.days.quickTask(date, { ...f.base(date), ...f.quick(1) });
    const [a, b] = f.days.getState(date).tasks.filter(task => task.eligible);
    f.timers.start(date, a.work_block_id, { ...f.base(date), task_id: a.task_id });
    const aId = f.timers.view(date).active!.id;
    const originalStop = { ...f.base(date), discard: true, expected_session_id: aId };
    f.timers.stop(date, originalStop);
    f.timers.start(date, b.work_block_id, { ...f.base(date), task_id: b.task_id });
    const bId = f.timers.view(date).active!.id, before = f.days.getState(date);
    assert.throws(() => f.timers.stop(date, { ...f.base(date), discard: false, expected_session_id: aId }), code('TIMER_SESSION_CHANGED'));
    assert.deepEqual(f.days.getState(date), before); assert.equal(f.timers.view(date).active!.id, bId);
    f.timers.stop(date, originalStop); // Simulate retry after A's successful stop response was lost.
    assert.deepEqual(f.days.getState(date), before); assert.equal(f.timers.view(date).active!.id, bId);
    f.timers.stop(date, { ...f.base(date), discard: true, expected_session_id: bId }); assert.equal(f.timers.view(date).active, null);
    assert.throws(() => timerStopWrite({ ...f.base(date), discard: false, expected_session_id: 123 }));
  } finally { f.close(); }
});

test('schema 8 旧计时请求指纹升级后原样重放，省略新增字段不改变 hash 或重复写入', () => {
  const f = fixture(); try {
    const date = today(), task = f.plan(date).tasks[0];
    const start = f.base(date), stop = { requestId: randomUUID(), revision: start.revision + 1, discard: true };
    // Use the original v8 checked payload and writes, before newer context fields existed.
    f.days.mutate(date, 'timer-start', { ...start, blockId: task.work_block_id }, log => {
      f.store.database.prepare('INSERT INTO work_sessions VALUES(?,?,?,?,NULL,NULL)').run(randomUUID(), log.id, task.work_block_id, new Date().toISOString());
    });
    f.days.mutate(date, 'timer-stop', stop, log => f.timers.stopInTransaction(log, true));
    const before = f.days.getState(date), receipts = f.store.database.prepare("SELECT * FROM request_dedup WHERE scope LIKE ? ORDER BY rowid").all(`day:${date}:timer-%`);
    assert.equal(receipts.length, 2);
    f.store.close(); const old = new DatabaseSync(resolve(f.dataDir, 'personal-company.sqlite'));
    old.exec('DROP TABLE work_session_context; DROP TABLE day_schedule; DROP TABLE inbox_items; PRAGMA user_version=8;'); old.close();
    const upgraded = new Store(f.dataDir); try {
      const days = new DayStore(upgraded), timers = new TimerStore(days);
      const { block_id, ...checkedStart } = timerStartWrite({ ...start, block_id: task.work_block_id });
      assert.equal(Object.hasOwn(checkedStart, 'task_id'), false); assert.equal(Object.hasOwn(checkedStart, 'target_minutes'), false);
      assert.equal(Object.hasOwn(timerStopWrite(stop), 'expected_session_id'), false);
      assert.deepEqual(timers.start(date, block_id, checkedStart), before);
      assert.deepEqual(timers.stop(date, timerStopWrite(stop)), before);
      assert.deepEqual(upgraded.database.prepare("SELECT * FROM request_dedup WHERE scope LIKE ? ORDER BY rowid").all(`day:${date}:timer-%`), receipts);
      assert.equal(upgraded.database.prepare('SELECT count(*) AS n FROM work_sessions').get()!.n, 1);
      assert.equal(upgraded.database.prepare('SELECT count(*) AS n FROM work_session_context').get()!.n, 0);
      assert.equal(timers.view(date).active, null);
      assert.equal(Object.hasOwn(timerStartWrite({ ...start, block_id: task.work_block_id, task_id: null }), 'task_id'), true);
      assert.equal(Object.hasOwn(timerStopWrite({ ...stop, expected_session_id: null }), 'expected_session_id'), true);
    } finally { upgraded.close(); }
  } finally { f.close(); }
});

test('专注任务关联和目标经完整备份/恢复及重启保留，任务后续改名不会改写历史标题', () => {
  const f = fixture(); try {
    const date = today(), task = f.plan(date).tasks[0];
    f.timers.start(date, task.work_block_id, { ...f.base(date), task_id: task.task_id, target_minutes: 45 });
    f.timers.stop(date, { ...f.base(date), discard: true });
    const before = f.timers.view(date), context = f.store.database.prepare('SELECT * FROM work_session_context').all();
    const backups = new BackupStore(f.store, resolve(f.folder, 'backups')), backup = backups.create(randomUUID()), restore = new RestoreStore(f.store, backups, () => false);
    assert.equal(backup.rowCounts.work_session_context, 1);
    const draft = structuredClone(f.days.findLog(date)!.plan_snapshots.at(-1)!); draft.tasks[0].title = '下一版的新任务名称'; draft.change_reason = '明确替换行动';
    f.days.confirm(date, { ...f.base(date), draft, acknowledgeOverCapacity: false });
    assert.equal(f.timers.view(date).sessions[0].task_title, task.title);
    f.store.database.prepare('DELETE FROM work_session_context').run();
    assert.equal(f.timers.view(date).sessions[0].task_title, null);
    const preview = restore.preview(backup.id); restore.restore(randomUUID(), preview.token, '恢复本地账本');
    assert.deepEqual(f.timers.view(date), before); assert.deepEqual(f.store.database.prepare('SELECT * FROM work_session_context').all(), context);
    f.store.close(); const reopened = new Store(f.dataDir); try { assert.deepEqual(new TimerStore(new DayStore(reopened)).view(date), before); } finally { reopened.close(); }
  } finally { f.close(); }
});

test('schema 9 增量迁移保留 schema 8 原账本；新三表经重启与完整备份恢复保持一致', () => {
  const f = fixture(); try {
    const state = f.plan(), task = state.tasks[0]; f.schedules.save(DATE, f.schedule(540, 25, task.task_id));
    const pending = f.inbox.capture({ requestId: randomUUID(), title: '等待稍后安排', estimated_minutes: 15 });
    const beforeSchedule = f.schedules.view(DATE), beforeInbox = f.inbox.view();
    const backups = new BackupStore(f.store, resolve(f.folder, 'backups')), restore = new RestoreStore(f.store, backups, () => false), backup = backups.create(randomUUID());
    assert.equal(backup.schemaVersion, SCHEMA_VERSION); assert.equal(backup.rowCounts.day_schedule, 1); assert.equal(backup.rowCounts.inbox_items, 1);
    f.inbox.archive(pending.item.id, { requestId: randomUUID(), revision: 1 }); f.schedules.delete(DATE, { ...f.base(), id: beforeSchedule.blocks[0].id });
    const preview = restore.preview(backup.id); restore.restore(randomUUID(), preview.token, '恢复本地账本');
    assert.deepEqual(f.schedules.view(DATE), beforeSchedule); assert.deepEqual(f.inbox.view(), beforeInbox);
    f.store.close(); const reopened = new Store(f.dataDir); try {
      assert.deepEqual(new ScheduleStore(new DayStore(reopened)).view(DATE), beforeSchedule); assert.deepEqual(new InboxStore(new DayStore(reopened)).view(), beforeInbox);
    } finally { reopened.close(); }
    // Strip only the additive schema 9 objects to simulate a genuine complete v8 backup.
    const dir = resolve(backups.directory, backup.id), db = new DatabaseSync(resolve(dir, 'database.sqlite'));
    db.exec('DROP TABLE work_session_context; DROP TABLE day_schedule; DROP TABLE inbox_items; PRAGMA user_version=8;');
    const oldDays = db.prepare('SELECT * FROM daily_logs').all();
    const rows = Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => [String(row.name), db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()])); db.close();
    const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')) as BackupManifest; manifest.schemaVersion = 8; manifest.rowCounts = Object.fromEntries(Object.entries(rows).map(([name, values]) => [name, values.length]));
    writeFileSync(resolve(dir, 'export.json'), JSON.stringify({ format: 'personal-company-export-v1', schemaVersion: 8, createdAt: manifest.createdAt, excluded: manifest.excluded, tables: rows }));
    for (const name of ['database.sqlite', 'export.json'] as const) { const bytes = readFileSync(resolve(dir, name)); manifest.files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
    writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest));
    const current = new Store(f.dataDir); try {
      const oldRestore = new RestoreStore(current, new BackupStore(current, backups.directory), () => false), oldPreview = oldRestore.preview(backup.id);
      assert.ok(oldPreview.warnings.some(message => message.includes('旧备份没有收件箱'))); oldRestore.restore(randomUUID(), oldPreview.token, '恢复本地账本');
      assert.deepEqual(current.database.prepare('SELECT * FROM daily_logs').all(), oldDays); assert.equal(new InboxStore(new DayStore(current)).view().items.length, 0);
      assert.equal(new ScheduleStore(new DayStore(current)).view(DATE).blocks.length, 0);
      const protectedDb = new DatabaseSync(resolve(backups.directory, oldRestore.get([...current.database.prepare('SELECT request_id FROM restore_receipts ORDER BY rowid DESC').all()][0].request_id as string).preservationBackupId, 'database.sqlite'), { readOnly: true });
      try { assert.equal(protectedDb.prepare('SELECT count(*) AS n FROM inbox_items').get()!.n, 1); } finally { protectedDb.close(); }
    } finally { current.close(); }
  } finally { f.close(); }
});

test('新捕获/安排/晋升/专注 HTTP 接口受 CSRF、严格输入和 revision 保护', async () => {
  mkdirSync(ROOT, { recursive: true }); const folder = mkdtempSync(resolve(ROOT, 'planning-http-')), app = createApp({ dataDir: resolve(folder, 'data') });
  try {
    const { url } = await app.listen(), token = (await (await testFetch(`${url}/api/session`)).json()).csrfToken as string;
    const post = async (path: string, body: unknown, csrf = token) => { const response = await testFetch(url + path, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
    const setup = await post('/api/setup', { requestId: randomUUID(), timezone: 'Asia/Shanghai', availableMinutes: 180 });
    const captureInput = { requestId: randomUUID(), title: '需要核对的稿件' };
    assert.equal((await post('/api/inbox/capture', captureInput, 'invalid')).status, 403);
    const captured = await post('/api/inbox/capture', captureInput); assert.equal(captured.status, 201);
    assert.equal((await (await testFetch(url + '/api/inbox')).json()).inboxCount, 1);
    const archived = await post(`/api/inbox/${captured.body.item.id}/archive`, { requestId: randomUUID(), revision: 1 }); assert.equal(archived.status, 200);
    assert.equal((await post(`/api/inbox/${captured.body.item.id}/restore`, { requestId: randomUUID(), revision: 2 }, 'invalid')).status, 403);
    const restored = await post(`/api/inbox/${captured.body.item.id}/restore`, { requestId: randomUUID(), revision: 2 }); assert.equal(restored.status, 200); assert.equal(restored.body.inboxCount, 1);
    const date = today(), project = setup.body.projects[0];
    const promoted = await post(`/api/days/${date}/inbox-promote`, { requestId: randomUUID(), revision: 0, inbox_id: captured.body.item.id, inbox_revision: 3,
      project_id: project.id, project_revision: project.revision, title: '核对指定稿件', acceptance: '核对完成', result_type: 'binary', metric_key: null, target_value: 1, budget_minutes: 30, available_minutes: 180, resume_project: false, acknowledgeOverCapacity: false });
    assert.equal(promoted.status, 200); const task = promoted.body.tasks[0];
    const saved = await post(`/api/days/${date}/schedule/save`, { requestId: randomUUID(), revision: 1, task_id: task.task_id, title: task.title, start_minute: 540, duration_minutes: 25 });
    assert.equal(saved.status, 200); assert.equal(saved.body.plannedMinutes, 25);
    assert.equal((await post(`/api/days/${date}/timer/start`, { requestId: randomUUID(), revision: 1, block_id: task.work_block_id, task_id: task.task_id, target_minutes: 25 })).status, 409);
    const started = await post(`/api/days/${date}/timer/start`, { requestId: randomUUID(), revision: 2, block_id: task.work_block_id, task_id: task.task_id, target_minutes: 25 }); assert.equal(started.status, 200);
    const timer = await (await testFetch(url + `/api/days/${date}/timer`)).json(); assert.equal(timer.active.task_title, task.title); assert.equal(timer.active.target_minutes, 25);
    assert.equal((await post(`/api/days/${date}/timer/stop`, { requestId: randomUUID(), revision: 3, discard: true, expected_session_id: 'stale-session' })).status, 409);
    assert.equal((await post(`/api/days/${date}/timer/stop`, { requestId: randomUUID(), revision: 3, discard: true, expected_session_id: timer.active.id })).status, 200);
    assert.equal((await post(`/api/days/${date}/schedule/delete`, { requestId: randomUUID(), revision: 4, id: saved.body.blocks[0].id })).status, 200);
    assert.equal((await (await testFetch(url + `/api/days/${date}/schedule`)).json()).plannedMinutes, 0);
    assert.equal((await post('/api/inbox/capture', { ...captureInput, unknown: true })).status, 400);
  } finally { await app.close(); assert.equal(resolve(folder, '..'), ROOT); rmSync(folder, { recursive: true, force: true }); }
});

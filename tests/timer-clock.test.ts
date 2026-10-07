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
import { FocusImportStore } from '../server/focus-import-store.ts';
import { migrate, SCHEMA_VERSION } from '../server/migrations.ts';
import { RestoreStore } from '../server/restore-store.ts';
import { Store } from '../server/store.ts';
import { TimerStore, timerPeriodWrite, timerPointWrite } from '../server/timer-store.ts';
import type { PlanDraft } from '../shared/day-contracts.ts';
import type { BackupManifest } from '../shared/dashboard-contracts.ts';

const ROOT = resolve(import.meta.dirname, '..', '.runtime', 'tests');
const date = '2026-09-20';
const at = (clock: string) => `${date}T${clock}+08:00`;

function fixture(planned = true) {
  mkdirSync(ROOT, { recursive: true }); const folder = mkdtempSync(resolve(ROOT, 'clock-'));
  const dataDir = resolve(folder, 'data'); const store = new Store(dataDir);
  const initial = setupTestWorkspace(store, randomUUID(), 'Asia/Shanghai', 180);
  const days = new DayStore(store), timers = new TimerStore(days);
  const base = (day = date) => ({ requestId: randomUUID(), revision: days.findLog(day)?.revision ?? 0 });
  const draft: PlanDraft = { day_mode: 'work', available_minutes: 180, change_reason: '', notes: '',
    dimensions: { cashflow: { applicable: true, reason: '' }, asset: { applicable: false, reason: '隔离测试' }, health: { applicable: false, reason: '隔离测试' }, learning: { applicable: false, reason: '隔离测试' } },
    work_blocks: [{ id: 'a', title: '写作', budget_minutes: 60 }, { id: 'b', title: '学习', budget_minutes: 60 }],
    tasks: ['a', 'b'].map((id, i) => ({ candidate_id: id, task_id: null, project_id: initial.projects[i].id, title: `任务${id}`, acceptance: '指定工作已完成', result_type: 'binary', metric_key: null, target_value: 1, scoring_dimension: 'cashflow', raw_points: 25, estimated_minutes: null, work_block_id: id })) };
  const plan = (day = date) => days.confirm(day, { ...base(day), draft: structuredClone(draft), acknowledgeOverCapacity: false });
  if (planned) plan();
  const period = (start: string, end: string, block = 'a') => ({ ...base(), block_id: block, started_at: at(start), stopped_at: at(end) });
  return { folder, dataDir, store, days, timers, base, plan, draft, period,
    close() { store.close(); assert.equal(resolve(folder, '..'), ROOT); rmSync(folder, { recursive: true, force: true }); } };
}

test('时间点无需计划，按本日日志时区归档；重试、软撤销、未知分钟与结算状态独立', () => {
  const f = fixture(false); try {
    const input = { ...f.base(), label: '开始读书', occurred_at: at('08:10:00') };
    const saved = f.timers.point(date, input);
    assert.equal(saved.log!.current_plan_version, 0); assert.deepEqual(saved.log!.work_block_actuals, []);
    assert.deepEqual(f.timers.point(date, input), saved);
    let view = f.timers.view(date); assert.equal(view.points.length, 1); assert.equal(view.points[0].occurred_at, `${date}T00:10:00.000Z`);
    assert.equal(view.summary.todayMinutes, null); assert.equal(view.summary.totalMinutes, null); assert.equal(view.summary.pointCount, 1);
    assert.throws(() => f.timers.point(date, { ...f.base(), label: '开始读书', occurred_at: at('08:10:00') }), /相同时间点/u);
    assert.throws(() => f.timers.point(date, { ...f.base(), label: '日期错位', occurred_at: `${date}T23:10:00.000Z` }), /业务日期/u);
    assert.throws(() => f.timers.point(date, { ...input, requestId: randomUUID() }), /当天记录已更新/u);
    f.store.database.prepare("UPDATE daily_logs SET record_state='complete' WHERE business_date=?").run(date);
    f.timers.point(date, { ...f.base(), label: '完成阅读', occurred_at: at('08:30:00') });
    assert.equal(f.days.findLog(date)!.record_state, 'complete');
    const removal = { ...f.base(), point_id: view.points[0].id };
    f.timers.deletePoint(date, removal); f.timers.deletePoint(date, removal);
    view = f.timers.view(date); assert.equal(view.points.length, 1); assert.equal(view.summary.pointCount, 1);
    assert.ok(f.store.database.prepare('SELECT deleted_at FROM timer_points WHERE id=?').get(removal.point_id)!.deleted_at);
    assert.equal(f.days.findLog(date)!.record_state, 'complete');
  } finally { f.close(); }
});

test('精确时间段累计秒数只形成一次正式分钟；同一天跨时段重叠拒绝，边界相邻可存', () => {
  const f = fixture(); try {
    const input = f.period('09:00:00', '09:00:40');
    const first = f.timers.period(date, input); assert.equal(first.log!.work_block_actuals[0].minutes, 0);
    assert.deepEqual(f.timers.period(date, input), first);
    f.timers.period(date, f.period('09:00:40', '09:01:20'));
    assert.equal(f.timers.view(date).summary.todayMinutes, 1);
    assert.equal(f.timers.view(date).sessions.reduce((sum, item) => sum + item.elapsed_seconds!, 0), 80);
    assert.equal(f.timers.view(date).sessions[0].block_title, '写作');
    const before = f.days.getState(date);
    assert.throws(() => f.timers.period(date, f.period('09:00:30', '09:01:30', 'b')), /重叠/u);
    assert.throws(() => f.timers.period(date, { ...input, ...f.base() }), /重叠/u);
    assert.deepEqual(f.days.getState(date), before);
    f.timers.period(date, f.period('09:01:20', '09:02:20', 'b'));
    assert.equal(f.timers.view(date).summary.todayMinutes, 2);
    assert.equal(f.timers.view(date).summary.totalMinutes, 2); // Never add sessions to authoritative actuals a second time.
  } finally { f.close(); }
});

test('时间段拒绝未来、无时区、错误日期、跨日、倒序、超过八小时与活动计时，失败原子回滚', () => {
  const f = fixture(); try {
    const before = f.days.getState(date);
    const invalid = [f.period('09:00:00', '08:00:00'), f.period('09:00:00', '17:00:01'),
      { ...f.period('09:00:00', '09:10:00'), stopped_at: '2026-09-21T00:00:00+08:00' },
      { ...f.period('09:00:00', '09:10:00'), started_at: '2026-02-30T09:00:00+08:00' },
      { ...f.period('09:00:00', '09:10:00'), started_at: `${date}T09:00:00` },
      { ...f.period('09:00:00', '09:10:00'), stopped_at: '2099-01-01T00:00:00.000Z' },
      { ...f.period('09:00:00', '09:10:00'), block_id: 'not-confirmed' }];
    for (const input of invalid) { assert.throws(() => f.timers.period(date, input)); assert.deepEqual(f.days.getState(date), before); }
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    f.plan(today); f.timers.start(today, 'a', f.base(today));
    const active = f.timers.view(date).active!; assert.equal(active.business_date, today); assert.equal(active.block_title, '写作');
    assert.throws(() => f.timers.period(date, f.period('09:00:00', '09:10:00')), /先暂停/u);
    f.timers.stop(today, { ...f.base(today), discard: true });
    f.timers.period(date, f.period('09:00:00', '17:00:00')); assert.equal(f.timers.view(date).summary.todayMinutes, 480);
  } finally { f.close(); }
});

test('历史已确认时段仍可补记；手填累计必须明确核对，其他块的手填不会误判目标块', () => {
  const f = fixture(); try {
    f.days.actual(date, { ...f.base(), block_id: 'b', minutes: 25, source: '手填另一个时段' });
    const edited = structuredClone(f.days.getState(date).log!.plan_snapshots.at(-1)!); edited.tasks = edited.tasks.filter(task => task.work_block_id === 'b');
    edited.tasks[0].raw_points = 50; edited.work_blocks = edited.work_blocks.filter(block => block.id === 'b'); edited.change_reason = '移出时段a但保留历史';
    f.days.confirm(date, { ...f.base(), draft: edited, acknowledgeOverCapacity: false });
    f.timers.period(date, f.period('09:00:00', '09:05:00')); assert.equal(f.timers.view(date).summary.todayMinutes, 30);
    const input = f.period('09:10:00', '09:15:00', 'b'), before = f.days.getState(date);
    assert.throws(() => f.timers.period(date, input), /未包含在已有累计/u); assert.deepEqual(f.days.getState(date), before);
    const acknowledged = f.timers.period(date, { ...input, acknowledgeUntrackedActual: true });
    assert.equal(acknowledged.log!.work_block_actuals.find(actual => actual.block_id === 'b')!.minutes, 30);
    assert.match(acknowledged.log!.work_block_actuals.find(actual => actual.block_id === 'b')!.source, /用户已确认本段未含/u);
    assert.equal(f.timers.view(date).summary.todayMinutes, 35);
    f.days.actual(date, { ...f.base(), block_id: 'a', minutes: null, source: '恢复未知' });
    assert.throws(() => f.timers.period(date, { ...f.period('10:00:00', '10:05:00'), acknowledgeUntrackedActual: true }), /清空为未知/u);
  } finally { f.close(); }
});

test('一刻记录与精确补记共享重叠检查和秒数累计；有已弃计段不占用实际时间', () => {
  const f = fixture(); try {
    const imports = new FocusImportStore(f.days);
    const started = Date.parse(at('09:00:00'));
    imports.import(date, { ...f.base(), sessions: [{ id: 'qa-known', startedAt: started, completedAt: started + 60_000, durationMs: 60_000, blockId: 'a' }] });
    assert.throws(() => f.timers.period(date, f.period('09:00:30', '09:02:00', 'b')), /重叠/u);
    f.timers.period(date, f.period('09:01:00', '09:02:00'));
    imports.import(date, { ...f.base(), sessions: [{ id: 'qa-after', startedAt: started + 120_000, completedAt: started + 180_000, durationMs: 60_000, blockId: 'a' }] });
    assert.equal(f.timers.view(date).summary.todayMinutes, 3);
    f.store.database.prepare('INSERT INTO work_sessions VALUES(?,?,?,?,?,0)').run(randomUUID(), f.days.findLog(date)!.id, 'a', new Date(started + 180_000).toISOString(), new Date(started + 300_000).toISOString());
    f.timers.period(date, f.period('09:03:00', '09:04:00')); assert.equal(f.timers.view(date).summary.todayMinutes, 4);
  } finally { f.close(); }
});

test('明确核对追加到手填累计仍保留秒数余量，超出1440分钟整体回滚', () => {
  const f = fixture(); try {
    f.days.actual(date, { ...f.base(), block_id: 'a', minutes: 10, source: '用户确认此前累计' });
    f.timers.period(date, { ...f.period('09:00:00', '09:00:30'), acknowledgeUntrackedActual: true });
    assert.equal(f.timers.view(date).summary.todayMinutes, 10);
    f.timers.period(date, { ...f.period('09:00:30', '09:01:00'), acknowledgeUntrackedActual: true });
    assert.equal(f.timers.view(date).summary.todayMinutes, 11);
    assert.equal(f.timers.view(date).sessions.reduce((sum, session) => sum + session.elapsed_seconds!, 0), 60);
    f.days.actual(date, { ...f.base(), block_id: 'b', minutes: 1429, source: '独立核对的其他累计' });
    const before = f.days.getState(date), sessionCount = f.timers.view(date).sessions.length;
    assert.throws(() => f.timers.period(date, { ...f.period('10:00:00', '10:01:00', 'b'), acknowledgeUntrackedActual: true }), /1440/u);
    assert.deepEqual(f.days.getState(date), before); assert.equal(f.timers.view(date).sessions.length, sessionCount);
  } finally { f.close(); }
});

test('统计仅累加权威已记录分钟，未知不充零，未来不计，正投入日与时间点分开累计', () => {
  const f = fixture(); try {
    f.timers.period(date, f.period('09:00:00', '09:10:00'));
    const prior = '2026-09-19'; f.plan(prior); f.days.actual(prior, { ...f.base(prior), block_id: 'a', minutes: 0, source: '明确没有投入' });
    f.timers.point('2026-09-18', { ...f.base('2026-09-18'), label: '只留一个时间点', occurred_at: '2026-09-18T12:00:00+08:00' });
    const future = '2099-01-01'; f.plan(future); f.days.actual(future, { ...f.base(future), block_id: 'a', minutes: 999, source: '隔离未来异常样本' });
    const view = f.timers.view(date); assert.equal(view.summary.todayMinutes, 10); assert.equal(view.summary.weekMinutes, 10); assert.equal(view.summary.totalMinutes, 10);
    assert.equal(view.summary.timeDays, 1); assert.equal(view.summary.pointCount, 1);
    assert.equal(view.summary.week.find(day => day.date === prior)!.minutes, 0);
    assert.equal(view.summary.week.find(day => day.date === '2026-09-18')!.minutes, null);
    const futureView = f.timers.view(future); assert.equal(futureView.summary.todayMinutes, null); assert.equal(futureView.summary.totalMinutes, 10);
  } finally { f.close(); }
});

test('时间点和精确时间段经重启及完整备份恢复保持一致；schema7升级不改已有账本', () => {
  const f = fixture(); try {
    f.timers.point(date, { ...f.base(), label: '提交第一稿', occurred_at: at('08:00:00') }); f.timers.period(date, f.period('09:00:00', '09:25:00'));
    f.timers.point(date, { ...f.base(), label: '已撤销的时间点', occurred_at: at('08:05:00') });
    f.timers.deletePoint(date, { ...f.base(), point_id: f.timers.view(date).points.find(point => point.label === '已撤销的时间点')!.id });
    const original = f.timers.view(date), backups = new BackupStore(f.store, resolve(f.folder, 'backups')), restore = new RestoreStore(f.store, backups, () => false);
    const backup = backups.create(randomUUID()); assert.equal(backup.schemaVersion, SCHEMA_VERSION); assert.equal(backup.rowCounts.timer_points, 2);
    const exported = JSON.parse(readFileSync(resolve(backups.directory, backup.id, 'export.json'), 'utf8'));
    assert.ok(exported.tables.timer_points.some((point: { label: string; deleted_at: string | null }) => point.label === '已撤销的时间点' && point.deleted_at));
    f.timers.deletePoint(date, { ...f.base(), point_id: original.points[0].id });
    const preview = restore.preview(backup.id); restore.restore(randomUUID(), preview.token, '恢复本地账本'); assert.deepEqual(f.timers.view(date), original);
    f.store.close(); const reopened = new Store(f.dataDir); try { assert.deepEqual(new TimerStore(new DayStore(reopened)).view(date), original); } finally { reopened.close(); }
    // Build an authentic version 7 bundle by removing only later additive tables.
    const dir = resolve(backups.directory, backup.id), dbFile = resolve(dir, 'database.sqlite'), old = new DatabaseSync(dbFile);
    old.exec('DROP TABLE work_session_context; DROP TABLE day_schedule; DROP TABLE inbox_items; DROP TABLE timer_points; PRAGMA user_version=7;'); const before = old.prepare('SELECT * FROM daily_logs').all();
    const tableRows = Object.fromEntries(old.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => [String(row.name), old.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all()])); old.close();
    const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')) as BackupManifest;
    manifest.schemaVersion = 7; manifest.rowCounts = Object.fromEntries(Object.entries(tableRows).map(([name, rows]) => [name, rows.length]));
    writeFileSync(resolve(dir, 'export.json'), JSON.stringify({ format: 'personal-company-export-v1', schemaVersion: 7, createdAt: manifest.createdAt, excluded: manifest.excluded, tables: tableRows }));
    for (const name of ['database.sqlite', 'export.json'] as const) { const bytes = readFileSync(resolve(dir, name)); manifest.files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
    writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest));
    const current = new Store(f.dataDir); try {
      const restoredOld = new RestoreStore(current, new BackupStore(current, backups.directory), () => false);
      const oldPreview = restoredOld.preview(backup.id); assert.ok(oldPreview.warnings.some(message => message.includes('旧备份没有钟表时间点')));
      restoredOld.restore(randomUUID(), oldPreview.token, '恢复本地账本'); assert.deepEqual(current.database.prepare('SELECT * FROM daily_logs').all(), before);
      const upgraded = new TimerStore(new DayStore(current)).view(date); assert.equal(upgraded.points.length, 0); assert.deepEqual(upgraded.sessions, original.sessions); assert.equal(upgraded.summary.todayMinutes, 25);
    } finally { current.close(); }
    const memory = new DatabaseSync(':memory:'); try { migrate(memory, 7); const originalSchema = memory.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(); migrate(memory); assert.equal(memory.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION); assert.deepEqual(memory.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND tbl_name NOT IN ('timer_points','day_schedule','inbox_items','work_session_context') ORDER BY name").all(), originalSchema); } finally { memory.close(); }
  } finally { f.close(); }
});

test('新钟表 HTTP 接口保留 CSRF、严格写入校验和乐观版本保护', async () => {
  mkdirSync(ROOT, { recursive: true }); const folder = mkdtempSync(resolve(ROOT, 'clock-http-')), app = createApp({ dataDir: resolve(folder, 'data') });
  try {
    const { url } = await app.listen(), token = (await (await testFetch(`${url}/api/session`)).json()).csrfToken as string;
    const post = async (path: string, body: unknown, csrf = token) => { const response = await testFetch(url + path, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
    await post('/api/setup', { requestId: randomUUID(), timezone: 'Asia/Shanghai', availableMinutes: 180 });
    const body = { requestId: randomUUID(), revision: 0, label: '一个时间点', occurred_at: at('08:00:00') };
    assert.equal((await post(`/api/days/${date}/timer/point`, body, 'invalid')).status, 403);
    const saved = await post(`/api/days/${date}/timer/point`, body); assert.equal(saved.status, 200); assert.equal(saved.body.log.revision, 1);
    assert.equal((await post(`/api/days/${date}/timer/point`, { ...body, requestId: randomUUID() })).status, 409);
    const view = await (await testFetch(`${url}/api/days/${date}/timer`)).json(); assert.equal(view.points.length, 1); assert.equal(view.summary.todayMinutes, null);
    assert.equal((await post(`/api/days/${date}/timer/point-delete`, { requestId: randomUUID(), revision: 1, point_id: view.points[0].id })).status, 200);
    assert.throws(() => timerPointWrite({ ...body, unknown: true }));
    assert.throws(() => timerPeriodWrite({ requestId: randomUUID(), revision: 0, block_id: 'a', started_at: at('08:00:00'), stopped_at: at('08:01:00'), acknowledgeUntrackedActual: 'yes' }));
  } finally { await app.close(); assert.equal(resolve(folder, '..'), ROOT); rmSync(folder, { recursive: true, force: true }); }
});

import { testFetch } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp, PROJECT_ROOT } from '../server/app.ts';
import type { DayState } from '../shared/day-contracts.ts';
import type { DashboardView, BackupManifest } from '../shared/dashboard-contracts.ts';

async function fixture() {
  const root = resolve(PROJECT_ROOT, '.runtime/tests'); mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(resolve(root, 'day06-')); const dataDir = resolve(folder, 'data');
  const app = createApp({ dataDir }); const { url } = await app.listen();
  const token = (await (await testFetch(url + '/api/session')).json()).csrfToken;
  async function call(path: string, method = 'GET', body?: object) {
    const response = await testFetch(url + path, { method, headers: { Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': token }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  }
  await call('/api/setup', 'POST', { requestId: randomUUID(), timezone: 'Asia/Shanghai', availableMinutes: null });
  const day = (date: string): Promise<DayState> => call(`/api/days/${date}`);
  const write = async (date: string, path: string, body: object, method = 'POST'): Promise<DayState> => call(`/api/days/${date}${path}`, method, { requestId: randomUUID(), revision: (await day(date)).log?.revision ?? 0, ...body });
  return { app, folder, dataDir, url, call, day, write, dashboard: (date: string): Promise<DashboardView> => call(`/api/dashboard/${date}`) };
}

test('七天概览保持未知、日期边界、休息、权重口径；读取不生成日记录', async () => {
  const f = await fixture();
  try {
    let view = await f.dashboard('2026-03-02'); assert.equal(view.start, '2026-02-24');
    assert.equal(view.days.length, 7); assert.equal(view.actualMinutes, null); assert.deepEqual(view.totals, []);
    assert.ok(view.days.every(day => !day.recorded && day.score.final_score === null));
    assert.equal((await f.day('2026-03-02')).log, null);
    assert.equal((await testFetch(f.url + '/api/dashboard/2026-02-30')).status, 400);
    const date = '2026-03-01'; const draft = (await f.day(date)).suggested_draft; draft.available_minutes = 135;
    draft.tasks = draft.tasks.map(task => ({ ...task, acceptance: '隔离测试验收', result_type: 'binary', metric_key: null, target_value: 1 }));
    const state = await f.write(date, '/confirm', { draft, acknowledgeOverCapacity: false });
    const shared = state.log!.plan_snapshots[0].work_blocks.find(block => block.title.includes('测试连载平台'))!;
    assert.ok(shared); await f.write(date, '/actuals', { block_id: shared.id, minutes: 15, source: '测试共用时段' }, 'PUT');
    view = await f.dashboard('2026-03-02'); const yesterday = view.days[5];
    assert.equal(yesterday.budgetMinutes, 135); assert.equal(yesterday.actualMinutes, 15); assert.equal(yesterday.missingBlocks, 4);
    assert.equal(yesterday.score.final_score, null); assert.equal(yesterday.score.upper_bound, 10000); assert.deepEqual(yesterday.dimensions, ['cashflow', 'asset']);
    for (const task of state.tasks) await f.write(date, `/tasks/${task.task_id}/result`, { clear: false, binary_value: 0, explanation: '明确未达成' });
    await f.write(date, '/settle', {}); view = await f.dashboard('2026-03-02');
    assert.equal(view.days[5].score.final_score, 0); assert.equal(view.days[5].confirmedTasks, 6); assert.equal(view.days[5].achievedTasks, 0);
    const rest = (await f.day('2026-03-02')).suggested_draft; rest.day_mode = 'rest'; rest.tasks = []; rest.work_blocks = [];
    for (const dimension of Object.values(rest.dimensions)) { dimension.applicable = false; dimension.reason = '休息'; }
    await f.write('2026-03-02', '/confirm', { draft: rest, acknowledgeOverCapacity: false }); await f.write('2026-03-02', '/settle', {});
    view = await f.dashboard('2026-03-02'); assert.equal(view.days[6].score.final_score, null); assert.equal(view.days[6].mode, 'rest'); assert.equal(view.settledDays, 2);
    await f.write(date, '/actuals', { block_id: shared.id, minutes: 0, source: '确认零分钟' }, 'PUT');
    view = await f.dashboard('2026-03-02'); assert.equal(view.actualMinutes, 0); assert.equal(view.days[5].score.final_score, null); assert.equal(view.settledDays, 1);
  } finally { await f.app.close(); }
});

test('成果趋势只计有效更正，区分交付阶段和单位，大整数汇总不失真', async () => {
  const f = await fixture(); const date = '2026-09-19';
  try {
    const project_id = (await f.call('/api/state')).projects[0].id;
    const event = { project_id, task_id: null, artifact_key: 'one', metric_key: 'accepted_words', value: 100, stage: 'finalized', summary: '测试成果', source: '隔离测试' };
    let state = await f.write(date, '/events', { event });
    state = await f.write(date, `/events/${state.events[0].id}/correct`, { kind: 'replace', value: 50, stage: 'finalized', summary: '更正', source: '隔离测试', reason: '核对数量' });
    let view = await f.dashboard(date); assert.equal(view.totals[0].value, '50'); assert.equal(view.totals[0].records, 1);
    await f.write(date, `/events/${state.effective_events[0].id}/correct`, { kind: 'void', value: null, stage: 'finalized', summary: '撤销', source: '隔离测试', reason: '不是有效成果' });
    assert.deepEqual((await f.dashboard(date)).totals, []);
    for (const artifact_key of ['large1', 'large2']) await f.write(date, '/events', { event: { ...event, artifact_key, value: Number.MAX_SAFE_INTEGER } });
    await f.write(date, '/events', { event: { ...event, artifact_key: 'published', metric_key: 'published_chapters', value: 2, stage: 'published' } });
    await f.write('2026-09-12', '/events', { event: { ...event, artifact_key: 'outside', value: 123 } });
    view = await f.dashboard(date); assert.equal(view.totals.length, 2); assert.equal(view.totals.find(row => row.metric === 'accepted_words')!.value, '18014398509481982'); assert.equal(view.totals.find(row => row.stage === 'published')!.value, '2');
    assert.equal(view.projects.find(project => project.id === project_id)!.eventDays, 1);
  } finally { await f.app.close(); }
});

test('概览完成数直接读取完成标志，未知数量和真实成果不随完成标志改变', async () => {
  const f = await fixture(), date = '2026-09-19';
  try {
    const draft = (await f.day(date)).suggested_draft;
    draft.available_minutes = 135;
    draft.tasks = draft.tasks.map(task => ({ ...task, acceptance: '隔离测试完成标准', result_type: 'binary', metric_key: null, target_value: 1 }));
    draft.tasks[0] = { ...draft.tasks[0], result_type: 'quant', metric_key: 'accepted_words', target_value: 100 };
    let state = await f.write(date, '/confirm', { draft, acknowledgeOverCapacity: false });
    const task = state.tasks[0];
    state = await f.write(date, `/tasks/${task.task_id}/status`, { status: 'done' });
    const snapshot = structuredClone(state);
    let view = await f.dashboard(date), current = view.days[6];
    assert.equal(current.completedTasks, 1);
    assert.equal(current.confirmedTasks, 0);
    assert.equal(current.achievedTasks, 0);
    assert.equal(current.actualMinutes, null);
    assert.deepEqual(view.totals, []);
    assert.equal(current.score.final_score, null);
    assert.equal(current.score.tasks.find(item => item.task_id === task.task_id)!.actual, null);
    assert.deepEqual(await f.day(date), snapshot);

    await f.write(date, '/events', { event: { project_id: task.project_id, task_id: task.task_id, artifact_key: 'real-quantity', metric_key: 'accepted_words', value: 40, stage: 'finalized', summary: '真实记录数量', source: '隔离测试' } });
    await f.write(date, `/tasks/${task.task_id}/result`, { clear: false, binary_value: null, explanation: '数量独立记录' });
    view = await f.dashboard(date); current = view.days[6];
    assert.equal(current.completedTasks, 1);
    assert.equal(current.confirmedTasks, 1);
    assert.equal(current.achievedTasks, 0);
    assert.deepEqual(view.totals, [{ metric: 'accepted_words', stage: 'finalized', value: '40', records: 1 }]);
    await f.write(date, `/tasks/${task.task_id}/status`, { status: 'todo' });
    view = await f.dashboard(date);
    assert.equal(view.days[6].completedTasks, 0);
    assert.equal(view.days[6].confirmedTasks, 1);
    assert.equal(view.totals[0].value, '40');
  } finally { await f.app.close(); }
});

test('备份包含 WAL 提交和全部表，JSON 与 SQLite 一致，排除密钥，幂等并拒绝损坏下载', async () => {
  const f = await fixture();
  try {
    mkdirSync(resolve(f.dataDir, 'secrets'), { recursive: true }); writeFileSync(resolve(f.dataDir, 'secrets', 'openai-key.dpapi'), 'SECRET-SENTINEL');
    const date = '2026-09-19'; const draft = (await f.day(date)).suggested_draft;
    await f.write(date, '/draft', { draft }, 'PUT');
    const id = randomUUID(); const first: BackupManifest = await f.call('/api/backups', 'POST', { requestId: id });
    const backupDir = resolve(f.folder, 'backups/data', id); assert.deepEqual(readdirSync(backupDir).sort(), ['database.sqlite', 'export.json', 'manifest.json']);
    assert.deepEqual(await f.call('/api/backups', 'POST', { requestId: id }), first);
    assert.equal((await f.call('/api/backups')).backups.length, 1);
    const exported = JSON.parse(readFileSync(resolve(backupDir, 'export.json'), 'utf8')); assert.equal(Object.keys(exported.tables).length, 23);
    assert.equal(exported.tables.daily_logs.length, 1); assert.ok(!JSON.stringify(exported).includes('SECRET-SENTINEL'));
    const backup = new DatabaseSync(resolve(backupDir, 'database.sqlite'), { readOnly: true });
    const live = new DatabaseSync(resolve(f.dataDir, 'personal-company.sqlite'), { readOnly: true });
    try {
      for (const name of Object.keys(exported.tables)) {
        const rows = backup.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
        assert.deepEqual(rows, live.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all());
        assert.deepEqual(JSON.parse(JSON.stringify(rows)), exported.tables[name]);
      }
      assert.equal(backup.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok'); assert.deepEqual(backup.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { live.close(); backup.close(); }
    await f.write(date, '/draft', { draft: { ...draft, notes: '备份之后的修改' } }, 'PUT');
    assert.deepEqual(await f.call('/api/backups', 'POST', { requestId: id }), first);
    for (const name of ['database.sqlite', 'export.json'] as const) {
      const response = await testFetch(`${f.url}/api/backups/${id}/${name}`); assert.equal(response.status, 200); assert.ok(response.headers.get('content-disposition')!.includes('attachment'));
      assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), first.files[name].sha256);
    }
    assert.equal((await testFetch(`${f.url}/api/backups/${id}/secrets`)).status, 404);
    assert.equal((await testFetch(`${f.url}/api/backups/invalid/export.json`)).status, 400);
    assert.equal((await testFetch(f.url + '/api/backups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID() }) })).status, 403);
    writeFileSync(resolve(backupDir, 'export.json'), '{}');
    assert.equal((await f.call('/api/backups')).unreadable, 1); assert.equal((await testFetch(`${f.url}/api/backups/${id}/database.sqlite`)).status, 409);
  } finally { await f.app.close(); }
});

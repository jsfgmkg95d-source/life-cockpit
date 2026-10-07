import { setUnequalTestWeights, testFetch } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp, PROJECT_ROOT } from '../server/app.ts';
import type { AppState, Project } from '../shared/contracts.ts';
import type { DayState } from '../shared/day-contracts.ts';
import type { BackupManifest, DashboardView } from '../shared/dashboard-contracts.ts';
import type { ReportView } from '../shared/report-contracts.ts';
import type { ScoreView } from '../shared/score-contracts.ts';

const root = resolve(PROJECT_ROOT, '.runtime/tests');
const date = '2026-09-19';
const tomorrow = '2026-09-20';
const businessTables = ['projects', 'app_settings', 'request_dedup', 'daily_logs', 'tasks', 'asset_events', 'score_policies', 'scores', 'ai_settings', 'reports', 'report_adoptions', 'ai_calls'] as const;

function businessRows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    return Object.fromEntries(businessTables.map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
  } finally { db.close(); }
}

async function fixture() {
  mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(resolve(root, 'restore-e2e-'));
  const dataDir = resolve(folder, 'data');
  mkdirSync(resolve(dataDir, 'secrets'), { recursive: true });
  const secretFile = resolve(dataDir, 'secrets/openai-key.dpapi');
  const sentinel = Buffer.from('ISOLATED-KEY-FILE-MUST-SURVIVE-RESTORE');
  writeFileSync(secretFile, sentinel);
  let app = createApp({ dataDir });
  let { url } = await app.listen();
  let token = '';
  async function session() { token = (await (await testFetch(url + '/api/session')).json()).csrfToken; return token; }
  await session();
  async function request(path: string, method = 'GET', body?: unknown, csrf = token) {
    const response = await testFetch(url + path, {
      method,
      headers: { Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function call<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const result = await request(path, method, body);
    assert.ok(result.status >= 200 && result.status < 300, `${method} ${path}: ${JSON.stringify(result)}`);
    return result.body;
  }
  await call('/api/setup', 'POST', { requestId: randomUUID(), timezone: 'Asia/Shanghai', availableMinutes: 135 });
  const day = (value = date): Promise<DayState> => call(`/api/days/${value}`);
  const write = async (value: string, path: string, body: object, method = 'POST') => call(`/api/days/${value}${path}`, method, { requestId: randomUUID(), revision: (await day(value)).log?.revision ?? 0, ...body });
  async function editProject(id: string, patch: Partial<Project>) {
    const current = (await call<{ project: Project }>(`/api/projects/${id}`)).project;
    const { id: _id, revision, created_at: _created, updated_at: _updated, ...project } = current;
    return call(`/api/projects/${id}`, 'PUT', { revision, project: { ...project, ...patch } });
  }
  async function snapshot() {
    return {
      app: await call<AppState>('/api/state'),
      today: await day(), tomorrow: await day(tomorrow),
      score: await call<ScoreView>(`/api/days/${date}/scores`),
      dashboard: await call<DashboardView>(`/api/dashboard/${date}`),
      report: await call<ReportView>(`/api/days/${date}/reports/review`),
    };
  }
  return {
    folder, dataDir, secretFile, sentinel, call, request, day, write, editProject, snapshot, session,
    backupFile: (id: string, name = 'database.sqlite') => resolve(folder, 'backups/data', id, name),
    liveRows: () => businessRows(resolve(dataDir, 'personal-company.sqlite')),
    async restart() { await app.close(); app = createApp({ dataDir }); ({ url } = await app.listen()); await session(); },
    async close() { await app.close(); assert.equal(dirname(folder), root); rmSync(folder, { recursive: true, force: true }); },
  };
}

test('完整经营闭环恢复后计划、成果、分数、报告与次日采纳一致；覆盖前备份和恢复回执可追溯', async () => {
  const f = await fixture();
  try {
    const initial = await f.call<AppState>('/api/state');
    assert.equal(initial.projects.length, 6);
    const wedding = initial.projects.find(project => project.name === '示例长篇甲')!;
    const three = initial.projects.find(project => project.name === '示例连载乙')!;
    const draft = setUnequalTestWeights((await f.day()).suggested_draft);
    assert.equal(draft.tasks.length, 6);
    assert.equal(draft.work_blocks.length, 5);
    assert.equal(draft.work_blocks.reduce((total, block) => total + (block.budget_minutes ?? 0), 0), 135);
    draft.tasks = draft.tasks.map(task => ({
      ...task, acceptance: '隔离演练：指定成果及来源已核对',
      result_type: task.project_id === wedding.id ? 'quant' : 'binary',
      metric_key: task.project_id === wedding.id ? 'accepted_words' : null,
      target_value: task.project_id === wedding.id ? 1000 : 1,
    }));
    const confirmed: DayState = await f.write(date, '/confirm', { draft, acknowledgeOverCapacity: false });
    const task = confirmed.tasks.find(item => item.project_id === wedding.id)!;
    const event = { project_id: wedding.id, task_id: task.task_id, artifact_key: 'isolated-wedding-chapter', metric_key: 'accepted_words', value: 1000, stage: 'finalized', summary: '隔离演练正文，不代表真实创作', source: '隔离测试验收' };
    const recorded: DayState = await f.write(date, '/events', { event });
    const originalEvent = recorded.effective_events[0];
    const shared = confirmed.log!.plan_snapshots[0].work_blocks.find(block => block.title.includes('测试连载平台'))!;
    assert.equal(confirmed.tasks.filter(item => item.work_block_id === shared.id).length, 2);
    await f.write(date, '/actuals', { block_id: shared.id, minutes: 15, source: '隔离演练共享时段' }, 'PUT');
    for (const item of confirmed.tasks) await f.write(date, `/tasks/${item.task_id}/result`, { clear: false, binary_value: item.result_type === 'quant' ? null : 1, explanation: '隔离演练验收确认' });
    await f.write(date, '/settle', {});
    let score = await f.call<ScoreView>(`/api/days/${date}/scores`);
    assert.equal(score.preview.final_score, 10000);
    assert.equal(score.preview.display.final, '100');
    const beforeReport = await f.call<ReportView>(`/api/days/${date}/reports/review`);
    await f.call(`/api/days/${date}/reports/review`, 'POST', { requestId: randomUUID(), revision: beforeReport.revision, input_hash: beforeReport.input_hash, force: false });
    let reportView: ReportView | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      reportView = await f.call<ReportView>(`/api/days/${date}/reports/review`);
      if (reportView.reports[0]?.status !== 'running') break;
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    const report = reportView!.reports[0];
    assert.equal(report.status, 'degraded');
    assert.equal(report.run_meta.fallback_reason, 'LOCAL_MODE');
    assert.equal(report.score_id, score.current_score_id);
    assert.equal(report.content!.suggestions.length, 1);
    const suggestionIndex = 0;
    await f.call(`/api/reports/${report.id}/adopt`, 'POST', { requestId: randomUUID(), target_date: tomorrow, target_revision: 0, suggestion_index: suggestionIndex, action: '隔离演练：核对复盘建议对应项目成果', acceptance: '指定测试成果逐项核对完成', estimated_minutes: null, dimension: 'cashflow', change_reason: '' });

    const expected = await f.snapshot();
    assert.equal(expected.tomorrow.log!.current_plan_version, 0);
    assert.equal(expected.tomorrow.tasks.length, 0);
    assert.equal(expected.tomorrow.log!.draft_plan!.tasks.length, 1);
    assert.equal(expected.tomorrow.log!.draft_plan!.tasks[0].raw_points, 0);
    assert.equal(expected.report.adoptions.length, 1);
    assert.equal(expected.dashboard.actualMinutes, 15);
    assert.equal(expected.dashboard.days.at(-1)!.budgetMinutes, 135);
    assert.equal(expected.dashboard.totals.find(total => total.metric === 'accepted_words')!.value, '1000');
    const savedRows = f.liveRows();
    const backup = await f.call<BackupManifest>('/api/backups', 'POST', { requestId: randomUUID() });
    assert.deepEqual(businessRows(f.backupFile(backup.id)), savedRows);

    await f.write(date, `/events/${originalEvent.id}/correct`, { kind: 'replace', value: 400, stage: 'finalized', summary: '隔离演练数量更正', source: '隔离测试复核', reason: '演练恢复前的数据变化' });
    await f.write(date, '/events', { event: { ...event, task_id: null, artifact_key: 'isolated-published-chapter', metric_key: 'published_chapters', value: 1, stage: 'published' } });
    await f.write(date, `/tasks/${task.task_id}/result`, { clear: false, binary_value: null, explanation: '演练更正后重新验收' });
    await f.write(date, '/settle', {});
    score = await f.call<ScoreView>(`/api/days/${date}/scores`);
    assert.equal(score.preview.final_score, 7750);
    await f.editProject(wedding.id, { next_action: '隔离演练：备份后的新安排' });
    await f.write(tomorrow, '/draft', { draft: { ...(await f.day(tomorrow)).log!.draft_plan!, notes: '隔离演练：备份后的草稿修改' } }, 'PUT');
    const beforeRestore = await f.snapshot();
    assert.equal(beforeRestore.report.reports[0].stale, true);
    assert.notDeepEqual(beforeRestore, expected);
    const preservationRows = f.liveRows();
    const preview = await f.call('/api/restores/preview', 'POST', { backupId: backup.id });
    assert.equal(preview.backup.id, backup.id);
    assert.ok(Date.parse(preview.expiresAt) > Date.now());
    assert.match(preview.currentHash, /^[0-9a-f]{64}$/u);
    assert.ok(Array.isArray(preview.warnings));
    for (const table of businessTables) {
      assert.equal(preview.incomingCounts[table], savedRows[table].length, table);
      assert.equal(preview.currentCounts[table], preservationRows[table].length, table);
    }
    const oldToken = await f.session();
    const restore = { requestId: randomUUID(), token: preview.token, confirmation: '恢复本地账本' };
    const receipt = await f.call('/api/restores', 'POST', restore);
    assert.equal(receipt.requestId, restore.requestId);
    assert.equal(receipt.backupId, backup.id);
    assert.notEqual(receipt.preservationBackupId, backup.id);
    assert.equal(receipt.sourceSha256, backup.files['database.sqlite'].sha256);
    assert.ok(Number.isFinite(Date.parse(receipt.restoredAt)));
    assert.deepEqual(businessRows(f.backupFile(receipt.preservationBackupId)), preservationRows);
    assert.deepEqual(f.liveRows(), savedRows);
    assert.deepEqual(readFileSync(f.secretFile), f.sentinel);
    assert.equal((await f.request('/api/backups', 'POST', { requestId: randomUUID() }, oldToken)).status, 403);
    assert.notEqual(await f.session(), oldToken);
    assert.deepEqual(await f.snapshot(), expected);
    assert.deepEqual(await f.call(`/api/restores/${restore.requestId}`), receipt);

    // A lost HTTP response must not turn a retry into a second destructive restore.
    await f.editProject(wedding.id, { notes: '隔离演练：恢复后应保留的新编辑' });
    const afterNewEdit = f.liveRows();
    assert.deepEqual(await f.call('/api/restores', 'POST', restore), receipt);
    assert.deepEqual(f.liveRows(), afterNewEdit);
    await f.restart();
    assert.deepEqual(await f.call(`/api/restores/${restore.requestId}`), receipt);
    assert.deepEqual(await f.call('/api/restores', 'POST', restore), receipt);
    assert.deepEqual(f.liveRows(), afterNewEdit);
    assert.deepEqual(readFileSync(f.secretFile), f.sentinel);
    assert.equal((await f.request(`/api/restores/${randomUUID()}`)).status, 404);
  } finally { await f.close(); }
});

test('恢复须明确确认且预览不能覆盖其后新写入；校验失败的备份不能恢复', async () => {
  const f = await fixture();
  try {
    const original = await f.call<AppState>('/api/state');
    const backup = await f.call<BackupManifest>('/api/backups', 'POST', { requestId: randomUUID() });
    const preview = await f.call('/api/restores/preview', 'POST', { backupId: backup.id });
    const before = f.liveRows();
    assert.equal((await f.request('/api/restores', 'POST', { requestId: randomUUID(), token: preview.token })).status, 400);
    assert.deepEqual(f.liveRows(), before);
    await f.editProject(original.projects[0].id, { notes: '隔离演练：预览之后的编辑不可丢失' });
    const changed = f.liveRows();
    assert.equal((await f.request('/api/restores', 'POST', { requestId: randomUUID(), token: preview.token, confirmation: '恢复本地账本' })).status, 409);
    assert.deepEqual(f.liveRows(), changed);
    assert.deepEqual(readFileSync(f.secretFile), f.sentinel);

    // Change a bundle only after preview to exercise the final pre-restore check too.
    const fresh = await f.call('/api/restores/preview', 'POST', { backupId: backup.id });
    const file = f.backupFile(backup.id, 'export.json');
    const originalExport = readFileSync(file);
    writeFileSync(file, '{}');
    assert.equal((await f.request('/api/restores', 'POST', { requestId: randomUUID(), token: fresh.token, confirmation: '恢复本地账本' })).status, 409);
    assert.equal((await f.request('/api/restores/preview', 'POST', { backupId: backup.id })).status, 409);
    assert.deepEqual(f.liveRows(), changed);
    writeFileSync(file, originalExport);
    assert.equal((await f.request('/api/restores/preview', 'POST', { backupId: backup.id })).status, 200);
    assert.deepEqual(f.liveRows(), changed);
  } finally { await f.close(); }
});

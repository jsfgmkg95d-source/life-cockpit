import { testFetch } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppState, Project, ProjectInput } from '../shared/contracts.ts';
import { createApp, PROJECT_ROOT, WORKSPACE_ID } from '../server/app.ts';
import { SCHEMA_VERSION } from '../server/migrations.ts';

const TEST_ROOT = resolve(PROJECT_ROOT, '.runtime', 'tests');

function input(overrides: Partial<ProjectInput> = {}): ProjectInput {
  return {
    name: '后端验证项目', project_type: 'novel', platform: null, operating_role: 'future_asset',
    stage: '待确认', status: 'preparing', primary_metric_key: null,
    baseline_value: null, baseline_at: null, baseline_source: null,
    target_value: null, target_date: null, next_milestone: null, next_action: null,
    daily_budget_minutes: null, cadence: { days_per_week: null }, notes: '', ...overrides,
  };
}

async function fixture() {
  await mkdir(TEST_ROOT, { recursive: true });
  const folder = await mkdtemp(resolve(TEST_ROOT, 'backend-'));
  const dataDir = resolve(folder, 'data');
  const distDir = resolve(folder, 'dist');
  await mkdir(distDir);
  await writeFile(resolve(distDir, 'index.html'), '<!doctype html><title>local test</title>');
  await writeFile(resolve(distDir, 'style.css'), 'body{color:black}');
  let app = createApp({ dataDir, distDir, port: 0 });
  let address = await app.listen();
  let csrfToken = (await (await testFetch(`${address.url}/api/session`)).json() as { csrfToken: string }).csrfToken;
  return {
    get app() { return app; },
    get url() { return address.url; },
    get token() { return csrfToken; },
    folder, dataDir,
    async call(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
      const response = await testFetch(`${address.url}${path}`, {
        method, headers: { Origin: address.url, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, ...extraHeaders },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    async reopen() {
      await app.close();
      app = createApp({ dataDir, distDir, port: 0 });
      address = await app.listen();
      csrfToken = (await (await testFetch(`${address.url}/api/session`)).json() as { csrfToken: string }).csrfToken;
    },
    async cleanup() {
      await app.close();
      assert.equal(dirname(folder), TEST_ROOT);
      await rm(folder, { recursive: true, force: true });
    },
  };
}

async function rawGet(url: string, path: string, host?: string): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest({ hostname: target.hostname, port: target.port, path, method: 'GET', headers: host ? { Host: host } : {} }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolveResponse({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('初始化只创建六项目一次，共享十五分钟不重复，未知保持空值并跨重启保留', async () => {
  const f = await fixture();
  try {
    const initial = await f.call('GET', '/api/state');
    assert.equal(initial.body.setupCompleted, false);
    assert.deepEqual(initial.body.projects, []);
    const payload = { requestId: randomUUID(), timezone: 'Asia/Shanghai', availableMinutes: null };
    const setup = await f.call('POST', '/api/setup', payload);
    assert.equal(setup.status, 200);
    const state = setup.body as AppState;
    assert.equal(state.setupCompleted, true);
    assert.equal(state.projects.length, 6);
    assert.equal(state.settings.available_minutes, null);
    assert.equal(state.projects.reduce((sum, project) => sum + (project.daily_budget_minutes ?? 0), 0) + state.settings.shared_budget_groups[0].budget_minutes, 135);
    for (const project of state.projects) {
      assert.equal(project.status, 'preparing'); assert.equal(project.stage, '待确认');
      assert.equal(project.primary_metric_key, null); assert.equal(project.baseline_value, null); assert.equal(project.target_value, null);
    }
    assert.deepEqual(state.projects.filter((project) => project.platform === '测试连载平台').map((project) => project.daily_budget_minutes), [null, null]);
    assert.equal((await f.call('POST', '/api/setup', payload)).status, 200);
    assert.equal((await f.call('POST', '/api/setup', { ...payload, requestId: randomUUID() })).status, 409);
    assert.equal((await f.call('POST', '/api/setup', { ...payload, availableMinutes: 300 })).status, 409);
    await f.reopen();
    assert.deepEqual((await f.call('GET', '/api/state')).body, state);
    const database = new DatabaseSync(resolve(f.dataDir, 'personal-company.sqlite'), { readOnly: true });
    try {
      assert.equal(database.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION);
      assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name), ['ai_calls', 'ai_settings', 'app_settings', 'asset_chapters', 'asset_events', 'asset_evidence', 'connector_states', 'daily_fortune_records', 'daily_logs', 'day_schedule', 'inbox_items', 'projects', 'report_adoptions', 'reports', 'request_dedup', 'restore_receipts', 'score_policies', 'scores', 'task_pins', 'tasks', 'timer_points', 'work_session_context', 'work_sessions']);
    } finally { database.close(); }
  } finally { await f.cleanup(); }
});

test('项目新增幂等，修改/归档/恢复使用版本，保留基线零与未知的区别', async () => {
  const f = await fixture();
  try {
    const payload = { requestId: randomUUID(), project: input() };
    const first = await f.call('POST', '/api/projects', payload);
    assert.equal(first.status, 201);
    const original = first.body.project as Project;
    assert.equal(original.baseline_value, null);
    assert.deepEqual((await f.call('POST', '/api/projects', payload)).body, first.body);
    assert.equal((await f.call('POST', '/api/projects', { ...payload, project: input({ name: '不同内容' }) })).status, 409);
    const change = input({ name: '已编辑项目', platform: '自有平台', primary_metric_key: 'accepted_words', baseline_value: 0, baseline_at: '2026-09-17', baseline_source: '用户确认', target_value: 100000, status: 'active' });
    const updated = await f.call('PUT', `/api/projects/${original.id}`, { revision: 1, project: change });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.project.revision, 2);
    assert.equal(updated.body.project.baseline_value, 0);
    assert.equal((await f.call('PUT', `/api/projects/${original.id}`, { revision: 1, project: change })).status, 409);
    const archived = await f.call('PUT', `/api/projects/${original.id}`, { revision: 2, project: { ...change, status: 'archived' } });
    assert.equal(archived.body.project.status, 'archived');
    const restored = await f.call('PUT', `/api/projects/${original.id}`, { revision: 3, project: { ...change, status: 'paused' } });
    assert.equal(restored.body.project.status, 'paused');
    assert.equal((await f.call('DELETE', `/api/projects/${original.id}`, {})).status, 405);
    await f.reopen();
    assert.deepEqual((await f.call('GET', `/api/projects/${original.id}`)).body, restored.body);
    assert.equal((await f.call('POST', '/api/projects', payload)).body.project.id, original.id);
    assert.equal((await f.call('GET', '/api/state')).body.projects.length, 1);
    assert.equal((await f.call('POST', '/api/setup', { requestId: randomUUID(), timezone: 'Asia/Shanghai', availableMinutes: null })).status, 409);
    assert.equal((await f.call('GET', '/api/state')).body.projects.length, 1);
  } finally { await f.cleanup(); }
});

test('严格校验日期、数量、枚举、基线配套、额外字段，不产生部分写入', async () => {
  const f = await fixture();
  try {
    const invalidProjects: unknown[] = [
      input({ name: ' ' }), input({ target_value: 10 }), input({ primary_metric_key: 'accepted_words', baseline_value: 0 }),
      input({ primary_metric_key: 'accepted_words', baseline_value: 1, baseline_at: '2026-02-30', baseline_source: '记录' }),
      input({ daily_budget_minutes: -1 }), input({ daily_budget_minutes: 1441 }), input({ daily_budget_minutes: 0.5 }),
      input({ primary_metric_key: 'accepted_words', target_value: Number.MAX_SAFE_INTEGER + 1 }),
      input({ target_date: '2026-13-01' }), input({ cadence: { days_per_week: 8 } }),
      { ...input(), status: 'published' }, { ...input(), primary_metric_key: 'unknown_metric' },
      { ...input(), revision: 900 }, { ...input(), name: null },
    ];
    for (const project of invalidProjects) {
      const result = await f.call('POST', '/api/projects', { requestId: randomUUID(), project });
      assert.equal(result.status, 400, JSON.stringify(project));
    }
    assert.equal((await f.call('GET', '/api/state')).body.projects.length, 0);
    const emptyStage = await f.call('POST', '/api/projects', { requestId: randomUUID(), project: input({ stage: '' }) });
    assert.equal(emptyStage.body.project.stage, '待确认');
  } finally { await f.cleanup(); }
});

test('共享预算设置校验项目引用、重复和单项预算，设置保存有版本并持久化', async () => {
  const f = await fixture();
  try {
    const result = await f.call('POST', '/api/setup', { requestId: randomUUID(), timezone: 'Asia/Shanghai', availableMinutes: null });
    const state = result.body as AppState;
    const { revision, ...settings } = state.settings;
    const update = await f.call('PUT', '/api/settings', { revision, settings: { ...settings, available_minutes: 300 } });
    assert.equal(update.status, 200);
    assert.equal(update.body.settings.available_minutes, 300);
    assert.equal((await f.call('PUT', '/api/settings', { revision, settings })).status, 409);
    const group = settings.shared_budget_groups[0];
    const member = state.projects.find((project) => project.id === group.project_ids[0])!;
    const { id, revision: projectRevision, created_at, updated_at, ...memberInput } = member;
    assert.equal((await f.call('PUT', `/api/projects/${id}`, { revision: projectRevision, project: { ...memberInput, daily_budget_minutes: 15 } })).status, 409);
    const latestRevision = update.body.settings.revision;
    assert.equal((await f.call('PUT', '/api/settings', { revision: latestRevision, settings: { ...settings, timezone: 'not/a-timezone' } })).status, 400);
    assert.equal((await f.call('PUT', '/api/settings', { revision: latestRevision, settings: { ...settings, shared_budget_groups: [{ ...group, project_ids: [group.project_ids[0], 'missing'] }] } })).status, 400);
    assert.equal((await f.call('PUT', '/api/settings', { revision: latestRevision, settings: { ...settings, shared_budget_groups: [{ ...group, project_ids: [group.project_ids[0], group.project_ids[0]] }] } })).status, 400);
    assert.equal((await f.call('PUT', '/api/settings', { revision: latestRevision, settings: { ...settings, shared_budget_groups: [{ ...group, project_ids: [group.project_ids[0], state.projects[0].id] }] } })).status, 409);
    await f.reopen();
    assert.equal((await f.call('GET', '/api/state')).body.settings.available_minutes, 300);
  } finally { await f.cleanup(); }
});

test('仅监听loopback，拒绝外部Origin/非法Host/缺失CSRF，读取不泄漏数据文件', async () => {
  const f = await fixture();
  try {
    const address = f.app.server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '127.0.0.1');
    const health = await f.call('GET', '/api/health');
    assert.equal(health.body.workspaceId, WORKSPACE_ID); assert.equal(health.body.processId, process.pid);
    assert.equal((await f.call('GET', '/api/session', undefined, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await rawGet(f.url, '/api/session', 'attacker.example')).status, 403);
    const payload = { requestId: randomUUID(), project: input() };
    assert.equal((await f.call('POST', '/api/projects', payload, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await f.call('POST', '/api/projects', payload, { 'X-CSRF-Token': 'é'.repeat(64) })).status, 403);
    assert.equal((await f.call('POST', '/api/projects', payload, { Origin: 'http://attacker.example' })).status, 403);
    const noOrigin = await testFetch(`${f.url}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': f.token }, body: JSON.stringify(payload) });
    assert.equal(noOrigin.status, 403);
    assert.equal((await f.call('POST', '/api/projects', payload, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const invalidJson = await testFetch(`${f.url}/api/projects`, { method: 'POST', headers: { Origin: f.url, 'Content-Type': 'application/json', 'X-CSRF-Token': f.token }, body: '{' });
    assert.equal(invalidJson.status, 400);
    const oversized = await f.call('POST', '/api/projects', { requestId: randomUUID(), project: input({ notes: 'x'.repeat(70000) }) });
    assert.equal(oversized.status, 413);
    assert.equal((await f.call('GET', '/api/state')).body.projects.length, 0);
    assert.equal((await rawGet(f.url, '/%2e%2e/data/personal-company.sqlite')).status, 400);
    assert.equal((await rawGet(f.url, '/data/personal-company.sqlite')).status, 404);
    assert.equal((await rawGet(f.url, '/.env')).status, 400);
    assert.equal((await rawGet(f.url, '/style.css')).body, 'body{color:black}');
    assert.match((await rawGet(f.url, '/projects')).body, /local test/u);
    assert.equal(await readFile(resolve(f.folder, 'dist', 'index.html'), 'utf8'), '<!doctype html><title>local test</title>');
  } finally { await f.cleanup(); }
});

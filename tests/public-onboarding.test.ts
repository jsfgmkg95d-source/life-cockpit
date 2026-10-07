import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createApp, PROJECT_ROOT } from '../server/app.ts';

async function fixture() {
  const root = resolve(PROJECT_ROOT, '.runtime/tests'); mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(resolve(root, 'public-onboarding-'));
  const app = createApp({ dataDir: resolve(folder, 'data') }); const { url } = await app.listen();
  const { csrfToken } = await (await fetch(url + '/api/session')).json();
  async function call(path: string, method = 'GET', body?: unknown, token = csrfToken) {
    const response = await fetch(url + path, { method, headers: { Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  return { call, close: async () => { await app.close(); rmSync(folder, { recursive: true, force: true }); } };
}

test('ordinary first run starts empty, keeps unknown budgets, and retries idempotently', async () => {
  const f = await fixture();
  try {
    const body = { requestId: randomUUID(), timezone: 'UTC', availableMinutes: null, mode: 'blank' };
    const first = await f.call('/api/setup', 'POST', body);
    assert.equal(first.status, 200); assert.equal(first.body.setupCompleted, true);
    assert.deepEqual(first.body.projects, []); assert.deepEqual(first.body.settings.shared_budget_groups, []);
    assert.equal(first.body.settings.available_minutes, null);
    assert.deepEqual(await f.call('/api/setup', 'POST', body), first);
    assert.equal((await f.call('/api/setup', 'POST', { ...body, requestId: randomUUID() })).status, 409);
    assert.equal((await f.call('/api/github')).status, 404);
    assert.equal((await f.call('/api/days/2026-10-07/fortune')).status, 404);
  } finally { await f.close(); }
});

test('sample tasks and completion stay in their own ledger and use the main CSRF boundary', async () => {
  const f = await fixture();
  try {
    const before = await f.call('/api/state');
    assert.equal((await f.call('/api/setup', 'POST', { requestId: randomUUID(), timezone: 'UTC', availableMinutes: null, mode: 'demo' })).status, 400);
    const example = await f.call('/api/demo/state');
    assert.equal(example.status, 200); assert.equal(example.body.projects.length, 3);
    assert.deepEqual(example.body.projects.map((p: any) => p.name), ['写一篇文章', '学习一个主题', '推进一个产品']);
    assert.ok(example.body.projects.every((p: any) => p.notes.includes('合成示例')));
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const day = await f.call(`/api/demo/days/${date}`);
    assert.equal(day.status, 200); assert.equal(day.body.tasks.length, 3);
    const task = day.body.tasks[0];
    const body = { requestId: randomUUID(), revision: day.body.log.revision, completed: true };
    const path = `/api/demo/days/${date}/tasks/${task.task_id}/completion`;
    assert.equal((await f.call(path, 'POST', body, 'wrong-token')).status, 403);
    const completed = await f.call(path, 'POST', body);
    assert.equal(completed.status, 200, JSON.stringify(completed));
    assert.equal(completed.body.tasks.find((item: any) => item.task_id === task.task_id).status, 'done');
    assert.deepEqual(await f.call('/api/state'), before);
    assert.equal((await f.call(`/api/days/${date}`)).body.tasks.length, 0);
    assert.equal((await f.call('/api/demo/demo/state')).status, 404);
    assert.equal((await f.call('/api/demo/backups')).status, 403);
    assert.equal((await f.call('/api/demo/ai/settings')).status, 403);
    const started = await f.call(`/api/demo/days/${date}/timer/start`, 'POST', { requestId: randomUUID(), revision: completed.body.log.revision,
      task_id: day.body.tasks[1].task_id, block_id: day.body.tasks[1].work_block_id, target_minutes: null });
    assert.equal(started.status, 200, JSON.stringify(started));
    assert.equal((await f.call('/api/demo/exit', 'POST', {})).status, 200);
    assert.equal((await f.call(`/api/demo/days/${date}/timer`)).body.active, null);
    assert.deepEqual(await f.call('/api/state'), before);
  } finally { await f.close(); }
});

test('a first task can leave planned time unknown, run its timer and complete independently', async () => {
  const f = await fixture();
  try {
    await f.call('/api/setup', 'POST', { requestId: randomUUID(), timezone: 'UTC', availableMinutes: null, mode: 'blank' });
    const created = await f.call('/api/projects', 'POST', { requestId: randomUUID(), project: { name: 'My first project', project_type: 'product', platform: null,
      operating_role: 'future_asset', stage: '', status: 'active', primary_metric_key: null, baseline_value: null, baseline_at: null, baseline_source: null,
      target_value: null, target_date: null, next_milestone: null, next_action: null, daily_budget_minutes: null, cadence: { days_per_week: null }, notes: '' } });
    assert.equal(created.status, 201); const project = created.body.project;
    const date = new Date().toISOString().slice(0, 10);
    const added = await f.call(`/api/days/${date}/quick-task`, 'POST', { requestId: randomUUID(), revision: 0, project_id: project.id, project_revision: project.revision,
      title: 'Make a small start', acceptance: 'I decide when it is done', result_type: 'binary', metric_key: null, target_value: 1,
      budget_minutes: null, available_minutes: null, resume_project: false, acknowledgeOverCapacity: false });
    assert.equal(added.status, 200, JSON.stringify(added));
    assert.equal(added.body.log.plan_snapshots[0].available_minutes, null);
    assert.equal(added.body.log.plan_snapshots[0].work_blocks[0].budget_minutes, null);
    const task = added.body.tasks[0];
    const started = await f.call(`/api/days/${date}/timer/start`, 'POST', { requestId: randomUUID(), revision: added.body.log.revision, task_id: task.task_id, block_id: task.work_block_id, target_minutes: null });
    assert.equal(started.status, 200);
    const done = await f.call(`/api/days/${date}/tasks/${task.task_id}/completion`, 'POST', { requestId: randomUUID(), revision: started.body.log.revision, completed: true });
    assert.equal(done.status, 200); assert.equal(done.body.tasks[0].status, 'done'); assert.deepEqual(done.body.effective_events, []);
    assert.equal((await f.call(`/api/days/${date}/timer`)).body.active, null);
    const backup = await f.call('/api/backups', 'POST', { requestId: randomUUID() });
    assert.equal(backup.status, 201, JSON.stringify(backup));
    const preview = await f.call('/api/restores/preview', 'POST', { backupId: backup.body.id });
    assert.equal(preview.status, 200, JSON.stringify(preview));
  } finally { await f.close(); }
});

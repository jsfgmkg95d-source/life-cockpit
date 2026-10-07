import { testFetch } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, PROJECT_ROOT } from '../server/app.ts';
import type { AppState } from '../shared/contracts.ts';
import type { DayState } from '../shared/day-contracts.ts';

const { ServiceController, requestJson } = createRequire(import.meta.url)('../desktop/service.cjs');
const root = resolve(PROJECT_ROOT, '.runtime/tests');
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
function folder() { mkdirSync(root, { recursive: true }); return mkdtempSync(resolve(root, 'desktop-service-')); }
function remove(path: string) { assert.equal(dirname(path), root); rmSync(path, { recursive: true, force: true }); }
async function write(url: string, route: string, body: object) {
  const { csrfToken } = await requestJson(url, '/api/session');
  const response = await testFetch(url + route, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(body) });
  assert.equal(response.status, 200); return response.json();
}

test('desktop pauses an active task once through the existing API before stopping its own service; outcome remains unknown', { timeout: 25_000 }, async () => {
  const path = folder(), dataDir = resolve(path, 'data'); mkdirSync(dataDir);
  const controller = new ServiceController({ dataDir, backendRoot: PROJECT_ROOT, nodeExecutable: process.execPath, preferredPort: 1 });
  try {
    const connection = await controller.connect();
    assert.equal(connection.owned, true);
    const app: AppState = await write(connection.url, '/api/setup', { requestId: randomUUID(), timezone: 'Asia/Shanghai', availableMinutes: 180 });
    const project = app.projects[0];
    const day: DayState = await write(connection.url, `/api/days/${date}/quick-task`, {
      requestId: randomUUID(), revision: 0, project_id: project.id, project_revision: project.revision,
      title: 'Isolated desktop timer task', acceptance: 'User confirms the independent result', result_type: 'binary', metric_key: null,
      target_value: 1, budget_minutes: 25, available_minutes: 180, resume_project: false, acknowledgeOverCapacity: false,
    });
    await write(connection.url, `/api/days/${date}/timer/start`, {
      requestId: randomUUID(), revision: day.log!.revision, block_id: day.tasks[0].work_block_id, task_id: day.tasks[0].task_id, target_minutes: 25,
    });
    await delay(1100);
    assert.equal(await controller.pauseActive(), true);
    assert.equal(await controller.pauseActive(), false);
    const timer = await requestJson(connection.url, `/api/days/${date}/timer`);
    assert.equal(timer.active, null); assert.equal(timer.sessions.length, 1);
    assert.notEqual(timer.sessions[0].stopped_at, null);
    const saved: DayState = await requestJson(connection.url, `/api/days/${date}`);
    assert.equal(saved.tasks[0].result_state, 'unknown'); assert.equal(saved.events.length, 0);
    assert.equal(saved.log!.work_block_actuals.length, 1);
    await controller.stopOwned();
    const reopened = createApp({ dataDir }); await reopened.close();
  } finally { await controller.stopOwned(); remove(path); }
});

test('matching external ledger is reused and survives desktop exit; another ledger starts separately without taking over that service', { timeout: 25_000 }, async () => {
  const path = folder(), dataDir = resolve(path, 'original');
  const external = createApp({ dataDir });
  let own: InstanceType<typeof ServiceController> | undefined;
  try {
    const { url, port } = await external.listen();
    const reused = new ServiceController({ dataDir, backendRoot: PROJECT_ROOT, nodeExecutable: process.execPath, preferredPort: port });
    assert.equal((await reused.connect()).owned, false); assert.equal(reused.child, null);
    await reused.stopOwned(); assert.equal((await requestJson(url, '/api/health')).processId, process.pid);
    const differentData = resolve(path, 'different'); mkdirSync(differentData);
    own = new ServiceController({ dataDir: differentData, backendRoot: PROJECT_ROOT, nodeExecutable: process.execPath, preferredPort: port });
    const ownConnection = await own!.connect();
    assert.equal(ownConnection.owned, true); assert.notEqual(ownConnection.url, url);
    await own!.stopOwned(); assert.equal((await requestJson(url, '/api/health')).processId, process.pid);
  } finally { if (own) await own.stopOwned(); await external.close(); remove(path); }
});

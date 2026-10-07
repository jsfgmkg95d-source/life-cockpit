import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TEST_PROJECTS as INITIAL_PROJECTS } from './fixtures/workspace.ts';
import type { AppState } from '../shared/contracts.ts';
import type { DayState, PlanDraft } from '../shared/day-contracts.ts';
import type { TimerView } from '../shared/timer-contracts.ts';
import { SCHEMA_VERSION } from '../server/migrations.ts';

const root = resolve(import.meta.dirname, '..');
async function launch(dataDir: string) {
  const child = spawn(process.execPath, ['server/index.ts'], {
    cwd: root, env: { ...process.env, PCOS_PORT: '0', PCOS_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '', errors = '';
  child.stderr!.on('data', (part: Buffer) => { errors += part.toString(); });
  const address = await new Promise<{ url: string }>((success, fail) => {
    const timer = setTimeout(() => { child.kill(); fail(new Error(`启动超时：${errors}`)); }, 15_000);
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('exit', code => { clearTimeout(timer); fail(new Error(`启动失败 ${code}: ${errors}`)); });
    child.stdout!.on('data', (part: Buffer) => {
      output += part.toString();
      const ready = output.split(/\r?\n/u).find(line => line.startsWith('PCOS_READY '));
      if (ready) { clearTimeout(timer); success(JSON.parse(ready.slice(11))); }
    });
  });
  const { csrfToken } = await (await fetch(`${address.url}/api/session`)).json() as { csrfToken: string };
  return {
    child,
    async get<T>(path: string): Promise<T> {
      const response = await fetch(address.url + path);
      assert.equal(response.status, 200);
      return response.json() as Promise<T>;
    },
    async write<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
      const response = await fetch(address.url + path, { method,
        headers: { origin: address.url, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      return payload as T;
    },
  };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(); await exited;
}

test('v1迁移保留原记录；计划、零/未知、成果与共享实际投入经真实进程重启保持一致', { timeout: 45_000 }, async () => {
  const testRoot = resolve(root, '.runtime', 'tests');
  await mkdir(testRoot, { recursive: true });
  const dataDir = await mkdtemp(resolve(testRoot, 'migration-'));
  const databasePath = resolve(dataDir, 'personal-company.sqlite');
  const original = new DatabaseSync(databasePath);
  original.exec(await readFile(resolve(root, 'tests/fixtures/schema-v1.sql'), 'utf8'));
  const originalIds = INITIAL_PROJECTS.map(() => randomUUID());
  const timestamp = '2026-09-17T00:00:00.000Z';
  INITIAL_PROJECTS.forEach((project, index) => {
    original.prepare(`INSERT INTO projects (id,name,project_type,platform,operating_role,stage,status,
      primary_metric_key,baseline_value,baseline_at,baseline_source,daily_budget_minutes,cadence_json,notes,revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(originalIds[index], project.name, project.project_type,
        project.platform, project.operating_role, '保留旧阶段', index === 1 ? 'paused' : index === 2 ? 'archived' : 'active',
        index === 0 ? 'accepted_words' : null, index === 0 ? 0 : null, index === 0 ? '2026-09-16' : null,
        index === 0 ? '迁移测试的明确零基线' : null, project.daily_budget_minutes, '{"days_per_week":null}',
        `v1原始记录 ${index}`, 7, timestamp, timestamp);
  });
  const settings = { timezone: 'Asia/Shanghai', available_minutes: null,
    shared_budget_groups: [{ id: 'feilu-block', title: '两书发布', project_ids: originalIds.slice(4), budget_minutes: 15 }] };
  original.prepare('INSERT INTO app_settings VALUES (1, ?, 4, 1, ?)').run(JSON.stringify(settings), timestamp);
  original.prepare('INSERT INTO request_dedup VALUES (?, ?, ?, ?, ?)').run('v1-sentinel', 'keep-me', 'original-hash', '{"preserve":true}', timestamp);
  const beforeProjects = original.prepare('SELECT * FROM projects ORDER BY id').all();
  const beforeSettings = original.prepare('SELECT * FROM app_settings').all();
  const beforeDedup = original.prepare('SELECT * FROM request_dedup').all();
  original.close();
  let app = await launch(dataDir);
  try {
    const state = await app.get<AppState>('/api/state');
    assert.deepEqual(state.projects.map(project => project.id).sort(), [...originalIds].sort());
    const dayPath = '/api/days/2026-09-18';
    let day = await app.get<DayState>(dayPath);
    assert.equal(day.log, null);
    assert.equal(day.suggested_draft.tasks.some(task => task.project_id === originalIds[1] || task.project_id === originalIds[2]), false);
    const draft: PlanDraft = {
      day_mode: 'work', available_minutes: 30, change_reason: '', notes: '独立迁移测试',
      dimensions: { cashflow: { applicable: true, reason: '' }, asset: { applicable: false, reason: '本次仅检验现金流任务' },
        health: { applicable: false, reason: '本次未安排' }, learning: { applicable: false, reason: '本次未安排' } },
      work_blocks: [{ id: 'write-block', title: '两项写作', budget_minutes: 20 }],
      tasks: [0, 4].map((index, position) => ({ candidate_id: `candidate-${index}`, task_id: null, project_id: originalIds[index],
        title: `验收测试章节 ${index}`, acceptance: `核对测试章节 ${index} 的定稿字数`, result_type: 'quant',
        metric_key: 'accepted_words', target_value: 1000, scoring_dimension: 'cashflow', raw_points: 25,
        estimated_minutes: null, work_block_id: 'write-block' })),
    };
    day = await app.write<DayState>(`${dayPath}/confirm`, { requestId: randomUUID(), revision: 0, draft, acknowledgeOverCapacity: false });
    const task = day.tasks.find(item => item.project_id === originalIds[0])!;
    const untouched = day.tasks.find(item => item.project_id === originalIds[4])!;
    day = await app.write<DayState>(`${dayPath}/events`, { requestId: randomUUID(), revision: day.log!.revision,
      event: { project_id: task.project_id, task_id: task.task_id, artifact_key: 'test/chapter-one', metric_key: 'accepted_words',
        value: 1200, stage: 'finalized', summary: '迁移测试定稿正文', source: '用户自报，独立测试样本' } });
    day = await app.write<DayState>(`${dayPath}/tasks/${task.task_id}/result`, { requestId: randomUUID(), revision: day.log!.revision,
      binary_value: null, explanation: '已核对本次记录', clear: false });
    day = await app.write<DayState>(`${dayPath}/timer/point`, { requestId: randomUUID(), revision: day.log!.revision, label: '真实进程隔离检查', occurred_at: '2026-09-18T08:00:00+08:00' });
    day = await app.write<DayState>(`${dayPath}/timer/period`, { requestId: randomUUID(), revision: day.log!.revision, block_id: 'write-block', started_at: '2026-09-18T09:00:00+08:00', stopped_at: '2026-09-18T09:02:00+08:00' });
    day = await app.write<DayState>(`${dayPath}/actuals`, { requestId: randomUUID(), revision: day.log!.revision,
      block_id: 'write-block', minutes: 18, source: '本人核对两项共用时段' }, 'PUT');
    const frozenDay = structuredClone(day);
    const frozenTimer = await app.get<TimerView>(`${dayPath}/timer`);
    assert.equal(day.tasks.find(item => item.task_id === task.task_id)!.confirmed_result!.actual_value, 1200);
    assert.equal(day.tasks.find(item => item.task_id === untouched.task_id)!.result_state, 'unknown');
    assert.equal(day.log!.work_block_actuals.reduce((total, actual) => total + actual.minutes, 0), 18);
    assert.equal(day.effective_events.length, 1);
    await stop(app.child);
    app = await launch(dataDir);
    const restored = await app.get<DayState>(dayPath);
    assert.deepEqual(restored.log, frozenDay.log);
    assert.deepEqual(restored.tasks, frozenDay.tasks);
    assert.deepEqual(restored.events, frozenDay.events);
    assert.deepEqual(restored.effective_events, frozenDay.effective_events);
    assert.deepEqual(await app.get<TimerView>(`${dayPath}/timer`), frozenTimer);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION);
      assert.deepEqual(db.prepare('SELECT * FROM projects ORDER BY id').all(), beforeProjects);
      assert.deepEqual(db.prepare('SELECT * FROM app_settings').all(), beforeSettings);
      assert.deepEqual(db.prepare("SELECT * FROM request_dedup WHERE scope='v1-sentinel'").all(), beforeDedup);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
  } finally { await stop(app.child); }
});

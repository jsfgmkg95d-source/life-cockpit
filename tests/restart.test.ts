import { testFetch } from './fixtures/workspace.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AppState, Project, ProjectInput } from '../shared/contracts.ts';

const root = resolve(import.meta.dirname, '..');
async function launch(dataDir: string) {
  const child = spawn(process.execPath, ['server/index.ts'], {
    cwd: root, env: { ...process.env, PCOS_PORT: '0', PCOS_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '', error = '';
  child.stderr!.on('data', (chunk: Buffer) => { error += chunk.toString(); });
  const ready = await new Promise<{ url: string }>((resolveReady, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Server timeout: ${error}`)); }, 15_000);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${error}`)); });
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.split(/\r?\n/).find(text => text.startsWith('PCOS_READY '));
      if (line) { clearTimeout(timer); resolveReady(JSON.parse(line.slice('PCOS_READY '.length))); }
    });
  });
  return { child, url: ready.url };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exit = once(child, 'exit');
  child.kill();
  await exit;
}
async function session(url: string) {
  const response = await testFetch(`${url}/api/session`);
  assert.equal(response.status, 200);
  const body = await response.json() as { csrfToken: string };
  return { 'content-type': 'application/json', origin: url, 'x-csrf-token': body.csrfToken };
}

test('real server process restart preserves edited, paused, archived and unknown project data', { timeout: 45_000 }, async () => {
  const testRoot = join(root, '.runtime', 'tests');
  await mkdir(testRoot, { recursive: true });
  const dataDir = await mkdtemp(join(testRoot, 'restart-'));
  let app = await launch(dataDir);
  try {
    let headers = await session(app.url);
    const setup = await testFetch(`${app.url}/api/setup`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'restart-setup', timezone: 'Asia/Shanghai', availableMinutes: null }) });
    assert.equal(setup.status, 200);
    let state = await setup.json() as AppState;
    assert.equal(state.projects.length, 6);
    assert.equal(state.settings.available_minutes, null);
    assert.equal(state.settings.shared_budget_groups.length, 1);
    assert.equal(state.settings.shared_budget_groups[0].budget_minutes, 15);
    assert.equal(state.projects.reduce((sum, p) => sum + (p.daily_budget_minutes ?? 0), 0) + 15, 135);
    const expected: Project[] = [];
    for (const [index, project] of state.projects.slice(0, 3).entries()) {
      const { id, revision, created_at, updated_at, ...input } = project;
      const changed: ProjectInput = { ...input, notes: `restart evidence ${index}`, status: index === 0 ? 'active' : index === 1 ? 'paused' : 'archived', next_milestone: index === 0 ? '持久化验证里程碑' : null };
      const result = await testFetch(`${app.url}/api/projects/${id}`, { method: 'PUT', headers, body: JSON.stringify({ revision, project: changed }) });
      assert.equal(result.status, 200);
      expected.push((await result.json() as { project: Project }).project);
    }
    await stop(app.child);
    app = await launch(dataDir);
    headers = await session(app.url);
    state = await (await testFetch(`${app.url}/api/state`)).json() as AppState;
    assert.equal(state.setupCompleted, true);
    assert.equal(state.projects.length, 6);
    for (const saved of expected) assert.deepEqual(state.projects.find(p => p.id === saved.id), saved);
    for (const project of state.projects) { assert.equal(project.baseline_value, null); assert.equal(project.target_value, null); }
    const retry = await testFetch(`${app.url}/api/setup`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'restart-setup', timezone: 'Asia/Shanghai', availableMinutes: null }) });
    assert.equal(retry.status, 200);
    const final = await (await testFetch(`${app.url}/api/state`)).json() as AppState;
    assert.equal(final.projects.length, 6);
    for (const saved of expected) assert.deepEqual(final.projects.find(p => p.id === saved.id), saved);
  } finally { await stop(app.child); }
});

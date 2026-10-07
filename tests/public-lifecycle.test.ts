import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createApp, PROJECT_ROOT } from '../server/app.ts';
import { Store } from '../server/store.ts';

function folder() { const root = resolve(PROJECT_ROOT, '.runtime/tests'); mkdirSync(root, { recursive: true }); return mkdtempSync(resolve(root, 'public-lifecycle-')); }
test('a listen failure releases the ledger once and subsequent close calls are safe', async () => {
  const root = folder(); const first = createApp({ dataDir: resolve(root, 'first') }); const { port } = await first.listen();
  const failed = createApp({ dataDir: resolve(root, 'second'), port });
  try {
    await assert.rejects(failed.listen(), /EADDRINUSE/u);
    assert.equal(failed.close(), failed.close()); await failed.close();
    const reopened = createApp({ dataDir: resolve(root, 'second') }); await reopened.listen(); await reopened.close();
  } finally { await failed.close(); await first.close(); rmSync(root, { recursive: true, force: true }); }
});

test('closing during the first sample request leaves neither a child service nor ledger locks', async () => {
  const root = folder(), dataDir = resolve(root, 'data'); const app = createApp({ dataDir }); const { url } = await app.listen();
  try {
    const admitted = new Promise<void>(resolveRequest => app.server.once('request', () => resolveRequest()));
    const request = fetch(url + '/api/demo/state').then(response => response.json());
    await admitted;
    const closed = app.close(); assert.equal(closed, app.close());
    await Promise.allSettled([request, closed]); await closed;
    for (const directory of [dataDir, resolve(dataDir, 'sample-workspace')]) {
      const reopened = createApp({ dataDir: directory }); await reopened.listen(); await reopened.close();
    }
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('sample startup skips archived projects when creating a new day of sample tasks', async () => {
  const root = folder(), dataDir = resolve(root, 'data'); const store = new Store(dataDir);
  const state = store.setup(randomUUID(), 'Asia/Shanghai', null, 'demo');
  const { id, revision, created_at: _created, updated_at: _updated, ...project } = state.projects[0];
  store.updateProject(id, revision, { ...project, status: 'archived' }); store.close();
  const app = createApp({ dataDir, demoWorkspace: true });
  try {
    const { url } = await app.listen();
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const day = await (await fetch(`${url}/api/days/${date}`)).json();
    assert.equal(day.tasks.length, 2); assert.ok(day.tasks.every((task: any) => task.project_id !== id));
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

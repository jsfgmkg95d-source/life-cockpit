import { setupTestWorkspace, testFetch } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createApp, PROJECT_ROOT } from '../server/app.ts';
import { Store } from '../server/store.ts';

const root = resolve(PROJECT_ROOT, '.runtime/tests');
function folder() { mkdirSync(root, { recursive: true }); return mkdtempSync(resolve(root, 'restore-runtime-')); }
function remove(path: string) { assert.equal(dirname(path), root); rmSync(path, { recursive: true, force: true }); }
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}
async function client(url: string) {
  const { csrfToken } = await (await testFetch(url + '/api/session')).json();
  const request = (path: string, method = 'GET', body?: unknown) => testFetch(url + path, { method, headers: { Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function call(path: string, method = 'GET', body?: unknown) { const response = await request(path, method, body); const value = await response.json(); assert.ok(response.ok, `${path}: ${JSON.stringify(value)}`); return value; }
  return { request, call };
}

test('真实服务独占账本；进程被强制终止后系统释放锁，新服务直接启动并保留记录', { timeout: 20_000 }, async () => {
  const path = folder(); const dataDir = resolve(path, 'data');
  const moduleUrl = pathToFileURL(resolve(PROJECT_ROOT, 'server/app.ts')).href;
  const code = `import { createApp } from ${JSON.stringify(moduleUrl)}; const app = createApp({ dataDir: ${JSON.stringify(dataDir)} }); console.log('READY ' + JSON.stringify(await app.listen()));`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], { cwd: PROJECT_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; let output = '';
  child.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
  try {
    const { url } = await new Promise<{ url: string }>((ready, fail) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error(`子进程启动超时：${errors}`)); }, 10_000);
      child.once('error', error => { clearTimeout(timer); fail(error); });
      child.once('exit', code => { clearTimeout(timer); fail(new Error(`子进程提前退出 ${code}：${errors}`)); });
      child.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const line = output.split(/\r?\n/u).find(value => value.startsWith('READY '));
        if (line) { clearTimeout(timer); ready(JSON.parse(line.slice(6))); }
      });
    });
    const api = await client(url);
    const before = await api.call('/api/setup', 'POST', { requestId: randomUUID(), timezone: 'Asia/Shanghai', availableMinutes: 135 });
    assert.equal(before.projects.length, 6);
    assert.throws(() => createApp({ dataDir }), /已有应用服务/u);
    assert.equal((await api.call('/api/health')).processId, child.pid);
    await kill(child);
    const restarted = createApp({ dataDir });
    try {
      const next = await restarted.listen();
      const after = await client(next.url);
      assert.deepEqual(await after.call('/api/state'), before);
      assert.equal((await after.call('/api/health')).processId, process.pid);
      assert.throws(() => createApp({ dataDir }), /已有应用服务/u);
    } finally { await restarted.close(); }
    const onceMore = createApp({ dataDir }); await onceMore.close();
  } finally { await kill(child); remove(path); }
});

test('启动中断遗留连接测试并保留调用额度，恢复核对可用；日常读取不打断新的连接测试', { timeout: 20_000 }, async () => {
  const path = folder(); const dataDir = resolve(path, 'data');
  const seed = new Store(dataDir);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const orphan = randomUUID(); const completed = randomUUID(); const created = new Date().toISOString();
  try {
    setupTestWorkspace(seed, randomUUID(), 'Asia/Shanghai', 135);
    const insert = seed.database.prepare('INSERT INTO ai_calls(id,day,report_id,status,input_tokens,output_tokens,created_at) VALUES(?,?,NULL,?,?,?,?)');
    insert.run(orphan, date, 'running', null, null, created);
    insert.run(completed, date, 'succeeded', 12, 4, created);
  } finally { seed.close(); }
  let releaseRead!: () => void; let reachedRead!: () => void;
  let releaseProvider!: () => void; let reachedProvider!: () => void;
  const readStarted = new Promise<void>(resolveRead => { reachedRead = resolveRead; });
  const providerStarted = new Promise<void>(resolveProvider => { reachedProvider = resolveProvider; });
  const app = createApp({ dataDir,
    keyVault: { has: () => true, async save() {}, async read() { reachedRead(); await new Promise<void>(release => { releaseRead = release; }); return 'isolated-test-key'; } },
    aiProvider: async () => { reachedProvider(); await new Promise<void>(release => { releaseProvider = release; }); return { content: { interpretations: [], gaps: [], suggestions: [] }, input_tokens: 1, output_tokens: 1 }; },
  });
  const { url } = await app.listen();
  const db = new DatabaseSync(resolve(dataDir, 'personal-company.sqlite'), { readOnly: true });
  let testing: Promise<Response> | undefined;
  try {
    const api = await client(url);
    const recovered = db.prepare('SELECT * FROM ai_calls WHERE id=?').get(orphan)!;
    assert.equal(recovered.status, 'INTERRUPTED');
    assert.equal(recovered.report_id, null);
    assert.equal(recovered.input_tokens, null);
    assert.equal(recovered.output_tokens, null);
    assert.equal(recovered.created_at, created);
    assert.equal(db.prepare('SELECT status FROM ai_calls WHERE id=?').get(completed)!.status, 'succeeded');
    assert.equal((await api.call('/api/ai/settings')).calls_today, 2);
    const backup = await api.call('/api/backups', 'POST', { requestId: randomUUID() });
    const preview = await api.call('/api/restores/preview', 'POST', { backupId: backup.id });
    assert.equal(preview.incomingCounts.ai_calls, 2);
    assert.equal(preview.currentCounts.ai_calls, 2);

    await api.call('/api/ai/settings', 'PUT', { revision: 1, settings: { mode: 'openai', model: 'isolated-only', max_output_tokens: 2400, daily_call_limit: 10 }, clear_key: false });
    testing = api.request('/api/ai/test', 'POST', {});
    await readStarted;
    await api.call(`/api/days/${date}/reports/review`);
    assert.equal(db.prepare('SELECT count(*) AS n FROM ai_calls').get()!.n, 2);
    releaseRead();
    await providerStarted;
    const active = db.prepare("SELECT * FROM ai_calls WHERE status='running'").get()!;
    assert.ok(active);
    assert.equal(active.report_id, null);
    await api.call(`/api/days/${date}/reports/review`);
    assert.equal(db.prepare('SELECT status FROM ai_calls WHERE id=?').get(active.id!)!.status, 'running');
    releaseProvider();
    const done = await testing;
    assert.equal(done.status, 200, await done.text());
    assert.equal(db.prepare('SELECT status FROM ai_calls WHERE id=?').get(active.id!)!.status, 'succeeded');
    assert.equal((await api.call('/api/ai/settings')).calls_today, 3);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    releaseRead?.(); releaseProvider?.(); await testing?.catch(() => undefined);
    db.close(); await app.close(); remove(path);
  }
});

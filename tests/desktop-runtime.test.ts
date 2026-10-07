import { testFetch } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { createApp, PROJECT_ROOT } from '../server/app.ts';

const testRoot = resolve(PROJECT_ROOT, '.runtime/tests');
async function start(dataDir: string, distDir: string) {
  const child = spawn(process.execPath, [resolve(PROJECT_ROOT, 'server/index.ts')], {
    cwd: PROJECT_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, PCOS_DATA_DIR: dataDir, PCOS_DIST_DIR: distDir, PCOS_PORT: '0', PCOS_ALLOWED_ORIGINS: '' },
  });
  let output = '', errors = '';
  child.stderr!.on('data', chunk => { errors += String(chunk); });
  const ready = await new Promise<{ url: string }>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Service startup timeout: ${errors}`)), 8000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Service exited ${code}: ${errors}`)); });
    child.stdout!.on('data', chunk => {
      output += String(chunk);
      const line = output.split(/\r?\n/u).find(value => value.startsWith('PCOS_READY '));
      if (line) { clearTimeout(timeout); resolveReady(JSON.parse(line.slice(11))); }
    });
  });
  return { child, url: ready.url };
}
async function stop(child: ChildProcess, disconnect = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const timeout = setTimeout(() => child.kill(), 5000);
  try {
    if (disconnect) child.disconnect(); else child.send({ type: 'pcos-shutdown' });
    const [code] = await exited;
    assert.equal(code, 0, 'The desktop child must finish graceful shutdown.');
  } finally { clearTimeout(timeout); }
}

test('desktop child uses explicit assets/data, releases its lock through private IPC and preserves identity on restart', { timeout: 25_000 }, async () => {
  mkdirSync(testRoot, { recursive: true });
  const folder = mkdtempSync(resolve(testRoot, 'desktop-runtime-'));
  const dataDir = resolve(folder, 'data'), distDir = resolve(folder, 'ui');
  mkdirSync(distDir); writeFileSync(resolve(distDir, 'index.html'), '<!doctype html><title>Isolated desktop assets</title>');
  const children: ChildProcess[] = [];
  try {
    const first = await start(dataDir, distDir); children.push(first.child);
    assert.match(await (await testFetch(first.url)).text(), /Isolated desktop assets/u);
    const health = await (await testFetch(first.url + '/api/health')).json();
    assert.equal(health.processId, first.child.pid);
    assert.match(health.dataId, /^[a-f0-9]{16}$/u);
    assert.match(health.serviceId, /^[a-f0-9-]{36}$/u);
    assert.equal('dataDir' in health, false);
    const { csrfToken } = await (await testFetch(first.url + '/api/session')).json();
    const setup = await testFetch(first.url + '/api/setup', {
      method: 'POST', headers: { Origin: first.url, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ requestId: crypto.randomUUID(), timezone: 'Asia/Shanghai', availableMinutes: 135 }),
    });
    assert.equal(setup.status, 200);
    const before = await setup.json();
    assert.throws(() => createApp({ dataDir }), /已有应用服务/u);
    await stop(first.child);
    const second = await start(dataDir, distDir); children.push(second.child);
    const secondHealth = await (await testFetch(second.url + '/api/health')).json();
    assert.equal(secondHealth.dataId, health.dataId);
    assert.notEqual(secondHealth.serviceId, health.serviceId);
    assert.deepEqual(await (await testFetch(second.url + '/api/state')).json(), before);
    await stop(second.child, true);
    const other = createApp({ dataDir: resolve(folder, 'another-ledger'), distDir });
    try {
      const { url } = await other.listen();
      const otherHealth = await (await testFetch(url + '/api/health')).json();
      assert.notEqual(otherHealth.dataId, health.dataId);
    } finally { await other.close(); }
    const reopened = createApp({ dataDir }); await reopened.close();
  } finally {
    for (const child of children) await stop(child);
    assert.equal(dirname(folder), testRoot);
    rmSync(folder, { recursive: true, force: true });
  }
});

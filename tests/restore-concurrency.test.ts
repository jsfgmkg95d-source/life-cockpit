import { testFetch } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp, PROJECT_ROOT } from '../server/app.ts';

test('恢复后拒绝已上传一半的旧写请求；同一账本只允许一个服务', async () => {
  const root = resolve(PROJECT_ROOT, '.runtime/tests'); mkdirSync(root, { recursive: true }); const dataDir = mkdtempSync(resolve(root, 'restore-race-'));
  const app = createApp({ dataDir }); const { url } = await app.listen();
  try {
    assert.throws(() => createApp({ dataDir }), /已有应用服务/);
    const token = (await (await testFetch(url + '/api/session')).json()).csrfToken;
    const headers = { Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': token };
    const call = async (path: string, body: object) => { const r = await testFetch(url + path, { method: 'POST', headers, body: JSON.stringify(body) }); assert.ok(r.ok, await r.clone().text()); return r.json(); };
    await call('/api/setup', { requestId: randomUUID(), timezone: 'Asia/Shanghai', availableMinutes: null });
    const backup = await call('/api/backups', { requestId: randomUUID() });
    const preview = await call('/api/restores/preview', { backupId: backup.id });
    const state = await (await testFetch(url + '/api/state')).json();
    const payload = JSON.stringify({ revision: state.settings.revision, settings: { timezone: 'UTC', available_minutes: 999, shared_budget_groups: state.settings.shared_budget_groups } });
    let send!: ReturnType<typeof httpRequest>;
    const response = new Promise<number>(resolveResponse => {
      send = httpRequest(url + '/api/settings', { method: 'PUT', headers }, res => { res.resume(); res.on('end', () => resolveResponse(res.statusCode!)); });
      send.write(payload.slice(0, 15));
    });
    await new Promise<void>((resolveTurn) => setTimeout(resolveTurn, 30));
    await call('/api/restores', { requestId: randomUUID(), token: preview.token, confirmation: '恢复本地账本' });
    send.end(payload.slice(15)); assert.equal(await response, 403);
    assert.equal((await (await testFetch(url + '/api/state')).json()).settings.timezone, 'Asia/Shanghai');
  } finally { await app.close(); }
  const again = createApp({ dataDir }); await again.close();
});

test('密钥保存和连接测试的等待阶段阻止恢复核对', async () => {
  const root = resolve(PROJECT_ROOT, '.runtime/tests'); mkdirSync(root, { recursive: true }); const dataDir = mkdtempSync(resolve(root, 'restore-ai-race-'));
  let releaseSave!: () => void; let releaseRead!: () => void; let didSave!: () => void; let didRead!: () => void;
  const saving = new Promise<void>(r => { didSave = r; }); const reading = new Promise<void>(r => { didRead = r; });
  const app = createApp({ dataDir, keyVault: { has: () => true, async save() { didSave(); await new Promise<void>(r => { releaseSave = r; }); }, async read() { didRead(); await new Promise<void>(r => { releaseRead = r; }); return 'isolated-key'; } }, aiProvider: async () => ({ content: { interpretations: [], gaps: [], suggestions: [] }, input_tokens: 1, output_tokens: 1, provider_request_id: 'fake' }) });
  const { url } = await app.listen();
  try {
    const token = (await (await testFetch(url + '/api/session')).json()).csrfToken;
    const call = (path: string, body: object, method = 'POST') => testFetch(url + path, { method, headers: { Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify(body) });
    const backup = await (await call('/api/backups', { requestId: randomUUID() })).json();
    const configRequest = call('/api/ai/settings', { revision: 1, settings: { mode: 'openai', model: 'isolated', daily_call_limit: 10, max_output_tokens: 2400 }, key: 'isolated-key', clear_key: false }, 'PUT');
    await saving; assert.equal((await call('/api/restores/preview', { backupId: backup.id })).status, 409);
    releaseSave(); assert.equal((await configRequest).status, 200);
    const testing = call('/api/ai/test', {}); await reading;
    assert.equal((await call('/api/restores/preview', { backupId: backup.id })).status, 409);
    releaseRead(); assert.equal((await testing).status, 200);
    assert.equal((await call('/api/restores/preview', { backupId: backup.id })).status, 200);
  } finally { releaseSave?.(); releaseRead?.(); await app.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dataIdentity, isLoopbackUrl, matchesHealth, sameOrigin, isSafeExternalUrl, canStopOwnedService } = require('./service-identity.cjs');
const { readConfig, saveConfig, validateConfig } = require('./config.cjs');
const { requestJson, ServiceController } = require('./service.cjs');
const fixtureRoot = resolve(fileURLToPath(new URL('../output/desktop-test-fixtures/', import.meta.url)));
mkdirSync(fixtureRoot, { recursive: true });

function fixture(t) {
  const directory = mkdtempSync(join(fixtureRoot, 'identity-'));
  t.after(() => {
    const target = resolve(directory);
    assert.ok(target.startsWith(fixtureRoot + '\\') || target.startsWith(fixtureRoot + '/'));
    rmSync(target, { recursive: true, force: true });
  });
  return directory;
}

const health = { app: 'life-cockpit', host: '127.0.0.1', dataId: 'a123456789abcdef', serviceId: '9cb456e0-fb46-4d42-a13e-85dd40a676ad', processId: 42 };

test('账本身份采用真实目录，不以相同 workspaceId 混同两本账本', t => {
  const first = fixture(t), second = fixture(t);
  assert.equal(dataIdentity(first), createHash('sha256').update(realpathSync(first).toLowerCase()).digest('hex').slice(0, 16));
  assert.equal(dataIdentity(join(first, '.')), dataIdentity(first));
  assert.notEqual(dataIdentity(first), dataIdentity(second));
  assert.equal(matchesHealth({ ...health, workspaceId: 'same' }, { dataId: health.dataId }), true);
  assert.equal(matchesHealth({ ...health, workspaceId: 'same', dataId: dataIdentity(second) }, { dataId: health.dataId }), false);
});

test('复用要求账本、进程和服务实例同时匹配，旧服务不能凭名称复用', () => {
  assert.equal(matchesHealth(health, health), true);
  for (const mutation of [{ dataId: undefined }, { serviceId: undefined }, { processId: 0 }, { host: '0.0.0.0' }, { app: 'other' }]) assert.equal(matchesHealth({ ...health, ...mutation }, health), false);
  assert.equal(matchesHealth({ ...health, processId: 43 }, health), false);
  assert.equal(matchesHealth({ ...health, serviceId: '3e00225c-331e-45e2-b9b4-3552b0c340e4' }, health), false);
});

test('窗口边界拒绝其他本机端口、凭据、危险协议，允许明确外部网页', async () => {
  const url = 'http://127.0.0.1:4317';
  assert.equal(isLoopbackUrl(url), true);
  assert.equal(sameOrigin(url + '/today', url), true);
  for (const value of ['http://localhost:4317', 'http://127.0.0.1:4333', 'http://user:secret@127.0.0.1:4317', 'file:///C:/data', 'javascript:alert(1)']) assert.equal(sameOrigin(value, url), false);
  for (const value of ['file:///C:/data', 'javascript:alert(1)', 'http://user:secret@example.com', 'http://127.0.0.1:4333', 'http://localhost:4333', 'http://test.localhost:4333', 'http://[::1]:4333', 'http://[::ffff:127.0.0.1]:4333']) assert.equal(isSafeExternalUrl(value), false);
  assert.equal(isSafeExternalUrl('https://github.com/example/project'), true);
  assert.equal(isSafeExternalUrl('http://example.com/evidence'), true);
  await assert.rejects(requestJson(url, '//example.com/api/state'), /地址无效/);
  await assert.rejects(requestJson(url, '/\\example.com/api/state'), /地址无效/);
});

test('暂停不赋予关闭外部服务的权限，关闭必须持有自己的 IPC 子进程', async () => {
  const child = { pid: 42, connected: true, send() { throw new Error('不应发送'); }, exitCode: null, signalCode: null };
  assert.equal(canStopOwnedService({ owned: true, processId: 42 }, child), true);
  assert.equal(canStopOwnedService({ owned: false, processId: 42 }, child), false);
  assert.equal(canStopOwnedService({ owned: true, processId: 43 }, child), false);
  assert.equal(canStopOwnedService({ owned: true, processId: 42 }, { ...child, connected: false }), false);
  const controller = Object.create(ServiceController.prototype);
  controller.child = child;
  controller.connection = { owned: false, processId: 42 };
  await controller.stopOwned();
});

test('退出和随后睡眠复用同一个已捕获截止时刻，不在恢复时重新计时', async () => {
  const controller = Object.create(ServiceController.prototype);
  controller.pausePromise = null;
  let complete, captured;
  controller.pauseCurrentSession = stoppedAt => {
    captured = stoppedAt;
    return new Promise(resolvePause => { complete = resolvePause; });
  };
  const before = Date.now();
  const exit = controller.pauseActive();
  const after = Date.now();
  assert.ok(Date.parse(captured) >= before && Date.parse(captured) <= after);
  const sleep = controller.pauseActive('2026-10-02T03:30:00.000Z');
  assert.ok(Date.parse(captured) >= before && Date.parse(captured) <= after);
  complete(true);
  assert.deepEqual(await Promise.all([exit, sleep]), [true, true]);
  assert.equal(controller.pausePromise, null);
});

test('桌面设置只记录账本路径，保存与更新保留原账本字节', t => {
  const directory = fixture(t), ledger = join(directory, 'data'), settings = join(directory, 'settings');
  mkdirSync(ledger); mkdirSync(settings);
  const sentinel = join(ledger, 'personal-company.sqlite');
  writeFileSync(sentinel, '原账本保留');
  const original = saveConfig(settings, { schemaVersion: 1, dataDir: ledger });
  assert.equal(readConfig(settings).dataDir, realpathSync(ledger));
  assert.equal(original.preferredPort, 4317);
  saveConfig(settings, { ...original, preferredPort: 4333 });
  assert.equal(readConfig(settings).preferredPort, 4333);
  const { readFileSync } = require('node:fs');
  assert.equal(readFileSync(sentinel, 'utf8'), '原账本保留');
  assert.throws(() => validateConfig({ schemaVersion: 1, dataDir: 'data' }), /目录无效/);
  assert.throws(() => validateConfig({ schemaVersion: 1, dataDir: sentinel }), /目录已移动/);
  assert.throws(() => validateConfig({ schemaVersion: 1, dataDir: ledger, preferredPort: 0 }), /端口无效/);
});

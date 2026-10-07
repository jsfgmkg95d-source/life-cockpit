import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { buildDestination } from './build-path.mjs';

const require = createRequire(import.meta.url);
const { initialConfig } = require('./config.cjs');
const { matchesHealth } = require('./service-identity.cjs');
const { launchOptions } = require('./launch-widget.cjs');
const { iconPng, iconIco, iconSvg } = require('./icon.cjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(root, 'output', 'desktop-test-fixtures');
mkdirSync(fixtureRoot, { recursive: true });

function fixture(t) {
  const directory = mkdtempSync(join(fixtureRoot, 'public-'));
  t.after(() => {
    assert.ok(resolve(directory).startsWith(fixtureRoot + '/') || resolve(directory).startsWith(fixtureRoot + '\\'));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('fresh install defaults to its own new ledger and ignores historical build hints', async t => {
  const directory = fixture(t), settings = join(directory, 'settings'), oldLedger = join(directory, 'old');
  mkdirSync(oldLedger); writeFileSync(join(oldLedger, 'personal-company.sqlite'), 'existing record');
  let shown;
  const config = await initialConfig({ userDataDir: settings, defaultDataDir: oldLedger, dialog: {
    async showMessageBox(options) { shown = options; return { response: options.defaultId }; },
    async showOpenDialog() { throw new Error('Must not choose an old directory by default'); },
  } });
  assert.equal(config.dataDir, join(settings, 'data'));
  assert.equal(shown.buttons[0], '建立新账本');
  assert.equal(readFileSync(join(oldLedger, 'personal-company.sqlite'), 'utf8'), 'existing record');
  const reopened = await initialConfig({ userDataDir: settings, dialog: { async showMessageBox() { throw new Error('Configured installs do not repeat onboarding'); } } });
  assert.deepEqual(reopened, config);
});

test('opening an existing ledger is explicit and cancellation writes no settings', async t => {
  const directory = fixture(t), ledger = join(directory, 'ledger'), settings = join(directory, 'settings');
  mkdirSync(ledger); writeFileSync(join(ledger, 'personal-company.sqlite'), 'existing record');
  const config = await initialConfig({ userDataDir: settings, dialog: {
    async showMessageBox() { return { response: 1 }; },
    async showOpenDialog() { return { canceled: false, filePaths: [ledger] }; },
  } });
  assert.equal(config.dataDir, ledger);
  assert.equal(readFileSync(join(ledger, 'personal-company.sqlite'), 'utf8'), 'existing record');
  const canceledSettings = join(directory, 'canceled');
  assert.equal(await initialConfig({ userDataDir: canceledSettings, dialog: { async showMessageBox() { return { response: 2 }; } } }), null);
  assert.equal(existsSync(canceledSettings), false);
});

test('public install has a separate launcher settings directory and service identity', () => {
  const appData = resolve('synthetic-app-data');
  assert.equal(launchOptions([], resolve('release/windows/resources/app'), appData).settingsDir, join(appData, 'LifeCockpit'));
  const health = { host: '127.0.0.1', dataId: 'a123456789abcdef', serviceId: '9cb456e0-fb46-4d42-a13e-85dd40a676ad', processId: 42 };
  assert.equal(matchesHealth({ ...health, app: 'life-cockpit' }, health), true);
  assert.equal(matchesHealth({ ...health, app: 'personal-company-os' }, health), false);
});

test('release destination must be fresh so removed assets cannot survive rebuilding', t => {
  const directory = fixture(t), destination = join(directory, 'release', 'windows');
  assert.equal(buildDestination(directory), destination);
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'stale-private-file'), 'do not copy');
  assert.throws(() => buildDestination(directory), /already exists/);
  assert.equal(buildDestination(directory, ['--output', 'release/next']), join(directory, 'release', 'next'));
  assert.throws(() => buildDestination(directory, ['--wrong', 'release/next']), /Usage/);
  assert.equal(readFileSync(join(destination, 'stale-private-file'), 'utf8'), 'do not copy');
});

test('original compass raster and multi-size Windows icon are complete and deterministic', () => {
  const png = iconPng(32);
  assert.deepEqual(png, iconPng(32));
  assert.equal(png.readUInt32BE(16), 32); assert.equal(png.readUInt32BE(20), 32);
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), name = png.toString('ascii', offset + 4, offset + 8);
    if (name === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  assert.equal(inflateSync(Buffer.concat(chunks)).length, 32 * (32 * 4 + 1));
  const ico = iconIco();
  assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), 7);
  const last = 6 + 6 * 16;
  assert.equal(ico.readUInt32LE(last + 12) + ico.readUInt32LE(last + 8), ico.length);
  assert.equal(readFileSync(join(root, 'public/life-cockpit.svg'), 'utf8'), iconSvg);
});

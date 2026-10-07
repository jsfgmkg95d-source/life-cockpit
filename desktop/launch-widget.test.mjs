import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { launchOptions, lastMainWindow, launchArguments } = require('./launch-widget.cjs');
const options = { mainExecutable: resolve('app.exe'), settingsDir: resolve('settings') };
const health = { app: 'life-cockpit', host: '127.0.0.1', dataId: 'a123456789abcdef',
  serviceId: '9cb456e0-fb46-4d42-a13e-85dd40a676ad', processId: 42 };

test('入口只在已核对旧版服务仍健康时选择不停表小组件', () => {
  const old = { url: 'http://127.0.0.1:14576', widgetApi: false };
  const args = launchArguments(options, old, health, health.dataId);
  assert.equal(args[0], '--widget-companion');
  assert.equal(args[2], old.url);
  assert.equal(args[4], health.dataId);
  for (const source of [null, { ...old, widgetApi: true }]) assert.deepEqual(launchArguments(options, source, health, health.dataId), ['--widget']);
  assert.deepEqual(launchArguments(options, old, null, health.dataId), ['--widget']);
  assert.deepEqual(launchArguments(options, old, health, 'b123456789abcdef'), ['--widget']);
  assert.deepEqual(launchArguments(options, { ...old, url: 'https://example.com' }, health, health.dataId), ['--widget']);
});

test('入口读取最后主窗口日志，忽略其他行并拒绝外部URL与不完整标记', () => {
  const first = '2026-10-06 桌面窗口已加载：http://127.0.0.1:14576\n';
  assert.deepEqual(lastMainWindow(first), { url: 'http://127.0.0.1:14576', widgetApi: false });
  assert.deepEqual(lastMainWindow(first + '2026-10-06 桌面窗口已加载：http://127.0.0.1:14577/ widget-api=1\n其他日志'), { url: 'http://127.0.0.1:14577', widgetApi: true });
  assert.equal(lastMainWindow(first + '桌面窗口已加载：https://example.com'), null);
  assert.equal(lastMainWindow(first + '桌面窗口已加载：http://127.0.0.1:14576/?view=widget'), null);
  assert.equal(lastMainWindow(first.trimEnd() + ' widget-api=10')?.widgetApi, false);
});

test('包内主程序按已知资源相对位置查找，开发入口必须明确绝对路径', () => {
  const appRoot = resolve('release/windows/resources/app');
  const parsed = launchOptions([], appRoot, resolve('roaming'));
  assert.equal(parsed.mainExecutable, resolve(appRoot, '..', '..', '人生驾驶舱.exe'));
  assert.equal(launchOptions(['--main-executable', options.mainExecutable, '--settings-dir', options.settingsDir]).mainExecutable, options.mainExecutable);
  assert.throws(() => launchOptions(['--main-executable', 'relative.exe']));
  assert.throws(() => launchOptions(['--service-url', 'http://127.0.0.1:4317']));
  assert.throws(() => launchOptions(['--settings-dir', options.settingsDir, '--settings-dir', options.settingsDir]));
});

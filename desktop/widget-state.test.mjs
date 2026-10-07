import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeWidgetState, widgetBounds, trustedWidgetSender, requestsWidget } = require('./widget-state.cjs');
const { companionOptions } = require('./widget-companion-options.cjs');
import { resolve } from 'node:path';
const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const secondary = { x: -1280, y: 0, width: 1280, height: 984 };

test('小组件保留负坐标显示器位置，拔掉显示器后回到可见区域', () => {
  assert.deepEqual(widgetBounds({ x: -1100, y: 160 }, [primary, secondary]), { x: -1100, y: 160, width: 360, height: 660 });
  assert.deepEqual(widgetBounds({ x: -1100, y: 160 }, [primary]), { x: 0, y: 160, width: 360, height: 660 });
  assert.deepEqual(widgetBounds({ x: 1900, y: 1030 }, [primary]), { x: 1560, y: 380, width: 360, height: 660 });
});

test('损坏偏好与小显示器不会留下不可访问的组件', () => {
  assert.deepEqual(normalizeWidgetState({ visible: 'yes', alwaysOnTop: 0, x: Infinity, y: 10 }), { visible: false, alwaysOnTop: true });
  assert.deepEqual(normalizeWidgetState({ visible: true, alwaysOnTop: false }), { visible: true, alwaysOnTop: false });
  assert.deepEqual(widgetBounds(null, [{ x: 4, y: 8, width: 300, height: 400 }]), { x: 4, y: 8, width: 300, height: 400 });
  assert.throws(() => widgetBounds({}, []), /显示器/);
});

test('窗口 IPC 只接受本应用已登记窗口的同源主 frame', () => {
  const origin = 'http://127.0.0.1:4317';
  const frame = { url: origin + '/?view=widget' };
  const sender = { mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url };
  const event = { sender, senderFrame: frame };
  assert.equal(trustedWidgetSender(event, [sender], origin), true);
  assert.equal(trustedWidgetSender(event, [], origin), false);
  assert.equal(trustedWidgetSender({ ...event, senderFrame: { url: frame.url } }, [sender], origin), false);
  assert.equal(trustedWidgetSender(event, [sender], 'http://127.0.0.1:4333'), false);
  frame.url = 'https://example.com/';
  assert.equal(trustedWidgetSender(event, [sender], origin), false);
  frame.url = origin;
  sender.isDestroyed = () => true;
  assert.equal(trustedWidgetSender(event, [sender], origin), false);
});

test('启动参数要求独立 --widget 标记', () => {
  assert.equal(requestsWidget(['app.exe', '--widget']), true);
  assert.equal(requestsWidget(['app.exe', '--widget-other']), false);
  assert.equal(requestsWidget(['app.exe', 'some/path/--widget']), false);
});

test('兼容小组件要求显式本机服务、账本身份和绝对路径，拒绝重定向式地址', () => {
  const base = ['electron', 'widget-companion.cjs', '--service-url', 'http://127.0.0.1:4317', '--data-id', 'a123456789abcdef',
    '--main-executable', resolve('app.exe'), '--settings-dir', resolve('settings')];
  assert.equal(companionOptions(base).serviceUrl, 'http://127.0.0.1:4317');
  for (const url of ['https://example.com', 'http://user:pass@127.0.0.1:4317', 'http://127.0.0.1:4317/other', 'http://127.0.0.1:4317/?view=widget']) {
    const input = [...base]; input[3] = url;
    assert.throws(() => companionOptions(input));
  }
  assert.throws(() => companionOptions([...base, '--data-id', 'a123456789abcdef']));
  const relative = [...base]; relative[7] = 'app.exe';
  assert.throws(() => companionOptions(relative));
});

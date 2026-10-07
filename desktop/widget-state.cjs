const { readFileSync, writeFileSync, renameSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { sameOrigin } = require('./service-identity.cjs');

const WIDGET_WIDTH = 360;
const WIDGET_HEIGHT = 660;

function normalizeWidgetState(value) {
  const state = { visible: value?.visible === true, alwaysOnTop: value?.alwaysOnTop !== false };
  if (Number.isSafeInteger(value?.x) && Number.isSafeInteger(value?.y)) {
    state.x = value.x;
    state.y = value.y;
  }
  return state;
}

function readWidgetState(directory) {
  try { return normalizeWidgetState(JSON.parse(readFileSync(join(directory, 'widget-settings.json'), 'utf8'))); }
  catch { return normalizeWidgetState(null); }
}

function saveWidgetState(directory, value) {
  const state = normalizeWidgetState(value);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'widget-settings.json');
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
  return state;
}

function widgetBounds(value, workAreas) {
  const areas = workAreas.filter(area => area && ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(area[key])) && area.width > 0 && area.height > 0);
  if (!areas.length) throw new Error('暂时没有可用的显示器');
  const state = normalizeWidgetState(value);
  const hasPosition = Number.isSafeInteger(state.x) && Number.isSafeInteger(state.y);
  const overlap = area => hasPosition
    ? Math.max(0, Math.min(state.x + WIDGET_WIDTH, area.x + area.width) - Math.max(state.x, area.x))
      * Math.max(0, Math.min(state.y + WIDGET_HEIGHT, area.y + area.height) - Math.max(state.y, area.y))
    : 0;
  // First area is the primary display; a removed monitor falls back there.
  const area = areas.reduce((best, candidate) => overlap(candidate) > overlap(best) ? candidate : best);
  const width = Math.min(WIDGET_WIDTH, area.width);
  const height = Math.min(WIDGET_HEIGHT, area.height);
  const x = hasPosition ? state.x : area.x + area.width - width - 24;
  const y = hasPosition ? state.y : area.y + 56;
  return { x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - height)), width, height };
}

function trustedWidgetSender(event, contents, serviceUrl) {
  try {
    const sender = event?.sender;
    const frame = event?.senderFrame;
    return !!sender && !sender.isDestroyed() && contents.includes(sender)
      && !!frame && frame === sender.mainFrame
      && sameOrigin(frame.url, serviceUrl) && sameOrigin(sender.getURL(), serviceUrl);
  } catch { return false; }
}

function requestsWidget(argv) { return Array.isArray(argv) && argv.includes('--widget'); }

module.exports = { normalizeWidgetState, readWidgetState, saveWidgetState, widgetBounds, trustedWidgetSender, requestsWidget };

const { createHash } = require('node:crypto');
const { realpathSync } = require('node:fs');
const { resolve } = require('node:path');

function dataIdentity(dataDir) {
  return createHash('sha256').update(realpathSync(resolve(dataDir)).toLowerCase()).digest('hex').slice(0, 16);
}

function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password
      && Number.isInteger(port) && port > 0 && port <= 65535;
  } catch { return false; }
}

function matchesHealth(health, expected) {
  return !!health && health.app === 'life-cockpit' && health.host === '127.0.0.1'
    && /^[a-f0-9]{16}$/.test(health.dataId ?? '') && health.dataId === expected.dataId
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(health.serviceId ?? '')
    && Number.isSafeInteger(health.processId) && health.processId > 0
    && (expected.processId === undefined || health.processId === expected.processId)
    && (expected.serviceId === undefined || health.serviceId === expected.serviceId);
}

function sameOrigin(value, serviceUrl) {
  if (!isLoopbackUrl(serviceUrl)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && url.origin === new URL(serviceUrl).origin;
  } catch { return false; }
}

function isSafeExternalUrl(value) {
  try {
    const url = new URL(value);
    const name = url.hostname.toLowerCase();
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      && name !== 'localhost' && !name.endsWith('.localhost') && !/^127\./.test(name)
      && !['0.0.0.0', '[::1]', '[::]', '::1', '::'].includes(name)
      && !/^\[::ffff:(?:7f[0-9a-f]{2}:|0:)/.test(name);
  } catch { return false; }
}

function canStopOwnedService(connection, child) {
  return connection?.owned === true && !!child && child.pid === connection.processId
    && child.connected === true && typeof child.send === 'function';
}

module.exports = { dataIdentity, isLoopbackUrl, matchesHealth, sameOrigin, isSafeExternalUrl, canStopOwnedService };

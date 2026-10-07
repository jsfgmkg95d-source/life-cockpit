const { randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const http = require('node:http');
const { join, resolve } = require('node:path');
const { createInterface } = require('node:readline');
const { dataIdentity, isLoopbackUrl, matchesHealth, canStopOwnedService } = require('./service-identity.cjs');

function requestJson(serviceUrl, route, { method = 'GET', body, headers = {}, timeout = 3000 } = {}) {
  if (!isLoopbackUrl(serviceUrl) || typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//')) return Promise.reject(new Error('本地服务地址无效。'));
  const target = new URL(route, serviceUrl);
  if (target.origin !== new URL(serviceUrl).origin) return Promise.reject(new Error('本地服务地址无效。'));
  return new Promise((resolveRequest, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request(target, {
      method, headers: { ...headers, ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) },
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        text += chunk;
        if (text.length > 8 * 1024 * 1024) request.destroy(new Error('本地服务返回内容过大。'));
      });
      response.on('error', reject);
      response.on('end', () => {
        let value;
        try { value = JSON.parse(text); } catch { reject(new Error('本地服务返回了无法读取的内容。')); return; }
        if (response.statusCode < 200 || response.statusCode >= 300) { reject(new Error(value?.error?.message ?? `本地服务返回 ${response.statusCode}。`)); return; }
        resolveRequest(value);
      });
    });
    request.setTimeout(timeout, () => request.destroy(new Error('本地服务响应超时。')));
    request.on('error', reject);
    if (payload !== null) request.write(payload);
    request.end();
  });
}

function nodeRuntime({ packaged, resourcesPath, override }) {
  const executable = override || (packaged ? join(resourcesPath, 'runtime', 'node.exe') : join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'));
  if (!existsSync(executable)) throw new Error('未找到随程序携带的 Node 运行环境，请重新构建或解压完整桌面程序。');
  const version = execFileSync(executable, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 5000 }).trim();
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) !== 24 || Number(match[2]) < 16) throw new Error('桌面后台需要 Node 24.16 或更新的 24.x 运行环境。');
  return executable;
}

class ServiceController {
  constructor({ dataDir, backendRoot, nodeExecutable, preferredPort = 4317, log = () => {} }) {
    this.dataDir = resolve(dataDir);
    this.dataId = dataIdentity(this.dataDir);
    this.backendRoot = backendRoot;
    this.nodeExecutable = nodeExecutable;
    this.preferredPort = preferredPort;
    this.log = log;
    this.child = null;
    this.connection = null;
    this.pausePromise = null;
  }

  async connect() {
    const existingUrl = `http://127.0.0.1:${this.preferredPort}`;
    try {
      const health = await requestJson(existingUrl, '/api/health', { timeout: 1500 });
      if (matchesHealth(health, { dataId: this.dataId })) {
        this.connection = { url: existingUrl, dataId: this.dataId, processId: health.processId, serviceId: health.serviceId, owned: false };
        return this.connection;
      }
      this.log('既有端口的服务身份或账本不匹配，将尝试独立本机端口。');
    } catch { /* An absent or unidentified server is never treated as our ledger. */ }

    const child = spawn(this.nodeExecutable, [join(this.backendRoot, 'server', 'index.ts')], {
      cwd: this.backendRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, PCOS_PORT: '0', PCOS_DATA_DIR: this.dataDir, PCOS_DIST_DIR: join(this.backendRoot, 'dist'), PCOS_ALLOWED_ORIGINS: '' },
    });
    this.child = child;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); this.log(chunk.trim()); });
    child.on('exit', (code, signal) => { this.log(`自有后台已退出：${code ?? signal ?? '正常'}。`); });

    return new Promise((resolveConnection, reject) => {
      const lines = createInterface({ input: child.stdout });
      let settled = false;
      const timer = setTimeout(() => fail(new Error('后台启动超时。请核对桌面日志与当前账本服务。')), 25000);
      const clear = () => { clearTimeout(timer); lines.close(); };
      const fail = error => { if (settled) return; settled = true; clear(); reject(error); };
      child.once('error', fail);
      child.once('exit', code => { fail(new Error(stderr.trim() || `后台未能启动（${code}）。已有账本不会被覆盖。`)); });
      lines.on('line', async line => {
        if (!line.startsWith('PCOS_READY ')) return;
        try {
          const ready = JSON.parse(line.slice('PCOS_READY '.length));
          if (!isLoopbackUrl(ready.url) || ready.processId !== child.pid) throw new Error('后台启动回执身份不匹配。');
          const health = await requestJson(ready.url, '/api/health');
          if (!matchesHealth(health, { dataId: this.dataId, processId: child.pid })) throw new Error('后台未能证明它使用了所选账本，已停止连接。');
          if (settled) return;
          this.connection = { url: ready.url, dataId: this.dataId, processId: child.pid, serviceId: health.serviceId, owned: true };
          settled = true; clear(); resolveConnection(this.connection);
        } catch (error) { fail(error); }
      });
    });
  }

  async verifiedConnection() {
    const connection = this.connection;
    if (!connection) throw new Error('尚未连接到所选账本。');
    const health = await requestJson(connection.url, '/api/health');
    if (!matchesHealth(health, connection)) throw new Error('当前端口的服务或账本已变化，未执行计时操作。请重新打开程序核对。');
    return connection;
  }

  async pauseActive(stoppedAt = new Date().toISOString()) {
    if (this.pausePromise) return this.pausePromise;
    this.pausePromise = this.pauseCurrentSession(stoppedAt);
    try { return await this.pausePromise; } finally { this.pausePromise = null; }
  }

  async pauseCurrentSession(stoppedAt) {
    const active = await this.activeSession();
    if (!active) return false;
    const connection = this.connection;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(active.business_date) || typeof active.id !== 'string') throw new Error('正在计时的记录身份无效，未执行暂停。');
    const day = await requestJson(connection.url, `/api/days/${active.business_date}`);
    const session = await requestJson(connection.url, '/api/session');
    await requestJson(connection.url, `/api/days/${active.business_date}/timer/stop`, {
      method: 'POST', headers: { Origin: connection.url, 'x-csrf-token': session.csrfToken },
      body: { discard: false, expected_session_id: active.id, requestId: randomUUID(), revision: day.log?.revision ?? 0, ...(stoppedAt === undefined ? {} : { stopped_at: stoppedAt }) }, timeout: 8000,
    });
    this.log('当前专注已暂停，实际用时已按已有接口保存。');
    return true;
  }

  async activeSession() {
    const connection = await this.verifiedConnection();
    const state = await requestJson(connection.url, '/api/state');
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: state.settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const timer = await requestJson(connection.url, `/api/days/${date}/timer`);
    return timer.active ?? null;
  }

  async stopOwned() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // External services are represented only by connection metadata, never by this child handle.
    const ownership = this.connection ?? { owned: true, processId: child.pid };
    if (!canStopOwnedService(ownership, child)) return;
    await new Promise((resolveStop, reject) => {
      const timer = setTimeout(() => reject(new Error('后台仍在保存或完成报告，请保留程序并稍后再退出。')), 90000);
      child.once('exit', () => { clearTimeout(timer); resolveStop(); });
      child.send({ type: 'pcos-shutdown' }, error => {
        if (error) { clearTimeout(timer); reject(error); return; }
      });
    });
    this.child = null;
  }
}

module.exports = { requestJson, nodeRuntime, ServiceController };

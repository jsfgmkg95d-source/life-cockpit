import { RestoreStore } from './restore-store.ts';
import { TimerStore, timerPointWrite, timerPeriodWrite, timerPointDeleteWrite, timerStartWrite, timerStopWrite } from './timer-store.ts';
import { FocusImportStore, focusImportWrite } from './focus-import-store.ts';
import { ScheduleStore, scheduleSaveWrite, scheduleDeleteWrite } from './schedule-store.ts';
import { InboxStore, inboxCaptureWrite, inboxArchiveWrite, inboxPromoteWrite, inboxRestoreWrite } from './inbox-store.ts';
import { growth } from './growth-store.ts';
import { lockInstance } from './instance-lock.ts';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, resolve } from 'node:path';
import { dashboard } from './dashboard-store.ts';
import { calendarMonth } from './calendar-store.ts';
import { BackupStore } from './backup-store.ts';
import { AppError } from './errors.ts';
import { json, makeSecurity, readJson, securityHeaders, staticFile } from './http-security.ts';
import { SCHEMA_VERSION } from './migrations.ts';
import { Store } from './store.ts';
import { DayStore } from './day-store.ts';
import { ScoreStore } from './score-store.ts';
import { ReportStore } from './report-store.ts';
import { WindowsKeyVault } from './ai-vault.ts';
import type { KeyVault } from './ai-vault.ts';
import type { AiProvider } from './ai-provider.ts';
import { adoptionInput, aiSettingsInput, generateInput, reportType } from './report-validation.ts';
import { actualWrite, businessDate, completionWrite, confirmWrite, correctionWrite, draftWrite, eventWrite, finishWrite, quickTaskWrite, removeTaskWrite, resultWrite, statusWrite } from './day-validation.ts';
import { availableMinutes, integer, object, projectInput, requestId, settingsInput, timezone } from './validation.ts';
import { APP_VERSION } from '../shared/version.ts';

export const PROJECT_ROOT = resolve(import.meta.dirname, '..');
export const WORKSPACE_ID = createHash('sha256').update(PROJECT_ROOT.toLowerCase()).digest('hex').slice(0, 16);

export interface AppOptions {
  dataDir?: string;
  port?: number;
  distDir?: string;
  allowedOrigins?: string[];
  aiProvider?: AiProvider;
  keyVault?: KeyVault;
  aiTimeoutMs?: number;
  /** Internal isolated sample workspace; never shares a user ledger. */
  demoWorkspace?: boolean;
}

export function createApp(options: AppOptions = {}) {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PCOS_PORT must be an integer between 0 and 65535.');
  const dataDir = resolve(options.dataDir ?? resolve(PROJECT_ROOT, 'data'));
  const unlock = lockInstance(dataDir);
  const canonicalDataDir = realpathSync(dataDir);
  const dataId = createHash('sha256').update(process.platform === 'win32' ? canonicalDataDir.toLowerCase() : canonicalDataDir).digest('hex').slice(0, 16);
  const serviceId = randomUUID();
  let store: Store;
  try { store = new Store(dataDir); } catch (error) { unlock(); throw error; }
  const security = makeSecurity(options.allowedOrigins, () => String(store.database.prepare('SELECT request_id FROM restore_receipts ORDER BY rowid DESC LIMIT 1').get()?.request_id ?? 'initial'));

  const backups = new BackupStore(store, resolve(dataDir, '..', 'backups', basename(dataDir)));
  const days = new DayStore(store);
  const schedules = new ScheduleStore(days);
  const inbox = new InboxStore(days);
  const timers = new TimerStore(days);
  const focusImports = new FocusImportStore(days);
  const scores = new ScoreStore(store);
  const secretPath = resolve(options.dataDir ?? resolve(PROJECT_ROOT, 'data'), 'secrets', 'openai-key.dpapi');
  let reports: ReportStore;
  try { reports = new ReportStore(store, options.keyVault ?? new WindowsKeyVault(secretPath, existsSync(secretPath)), options.aiProvider, options.aiTimeoutMs); } catch (error) { store.close(); unlock(); throw error; }
  const activeAi = new Set<Promise<unknown>>();
  async function aiOperation<T>(work: () => Promise<T>): Promise<T> { const pending = work(); activeAi.add(pending); try { return await pending; } finally { activeAi.delete(pending); } }
  const restores = new RestoreStore(store, backups, () => activeAi.size > 0 || reports.savingConfig || reports.jobs.size > 0);
  const distDir = resolve(options.distDir ?? resolve(PROJECT_ROOT, 'dist'));
  let boundPort = port;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let demo: ReturnType<typeof createApp> | undefined;
  let demoConnection: Promise<{ url: string; token: string }> | undefined;
  async function openDemo(): Promise<{ url: string; token: string }> {
    if (closed) throw new AppError(503, 'CLOSING', '应用正在关闭。');
    if (options.demoWorkspace) throw new AppError(404, 'NOT_FOUND', '未找到接口。');
    if (!demoConnection) demoConnection = (async () => {
      demo = createApp({ dataDir: resolve(dataDir, 'sample-workspace'), distDir, demoWorkspace: true });
      const { url } = await demo.listen();
      const session = await (await fetch(url + '/api/session')).json() as { csrfToken: string };
      return { url, token: session.csrfToken };
    })().catch(async error => { await demo?.close(); demo = undefined; demoConnection = undefined; throw error; });
    return demoConnection;
  }
  if (options.demoWorkspace) {
    try {
    const state = store.getState().setupCompleted ? store.getState() : store.setup('sample-workspace-v1', 'Asia/Shanghai', null, 'demo');
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    for (const project of days.getState(date).tasks.length ? [] : state.projects.filter(item => ['preparing', 'active'].includes(item.status) && item.next_action)) {
      days.quickTask(date, { requestId: randomUUID(), revision: days.getState(date).log?.revision ?? 0,
        project_id: project.id, project_revision: project.revision, title: project.next_action!, acceptance: '由我点击完成',
        result_type: 'binary', metric_key: null, target_value: 1, budget_minutes: 20, available_minutes: 120,
        resume_project: false, acknowledgeOverCapacity: false });
    }
    } catch (error) { store.close(); unlock(); throw error; }
  }

  function pauseDemoTimer() {
    const active = timers.view(new Date().toISOString().slice(0, 10)).active;
    if (active) timers.stop(active.business_date, { requestId: randomUUID(), revision: days.getState(active.business_date).log!.revision, discard: false, expected_session_id: active.id });
  }

  const server = createServer(async (request, response) => {
    securityHeaders(response);
    try {
      if (closed) throw new AppError(503, 'CLOSING', '应用正在关闭。');
      security.verify(request, boundPort);
      const readBody = async () => { const body = await readJson(request); security.verify(request, boundPort); return body; };
      const pathname = new URL(request.url ?? '/', `http://127.0.0.1:${boundPort}`).pathname;
      if (options.demoWorkspace && /^\/api\/(?:backups|restores|ai)(?:\/|$)/u.test(pathname)) throw new AppError(403, 'DEMO_LIMITED', '示例工作台不提供备份恢复或在线 AI 设置，请返回个人工作台使用。');
      if (options.demoWorkspace && pathname === '/api/exit' && request.method === 'POST') {
        object(await readBody(), '退出示例', []); pauseDemoTimer(); json(response, 200, { paused: true });
      } else if (pathname.startsWith('/api/demo/')) {
        const innerPath = pathname.replace('/api/demo/', '/api/');
        // Only application APIs are proxied. The primary server validates Host, Origin and CSRF first.
        if (innerPath.startsWith('/api/demo/') || innerPath === '/api/session') throw new AppError(404, 'NOT_FOUND', '未找到接口。');
        const connection = await openDemo();
        const body = ['GET', 'HEAD'].includes(request.method ?? 'GET') ? undefined : await readBody();
        const result = await fetch(connection.url + innerPath, { method: request.method, headers: { Origin: connection.url, 'Content-Type': 'application/json', 'X-CSRF-Token': connection.token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        json(response, result.status, await result.json());
      } else if (request.method === 'GET' && pathname === '/api/health') {
        json(response, 200, { app: 'life-cockpit', version: APP_VERSION, schemaVersion: SCHEMA_VERSION, workspaceId: WORKSPACE_ID, dataId, serviceId, processId: process.pid, host: '127.0.0.1' });
      } else if (request.method === 'GET' && pathname === '/api/session') {
        json(response, 200, { csrfToken: security.token });
      } else if (request.method === 'GET' && pathname === '/api/state') {
        json(response, 200, store.getState());
      } else if (pathname === '/api/inbox' && request.method === 'GET') {
        json(response, 200, inbox.view());
      } else if (pathname === '/api/inbox/capture' && request.method === 'POST') {
        json(response, 201, inbox.capture(inboxCaptureWrite(await readBody())));
      } else if (/^\/api\/inbox\/[^/]+\/archive$/u.test(pathname) && request.method === 'POST') {
        json(response, 200, inbox.archive(decodeURIComponent(pathname.split('/')[3]), inboxArchiveWrite(await readBody())));
      } else if (/^\/api\/inbox\/[^/]+\/restore$/u.test(pathname) && request.method === 'POST') {
        json(response, 200, inbox.restore(decodeURIComponent(pathname.split('/')[3]), inboxRestoreWrite(await readBody())));
      } else if (pathname.startsWith('/api/dashboard/') && request.method === 'GET') {
        json(response, 200, dashboard(store, businessDate(pathname.slice('/api/dashboard/'.length))));
      } else if (pathname.startsWith('/api/calendar/') && request.method === 'GET') {
        json(response, 200, calendarMonth(store, pathname.slice('/api/calendar/'.length)));
      } else if (pathname.startsWith('/api/growth/') && request.method === 'GET') {
        json(response, 200, growth(store, businessDate(pathname.slice('/api/growth/'.length))));
      } else if (pathname === '/api/restores/preview' && request.method === 'POST') {
        const body = object(await readBody(), '恢复核对', ['backupId']);
        json(response, 200, restores.preview(requestId(body.backupId)));
      } else if (pathname === '/api/restores' && request.method === 'POST') {
        const body = object(await readBody(), '恢复账本', ['requestId', 'token', 'confirmation']);
        json(response, 200, restores.restore(requestId(body.requestId), requestId(body.token), typeof body.confirmation === 'string' ? body.confirmation : ''));
      } else if (/^\/api\/restores\/[^/]+$/u.test(pathname) && request.method === 'GET') {
        json(response, 200, restores.get(requestId(pathname.split('/')[3])));
      } else if (pathname === '/api/backups' && request.method === 'GET') {
        json(response, 200, backups.list());
      } else if (pathname === '/api/backups' && request.method === 'POST') {
        const body = object(await readBody(), '创建备份', ['requestId']);
        json(response, 201, backups.create(requestId(body.requestId)));
      } else if (/^\/api\/backups\/[^/]+\/[^/]+$/u.test(pathname) && request.method === 'GET') {
        const parts = pathname.split('/'); const file = backups.download(parts[3], parts[4]);
        response.writeHead(200, { 'Content-Type': file.type, 'Content-Disposition': `attachment; filename="${file.filename}"`, 'Content-Length': file.bytes.length }); response.end(file.bytes);
      } else if (pathname === '/api/ai/settings' && request.method === 'GET') {
        json(response, 200, reports.settings());
      } else if (pathname === '/api/ai/settings' && request.method === 'PUT') {
        const body = aiSettingsInput(await readBody()); json(response, 200, await aiOperation(() => reports.saveSettings(body.revision, body.settings, body.key, body.clearKey)));
      } else if (pathname === '/api/ai/test' && request.method === 'POST') {
        object(await readBody(), '连接测试', []); json(response, 200, await aiOperation(() => reports.testConnection()));
      } else if (/^\/api\/reports\/[^/]+\/(adopt|cancel)$/u.test(pathname) && request.method === 'POST') {
        const parts = pathname.split('/'); const id = decodeURIComponent(parts[3]);
        if (parts[4] === 'adopt') json(response, 200, reports.adopt(id, adoptionInput(await readBody())));
        else { object(await readBody(), '取消生成', []); json(response, 200, reports.cancel(id)); }
      } else if (request.method === 'POST' && pathname === '/api/setup') {
        const body = object(await readBody(), '初始化', ['requestId', 'timezone', 'availableMinutes', 'mode']);
        if (body.mode !== undefined && body.mode !== 'blank' && body.mode !== 'demo') throw new AppError(400, 'INVALID_INPUT', '请选择空白工作台。');
        if (body.mode === 'demo' && !options.demoWorkspace) throw new AppError(400, 'DEMO_ISOLATED', '请通过示例入口体验，示例与个人记录分开保存。');
        json(response, 200, store.setup(requestId(body.requestId), timezone(body.timezone), availableMinutes(body.availableMinutes), body.mode === 'demo' ? 'demo' : 'blank'));
      } else if (request.method === 'POST' && pathname === '/api/projects') {
        const body = object(await readBody(), '新增项目', ['requestId', 'project']);
        json(response, 201, store.createProject(requestId(body.requestId), projectInput(body.project)));
      } else if (request.method === 'PUT' && pathname === '/api/settings') {
        const body = object(await readBody(), '保存设置', ['revision', 'settings']);
        json(response, 200, store.updateSettings(integer(body.revision, '设置版本', 1), settingsInput(body.settings)));
      } else if (/^\/api\/projects\/[^/]+$/u.test(pathname)) {
        const id = decodeURIComponent(pathname.slice('/api/projects/'.length));
        if (request.method === 'GET') json(response, 200, { project: store.getProject(id) });
        else if (request.method === 'PUT') {
          const body = object(await readBody(), '编辑项目', ['revision', 'project']);
          json(response, 200, store.updateProject(id, integer(body.revision, '项目版本', 1), projectInput(body.project)));
        } else throw new AppError(405, 'METHOD_NOT_ALLOWED', '项目支持查看和更新；历史数据不能删除。');
      } else if (pathname.startsWith('/api/days/')) {
        const parts = pathname.slice('/api/days/'.length).split('/');
        const date = businessDate(parts[0]);
        if (parts.length === 1 && request.method === 'GET') json(response, 200, days.getState(date));
        else if (parts.length === 2 && parts[1] === 'schedule' && request.method === 'GET') json(response, 200, schedules.view(date));
        else if (parts.length === 3 && parts[1] === 'schedule' && parts[2] === 'save' && request.method === 'POST') json(response, 200, schedules.save(date, scheduleSaveWrite(await readBody())));
        else if (parts.length === 3 && parts[1] === 'schedule' && parts[2] === 'delete' && request.method === 'POST') json(response, 200, schedules.delete(date, scheduleDeleteWrite(await readBody())));
        else if (parts.length === 2 && parts[1] === 'inbox-promote' && request.method === 'POST') json(response, 200, inbox.promote(date, inboxPromoteWrite(await readBody())));
        else if (parts.length === 3 && parts[1] === 'reports' && request.method === 'GET') json(response, 200, reports.getView(date, reportType(parts[2])));
        else if (parts.length === 3 && parts[1] === 'reports' && request.method === 'POST') json(response, 202, reports.generate(date, reportType(parts[2]), generateInput(await readBody())));
        else if (parts.length === 2 && parts[1] === 'scores' && request.method === 'GET') json(response, 200, scores.getView(date));
        else if (parts.length === 2 && ['scores', 'settle'].includes(parts[1]) && request.method === 'POST') {
          const body = object(await readBody(), '评分与结算', ['requestId', 'revision']);
          json(response, 200, scores.write(date, { requestId: requestId(body.requestId), revision: integer(body.revision, '当天版本', 0) }, parts[1] === 'settle'));
        }
        else if (parts.length === 2 && parts[1] === 'draft' && request.method === 'PUT') json(response, 200, days.saveDraft(date, draftWrite(await readBody())));
        else if (parts.length === 2 && parts[1] === 'confirm' && request.method === 'POST') json(response, 200, days.confirm(date, confirmWrite(await readBody())));
        else if (parts.length === 2 && parts[1] === 'quick-task' && request.method === 'POST') json(response, 200, days.quickTask(date, quickTaskWrite(await readBody())));
        else if (parts.length === 2 && parts[1] === 'previous-plan' && request.method === 'GET') json(response, 200, days.previousPlan(date));
        else if (parts.length === 4 && parts[1] === 'tasks' && parts[2] && parts[3] === 'finish' && request.method === 'POST') {
          const input = finishWrite(await readBody());
          if (input.github_chapters?.length) throw new AppError(400, 'CONNECTOR_DISABLED', '此版本不提供远端章节采集，请手工记录成果。');
          json(response, 200, days.finish(date, parts[2], input));
        }
        else if (parts.length === 4 && parts[1] === 'tasks' && parts[2] && parts[3] === 'remove' && request.method === 'POST') json(response, 200, days.removeTask(date, parts[2], removeTaskWrite(await readBody())));
        else if (parts.length === 4 && parts[1] === 'tasks' && parts[3] === 'pin' && request.method === 'POST') {
          const body = object(await readBody(), '置顶任务', ['requestId','revision','pinned']); if (typeof body.pinned !== 'boolean') throw new AppError(400,'INVALID_INPUT','请选择置顶状态。');
          json(response, 200, days.pin(date, parts[2], { requestId: requestId(body.requestId), revision: integer(body.revision,'日期版本',0), pinned: body.pinned }));
        }
        else if (parts.length === 4 && parts[1] === 'events' && parts[3] === 'chapters' && request.method === 'POST') {
          const body = object(await readBody(), '核对章节', ['requestId','revision','chapters','merge']);
          if (!Array.isArray(body.chapters) || typeof body.merge !== 'boolean') throw new AppError(400,'INVALID_INPUT','请填写章节并选择合并方式。');
          json(response,200,days.identifyChapters(date,parts[2],{requestId:requestId(body.requestId),revision:integer(body.revision,'日期版本',0),chapters:body.chapters as number[],merge:body.merge}));
        }
        else if (parts.length === 2 && parts[1] === 'timer' && request.method === 'GET') json(response,200,timers.view(date));
        else if (parts.length === 2 && parts[1] === 'focus-import' && request.method === 'POST') {
          json(response, 200, focusImports.import(date, focusImportWrite(await readBody())));
        }
        else if (parts.length === 3 && parts[1] === 'timer' && request.method === 'POST') {
          const raw = await readBody();
          if (parts[2] === 'point') json(response, 200, timers.point(date, timerPointWrite(raw)));
          else if (parts[2] === 'period') json(response, 200, timers.period(date, timerPeriodWrite(raw)));
          else if (parts[2] === 'point-delete') json(response, 200, timers.deletePoint(date, timerPointDeleteWrite(raw)));
          else if (parts[2] === 'start') {
            const body = timerStartWrite(raw);
            const { block_id, ...input } = body;
            json(response, 200, timers.start(date, block_id, input));
          }
          else if (parts[2] === 'stop') json(response, 200, timers.stop(date, timerStopWrite(raw)));
          else throw new AppError(400,'INVALID_INPUT','请选择有效计时操作。');
        }
        else if (parts.length === 2 && parts[1] === 'events' && request.method === 'POST') json(response, 200, days.event(date, eventWrite(await readBody())));
        else if (parts.length === 2 && parts[1] === 'actuals' && request.method === 'PUT') json(response, 200, days.actual(date, actualWrite(await readBody())));
        else if (parts.length === 4 && parts[1] === 'tasks' && parts[2] && parts[3] === 'completion' && request.method === 'POST') json(response, 200, days.completion(date, parts[2], completionWrite(await readBody())));
        else if (parts.length === 4 && parts[1] === 'tasks' && parts[2] && parts[3] === 'status' && request.method === 'POST') json(response, 200, days.status(date, parts[2], statusWrite(await readBody())));
        else if (parts.length === 4 && parts[1] === 'tasks' && parts[2] && parts[3] === 'result' && request.method === 'POST') json(response, 200, days.result(date, parts[2], resultWrite(await readBody())));
        else if (parts.length === 4 && parts[1] === 'events' && parts[2] && parts[3] === 'correct' && request.method === 'POST') json(response, 200, days.correct(date, parts[2], correctionWrite(await readBody())));
        else throw new AppError(404, 'NOT_FOUND', '未找到该日期操作接口。');
      } else if (pathname.startsWith('/api/')) {
        throw new AppError(404, 'NOT_FOUND', '未找到此应用接口。');
      } else await staticFile(request, response, distDir);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof AppError) json(response, error.status, { error: { code: error.code, message: error.message } });
      else json(response, 500, { error: { code: 'INTERNAL_ERROR', message: '本地保存或读取未能完成，已有数据已保留。请稍后重试。' } });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;

  const application = {
    server,
    async listen(): Promise<{ port: number; url: string }> {
      if (closed) throw new Error('Application is closed.');
      try { await new Promise<void>((resolveListen, reject) => {
        const onError = (error: Error) => { server.off('listening', onListen); reject(error); };
        const onListen = () => { server.off('error', onError); resolveListen(); };
        server.once('error', onError);
        server.once('listening', onListen);
        server.listen(port, '127.0.0.1');
      }); } catch (error) { await application.close(); throw error; }
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Local server did not bind a TCP address.');
      boundPort = address.port;
      return { port: boundPort, url: `http://127.0.0.1:${boundPort}` };
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        const serverClosed = server.listening ? new Promise<void>((resolveClose, reject) => {
          server.close(error => error ? reject(error) : resolveClose()); server.closeIdleConnections();
        }) : Promise.resolve();
        let failure: unknown;
        const cleanup = async (work: () => Promise<unknown> | void) => { try { await work(); } catch (error) { failure ??= error; } };
        try {
          // Drain admitted request bodies before closing report jobs: a late POST may still create a job.
          await cleanup(() => serverClosed);
          await cleanup(() => reports.close());
          await cleanup(() => Promise.allSettled([...activeAi]));
          // Let sample initialization finish before closing its child service.
          await cleanup(() => demoConnection?.catch(() => undefined));
          await cleanup(() => demo?.close());
          if (options.demoWorkspace) await cleanup(() => pauseDemoTimer());
        } finally { try { store.close(); } finally { unlock(); } }
        if (failure) throw failure;
      })();
      return closePromise;
    },
  };
  return application;
}

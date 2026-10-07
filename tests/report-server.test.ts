import { testFetch } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp, PROJECT_ROOT } from '../server/app.ts';
import { ProviderError, localSummary, openAiProvider } from '../server/ai-provider.ts';
import type { AiProvider } from '../server/ai-provider.ts';
import { WindowsKeyVault } from '../server/ai-vault.ts';
import type { ReportInput, ReportView } from '../shared/report-contracts.ts';
import type { DayState } from '../shared/day-contracts.ts';

const root = resolve(PROJECT_ROOT, '.runtime/tests'); const date = '2026-09-18';
async function fixture(provider?: AiProvider, timeoutMs = 1000) {
  await mkdir(root, { recursive: true }); const folder = await mkdtemp(resolve(root, 'reports-')); let key: string | null = null;
  const vault = { has: () => !!key, async read() { return key; }, async save(value: string | null) { key = value; } };
  let app = createApp({ dataDir: folder, aiProvider: provider, keyVault: vault, aiTimeoutMs: timeoutMs }); let { url } = await app.listen(); let token = (await (await testFetch(url + '/api/session')).json()).csrfToken;
  async function call(method: string, path: string, body?: unknown) { const response = await testFetch(url + path, { method, headers: { Origin: url, 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() }; }
  const setup = await call('POST', '/api/setup', { requestId: randomUUID(), timezone: 'Asia/Shanghai', availableMinutes: 135 }); assert.equal(setup.status, 200);
  async function view(type = 'review'): Promise<ReportView> { const r = await call('GET', `/api/days/${date}/reports/${type}`); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
  async function generate(force = false, type = 'review') { const state = await view(type); const body = { requestId: randomUUID(), revision: state.revision, input_hash: state.input_hash, force }; return { ...(await call('POST', `/api/days/${date}/reports/${type}`, body)), request: body }; }
  async function finished(type = 'review') { for (let i = 0; i < 100; i++) { const state = await view(type); if (state.reports[0]?.status !== 'running') return state; await new Promise(resolve => setTimeout(resolve, 15)); } throw new Error('Report did not finish'); }
  async function online(limit = 10, withKey = true) { const config = (await call('GET', '/api/ai/settings')).body; const r = await call('PUT', '/api/ai/settings', { revision: config.revision, settings: { mode: 'openai', model: 'test-model', max_output_tokens: 2400, daily_call_limit: limit }, ...(withKey ? { key: 'sk-fake-test-only' } : {}), clear_key: false }); assert.equal(r.status, 200); assert.equal(JSON.stringify(r.body).includes('sk-fake'), false); }
  return { folder, call, view, generate, finished, online, setup: setup.body,
    async restart() { await app.close(); app = createApp({ dataDir: folder, aiProvider: provider, keyVault: vault, aiTimeoutMs: timeoutMs }); ({ url } = await app.listen()); token = (await (await testFetch(url + '/api/session')).json()).csrfToken; },
    async close() { await app.close(); assert.equal(dirname(folder), root); await rm(folder, { recursive: true, force: true }); },
  };
}

test('本地报告关联真实评分快照：读取不写库、请求去重、主动新版本、历史不可变、重启保留', async () => {
  const f = await fixture(); try {
    assert.equal((await f.view()).reports.length, 0); assert.equal((await f.call('GET', `/api/days/${date}`)).body.log, null);
    const first = await f.generate(); assert.equal(first.status, 202); let view = await f.finished(); const report = view.reports[0];
    assert.equal(report.status, 'degraded'); assert.equal(report.run_meta.fallback_reason, 'LOCAL_MODE'); assert.ok(report.score_id); assert.equal(report.plan_version, 0); assert.equal(report.stale, false); assert.equal(view.settings.calls_today, 0);
    assert.equal((await f.call('POST', `/api/days/${date}/reports/review`, first.request)).status, 202); assert.equal((await f.finished()).reports.length, 1);
    await f.generate(); assert.equal((await f.finished()).reports.length, 1); await f.generate(true); view = await f.finished(); assert.equal(view.reports.length, 2);
    await f.generate(false, 'plan'); assert.equal((await f.finished('plan')).reports[0].score_id, null);
    await f.restart(); assert.deepEqual((await f.view()).reports, view.reports);
    const db = new DatabaseSync(resolve(f.folder, 'personal-company.sqlite'));
    try { assert.throws(() => db.exec("UPDATE reports SET status='failed'")); assert.throws(() => db.exec('DELETE FROM reports')); const score = JSON.parse(String(db.prepare('SELECT calculation_json FROM scores WHERE id=?').get(report.score_id!)!.calculation_json)); assert.equal(score.reason, 'unplanned'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); } finally { db.close(); }
  } finally { await f.close(); }
});

test('采纳只追加草稿、测试连载平台共享不加倍、重复请求不复活、目标冲突和旧依据被拒绝', async () => {
  const f = await fixture(); try {
    await f.generate(false, 'plan'); const view = await f.finished('plan'); const report = view.reports[0]; const index = report.content!.suggestions.findIndex(s => f.setup.projects.find((p: any) => p.id === s.project_id)?.name === '示例连载乙');
    const body = { requestId: randomUUID(), target_date: '2026-09-19', target_revision: 0, suggestion_index: index, action: '测试：检查示例连载乙发布回执', acceptance: '隔离测试：指定回执已核对', estimated_minutes: null, dimension: 'cashflow', change_reason: '' };
    const adopted = await f.call('POST', `/api/reports/${report.id}/adopt`, body); assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
    const day: DayState = (await f.call('GET', '/api/days/2026-09-19')).body; assert.equal(day.log!.current_plan_version, 0); assert.equal(day.tasks.length, 0); assert.equal(day.log!.draft_plan!.tasks.length, 1); assert.equal(day.log!.draft_plan!.work_blocks.reduce((n, b) => n + (b.budget_minutes ?? 0), 0), 15);
    assert.equal(day.log!.draft_plan!.tasks.at(-1)!.raw_points, 0);
    assert.equal((await f.call('POST', `/api/reports/${report.id}/adopt`, { ...body, requestId: randomUUID() })).status, 200); assert.equal((await f.call('GET', '/api/days/2026-09-19')).body.log.revision, 1);
    assert.equal((await f.call('POST', `/api/reports/${report.id}/adopt`, { ...body, suggestion_index: 0, requestId: randomUUID() })).status, 409);
    const { id, revision, created_at, updated_at, ...project } = f.setup.projects[0]; await f.call('PUT', `/api/projects/${id}`, { revision, project: { ...project, status: 'paused' } });
    assert.equal((await f.view('plan')).reports[0].stale, true); assert.equal((await f.call('POST', `/api/reports/${report.id}/adopt`, { ...body, suggestion_index: 0, target_revision: 1, requestId: randomUUID() })).body.error.code, 'STALE_REPORT');
  } finally { await f.close(); }
});

test('在线成功、引用核对、费用未知、相同输入不重复调用；错误引用降级且保留原事实', async () => {
  let calls = 0; let bad = false; let received: ReportInput | undefined;
  const f = await fixture(async input => { calls++; received = input; const content = localSummary(input); if (bad) content.gaps[0].source_ids = ['invented-id']; return { content, input_tokens: 100, output_tokens: 50 }; });
  try {
    await f.online(); await f.generate(); let view = await f.finished(); assert.equal(view.reports[0].status, 'succeeded'); assert.equal(view.reports[0].run_meta.input_tokens, 100); assert.equal(view.reports[0].run_meta.cost_estimate, null); assert.equal(JSON.stringify(received).includes('sk-fake'), false);
    await f.generate(); await f.finished(); assert.equal(calls, 1); bad = true; await f.generate(true); view = await f.finished(); assert.equal(view.reports[0].status, 'degraded'); assert.equal(view.reports[0].run_meta.fallback_reason, 'INVALID_REFERENCES'); assert.equal(JSON.stringify(view.reports[0].content).includes('invented-id'), false); assert.equal(view.reports[1].status, 'succeeded');
  } finally { await f.close(); }
});

test('已有结算计划采纳建议只改调整草稿，需理由，不改分数和原快照', async () => {
  const f = await fixture(); try {
    let day: DayState = (await f.call('GET', `/api/days/${date}`)).body;
    const draft = day.suggested_draft; draft.tasks = draft.tasks.map(task => ({ ...task, result_type: 'binary', metric_key: null, target_value: 1, acceptance: '隔离测试原承诺' }));
    assert.equal((await f.call('POST', `/api/days/${date}/confirm`, { requestId: randomUUID(), revision: 0, draft, acknowledgeOverCapacity: false })).status, 200);
    day = (await f.call('GET', `/api/days/${date}`)).body;
    for (const task of day.tasks) { const result = await f.call('POST', `/api/days/${date}/tasks/${task.task_id}/result`, { requestId: randomUUID(), revision: day.log!.revision, clear: false, binary_value: 1, explanation: '测试验收' }); assert.equal(result.status, 200); day = result.body; }
    assert.equal((await f.call('POST', `/api/days/${date}/settle`, { requestId: randomUUID(), revision: day.log!.revision })).status, 200);
    const before = (await f.call('GET', `/api/days/${date}/scores`)).body; day = (await f.call('GET', `/api/days/${date}`)).body;
    await f.generate(false, 'plan'); const report = (await f.finished('plan')).reports[0];
    const body = { requestId: randomUUID(), target_date: date, target_revision: day.log!.revision, suggestion_index: 0, action: '测试新增复核', acceptance: '指定对象复核完成', estimated_minutes: null, dimension: 'cashflow', change_reason: '' };
    assert.equal((await f.call('POST', `/api/reports/${report.id}/adopt`, body)).status, 400);
    assert.equal((await f.call('POST', `/api/reports/${report.id}/adopt`, { ...body, change_reason: '补入待考虑的后续核对' })).status, 200);
    const after: DayState = (await f.call('GET', `/api/days/${date}`)).body;
    assert.equal(after.log!.record_state, 'complete'); assert.deepEqual(after.log!.plan_snapshots, day.log!.plan_snapshots); assert.equal(after.tasks.length, 6); assert.equal(after.log!.draft_plan!.tasks.length, 7);
    assert.equal((await f.call('GET', `/api/days/${date}/scores`)).body.current_score_id, before.current_score_id);
    assert.equal(after.log!.draft_plan!.work_blocks.reduce((sum, block) => sum + (block.budget_minutes ?? 0), 0), 135);
  } finally { await f.close(); }
});

test('缺密钥、有限重试和每日次数预算：不得隐式调用或暴露服务原始错误', async () => {
  let calls = 0; const f = await fixture(async () => { calls++; throw new ProviderError('HTTP_503', true); });
  try {
    await f.online(1, false); await f.generate(); let view = await f.finished(); assert.equal(view.reports[0].run_meta.fallback_reason, 'KEY_NOT_CONFIGURED'); assert.equal(calls, 0);
    await f.online(1); await f.generate(); view = await f.finished(); assert.equal(view.reports[0].run_meta.fallback_reason, 'DAILY_LIMIT'); assert.equal(calls, 1); assert.equal(view.settings.calls_today, 1);
    assert.equal((await f.call('POST', '/api/ai/test', {})).body.error.code, 'DAILY_LIMIT');
  } finally { await f.close(); }
});

test('生成并发、取消、超时、生成中更正及旧请求重放：不覆盖新事实', async () => {
  let release: (() => void) | undefined; let invocations = 0;
  const f = await fixture(async (input, _config, _key, signal) => { invocations++; await new Promise<void>((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(new ProviderError('ABORTED')), { once: true }); }); return { content: localSummary(input), input_tokens: 30, output_tokens: 20 }; }, 100);
  try {
    await f.online(); const original = await f.generate(); assert.equal(original.status, 202); const running = (await f.view()).reports[0]; assert.equal((await f.generate(true)).status, 409);
    assert.equal((await f.call('POST', `/api/days/${date}/reports/review`, original.request)).status, 202); assert.equal(invocations, 1);
    await f.call('POST', `/api/reports/${running.id}/cancel`, {}); let view = await f.finished(); assert.equal(view.reports[0].run_meta.fallback_reason, 'CANCELLED');
    await f.generate(true); view = await f.finished(); assert.equal(view.reports[0].run_meta.fallback_reason, 'TIMEOUT');
    await f.generate(true); const { id, revision, created_at, updated_at, ...project } = f.setup.projects[0]; await f.call('PUT', `/api/projects/${id}`, { revision, project: { ...project, next_action: '新增真实安排' } }); release!(); view = await f.finished(); assert.equal(view.reports[0].stale, true); assert.equal(view.reports[0].status, 'succeeded');
  } finally { release?.(); await f.close(); }
});

test('遗留运行记录在重启时恢复为失败；终态不再被改写', async () => {
  const f = await fixture(); try {
    await f.generate(); const report = (await f.finished()).reports[0];
    const db = new DatabaseSync(resolve(f.folder, 'personal-company.sqlite'));
    try { const row = db.prepare('SELECT * FROM reports WHERE id=?').get(report.id)!; const now = new Date().toISOString(); const meta = JSON.parse(String(row.run_meta_json)); meta.request_id = randomUUID(); meta.finished_at = null;
      db.prepare('INSERT INTO reports(id,daily_log_id,report_type,report_version,plan_version,score_id,input_hash,input_snapshot_json,status,run_meta_json,owner_pid,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), row.daily_log_id!, 'review', 2, 0, row.score_id!, row.input_hash!, row.input_snapshot_json!, 'running', JSON.stringify(meta), 99999999, '2000-01-01T00:00:00Z', now, now);
    } finally { db.close(); }
    await f.restart(); const view = await f.view(); assert.equal(view.reports[0].status, 'failed'); assert.equal(view.reports[0].run_meta.fallback_reason, 'INTERRUPTED'); assert.equal(view.reports[1].status, 'degraded');
  } finally { await f.close(); }
});

test('官方适配器使用 Responses 结构化输出；不跟随重定向、不保存响应，解析真实响应外形', async () => {
  const original = globalThis.fetch; let body: any; let options: RequestInit | undefined;
  const input: ReportInput = { schema_version: 1, prompt_version: 'ceo-v1', date, timezone: 'Asia/Shanghai', type: 'review', projects: [], facts: [{ id: 'scope', text: '测试' }], fingerprint: 'test', config_revision: 1 };
  try {
    globalThis.fetch = (async (url, init) => { assert.equal(url, 'https://api.openai.com/v1/responses'); options = init; body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(localSummary(input)) }] }], usage: { input_tokens: 10, output_tokens: 20 } }), { status: 200 }); }) as typeof fetch;
    const result = await openAiProvider(input, { mode: 'openai', model: 'test-model', max_output_tokens: 1000, daily_call_limit: 5 }, 'fake-test-key', new AbortController().signal);
    assert.equal(body.store, false); assert.equal(body.text.format.type, 'json_schema'); assert.equal(body.text.format.strict, true); assert.equal(options?.redirect, 'error'); assert.equal(result.output_tokens, 20);
  } finally { globalThis.fetch = original; }
});

test('Windows 密钥文件为当前用户加密，重开后可读取；配置接口不返回明文', { skip: process.platform !== 'win32' }, async () => {
  await mkdir(root, { recursive: true }); const folder = await mkdtemp(resolve(root, 'vault-')); const path = resolve(folder, 'key.dpapi');
  try { const vault = new WindowsKeyVault(path, false); await vault.save('fake-only-not-a-real-key'); assert.equal((await readFile(path, 'utf8')).includes('fake-only'), false); assert.equal(await new WindowsKeyVault(path, true).read(), 'fake-only-not-a-real-key'); } finally { assert.equal(dirname(folder), root); await rm(folder, { recursive: true, force: true }); }
});

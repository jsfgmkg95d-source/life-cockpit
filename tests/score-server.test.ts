import { setUnequalTestWeights, testFetch } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp, PROJECT_ROOT } from '../server/app.ts';
import type { DayState, PlanDraft } from '../shared/day-contracts.ts';
import type { ScoreView } from '../shared/score-contracts.ts';

const root = resolve(PROJECT_ROOT, '.runtime/tests');
async function fixture() {
  await mkdir(root, { recursive: true }); const folder = await mkdtemp(resolve(root, 'scores-'));
  let app = createApp({ dataDir: folder }); let { url } = await app.listen(); let token = (await (await testFetch(`${url}/api/session`)).json()).csrfToken;
  const date = '2026-09-18'; const base = `/api/days/${date}`;
  async function call(method: string, path: string, body?: unknown) { const response = await testFetch(url + path, { method, headers: { Origin: url, 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() }; }
  await call('POST', '/api/setup', { requestId: randomUUID(), timezone: 'Asia/Shanghai', availableMinutes: 135 });
  const read = async (): Promise<DayState> => (await call('GET', base)).body;
  const view = async (): Promise<ScoreView> => (await call('GET', base + '/scores')).body;
  async function write(path: string, body: object = {}, method = 'POST') { const day = await read(); return call(method, base + path, { requestId: randomUUID(), revision: day.log?.revision ?? 0, ...body }); }
  return { folder, call, read, view, write, base,
    async restart() { await app.close(); app = createApp({ dataDir: folder }); ({ url } = await app.listen()); token = (await (await testFetch(`${url}/api/session`)).json()).csrfToken; },
    async close() { await app.close(); assert.equal(dirname(folder), root); await rm(folder, { recursive: true, force: true }); },
  };
}
function draftOf(day: DayState): PlanDraft { const plan = day.log?.plan_snapshots.at(-1); return plan ? { day_mode: plan.day_mode, available_minutes: plan.available_minutes, dimensions: plan.dimensions, tasks: plan.tasks.map(({ project_name, ...task }) => task), work_blocks: plan.work_blocks, change_reason: '测试目标调整', notes: plan.notes } : day.suggested_draft; }

test('评分全流程：未知、显式零、结算、事实更正、原计划对照、重启与不可变历史', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.view()).preview.reason, 'unplanned'); assert.equal((await f.read()).log, null);
    assert.equal((await f.write('/settle')).status, 400); assert.equal((await f.read()).log, null);
    let draft = setUnequalTestWeights(draftOf(await f.read())); draft.available_minutes = 135;
    draft.tasks = draft.tasks.map((task, i) => ({ ...task, acceptance: '隔离测试验收', result_type: i ? 'binary' : 'quant', target_value: i ? 1 : 1000, metric_key: i ? null : 'accepted_words' }));
    assert.equal((await f.write('/confirm', { draft, acknowledgeOverCapacity: false })).status, 200);
    let view = await f.view(); assert.equal(view.preview.coverage_basis_points, 0); assert.equal(view.preview.upper_bound, 10000);
    await f.write('/scores'); assert.equal((await f.view()).history.length, 1);
    const allTasks = (await f.read()).tasks;
    const quant = allTasks.find(task => task.result_type === 'quant')!;
    await f.write('/events', { event: { project_id: quant.project_id, task_id: quant.task_id, artifact_key: 'qa-chapter', metric_key: 'accepted_words', value: 1000, stage: 'finalized', summary: '隔离测试成果', source: '测试用户确认' } });
    for (const task of allTasks.slice(0, -1)) assert.equal((await f.write(`/tasks/${task.task_id}/result`, { clear: false, binary_value: task.result_type === 'quant' ? null : task.project_name === '示例专栏乙' ? 0 : 1, explanation: '测试结果' })).status, 200);
    view = await f.view(); assert.equal(view.preview.display.lower, '81.3'); assert.equal(view.preview.display.coverage, '93.8'); assert.equal(view.preview.display.upper, '87.5');
    assert.equal((await f.write('/settle')).status, 400);
    await f.write(`/tasks/${allTasks.at(-1)!.task_id}/result`, { clear: false, binary_value: 1, explanation: '测试结果' });
    assert.equal((await f.view()).preview.status, 'provisional'); assert.equal((await f.view()).preview.final_score, null);
    const body = { requestId: randomUUID(), revision: (await f.read()).log!.revision };
    const settled = await f.call('POST', f.base + '/settle', body); assert.equal(settled.status, 200);
    view = settled.body; assert.equal(view.preview.final_score, 8750); const saved = view.history[0];
    assert.equal((await f.call('POST', f.base + '/settle', body)).body.history.length, 2);
    assert.equal((await f.call('POST', f.base + '/settle', { ...body, requestId: randomUUID() })).status, 409);
    await f.write('/scores'); assert.equal((await f.view()).history.length, 2);
    await f.write(`/tasks/${quant.task_id}/status`, { status: 'cancelled' }); assert.equal((await f.view()).current_score_id, saved.id);
    await f.write('/draft', { draft: draftOf(await f.read()) }, 'PUT'); assert.equal((await f.view()).current_score_id, saved.id);
    const event = (await f.read()).events[0];
    await f.write(`/events/${event.id}/correct`, { kind: 'replace', value: 500, stage: 'finalized', summary: '核对后实际500', source: '测试更正', reason: '原数有误' });
    view = await f.view(); assert.equal(view.current_score_id, null); assert.equal(view.preview.final_score, null); assert.equal(view.history.find(item => item.id === saved.id)!.final_score, 8750);
    await f.write(`/tasks/${quant.task_id}/result`, { clear: false, binary_value: null, explanation: '确认更正数量' });
    await f.write('/settle'); assert.equal((await f.view()).preview.final_score, 6875);
    draft = draftOf(await f.read()); draft.tasks.find(task => task.task_id === quant.task_id)!.target_value = 500;
    await f.write('/confirm', { draft, acknowledgeOverCapacity: false });
    view = await f.view(); assert.equal(view.preview.lower_bound, 8750); assert.equal(view.comparisons[0].score.lower_bound, 6875); assert.equal(view.preview.final_score, null);
    await f.write('/settle'); view = await f.view();
    await f.restart(); assert.deepEqual(await f.view(), view);
    const db = new DatabaseSync(resolve(f.folder, 'personal-company.sqlite'));
    try { assert.throws(() => db.exec('UPDATE scores SET plan_version=99')); assert.throws(() => db.exec('DELETE FROM scores')); assert.throws(() => db.exec("UPDATE score_policies SET name='changed'")); assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); } finally { db.close(); }
  } finally { await f.close(); }
});

test('无计划可留不计分版本；休息日结算无分数；拒绝客户端指定分数', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.write('/scores')).status, 200); let view = await f.view(); assert.equal(view.preview.reason, 'unplanned'); assert.equal(view.history.length, 1);
    const draft = draftOf(await f.read()); draft.day_mode = 'rest'; draft.tasks = []; draft.work_blocks = []; for (const item of Object.values(draft.dimensions)) { item.applicable = false; item.reason = '休息'; }
    await f.write('/confirm', { draft, acknowledgeOverCapacity: false }); assert.equal((await f.view()).can_settle, true);
    await f.write('/settle'); view = await f.view(); assert.equal(view.preview.reason, 'rest'); assert.equal(view.preview.final_score, null); assert.equal(view.preview.coverage_basis_points, null); assert.ok(view.current_score_id); assert.equal((await f.read()).log!.record_state, 'complete');
    const invalid = await f.call('POST', f.base + '/settle', { requestId: randomUUID(), revision: view.revision, final_score: 100 }); assert.equal(invalid.status, 400);
  } finally { await f.close(); }
});

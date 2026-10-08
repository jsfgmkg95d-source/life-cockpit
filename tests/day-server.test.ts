import { testFetch } from './fixtures/workspace.ts';
import { projectProgress, projectStageLabel } from '../shared/project-progress.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppState, Project } from '../shared/contracts.ts';
import type { DayState, EventInput, PlanDraft } from '../shared/day-contracts.ts';
import { createApp, PROJECT_ROOT } from '../server/app.ts';

const TEST_ROOT = resolve(PROJECT_ROOT, '.runtime', 'tests');
const DATE = '2026-09-17';

async function fixture() {
  await mkdir(TEST_ROOT, { recursive: true });
  const folder = await mkdtemp(resolve(TEST_ROOT, 'day-server-'));
  const dataDir = resolve(folder, 'data');
  const app = createApp({ dataDir, port: 0 });
  const { url } = await app.listen();
  const token = (await (await testFetch(`${url}/api/session`)).json()).csrfToken as string;
  async function call(method: string, path: string, body?: unknown) {
    const response = await testFetch(`${url}${path}`, { method, headers: { Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  const setup = await call('POST', '/api/setup', { requestId: randomUUID(), timezone: 'Asia/Shanghai', availableMinutes: 180 });
  assert.equal(setup.status, 200);
  return {
    call, initial: setup.body as AppState, dataDir,
    async read(date = DATE): Promise<DayState> { const result = await call('GET', `/api/days/${date}`); assert.equal(result.status, 200); return result.body as DayState; },
    async write(path: string, payload: object, date = DATE, method = 'POST') { const state = (await call('GET', `/api/days/${date}`)).body as DayState; return call(method, `/api/days/${date}${path}`, { requestId: randomUUID(), revision: state.log?.revision ?? 0, ...payload }); },
    async cleanup() { await app.close(); assert.equal(dirname(folder), TEST_ROOT); await rm(folder, { recursive: true, force: true }); },
  };
}

function plan(projects: Project[]): PlanDraft {
  return {
    day_mode: 'work', available_minutes: 60,
    dimensions: { cashflow: { applicable: true, reason: '' }, asset: { applicable: false, reason: '今天未安排' }, health: { applicable: false, reason: '今天未安排' }, learning: { applicable: false, reason: '今天未安排' } },
    tasks: [
      { candidate_id: 'candidate-a', task_id: null, project_id: projects[0].id, title: '完成测试正文', acceptance: '已验收指定章节正文', result_type: 'quant', metric_key: 'accepted_words', target_value: 1000, scoring_dimension: 'cashflow', raw_points: 25, estimated_minutes: null, work_block_id: 'block-shared' },
      { candidate_id: 'candidate-b', task_id: null, project_id: projects[1].id, title: '完成测试核对', acceptance: '指定清单全部核对', result_type: 'binary', metric_key: null, target_value: 1, scoring_dimension: 'cashflow', raw_points: 25, estimated_minutes: null, work_block_id: 'block-shared' },
    ], work_blocks: [{ id: 'block-shared', title: '两项目共用时段', budget_minutes: 20 }], change_reason: '', notes: '',
  };
}

function draftFrom(state: DayState): PlanDraft {
  const snapshot = state.log!.plan_snapshots.at(-1)!;
  return {
    day_mode: snapshot.day_mode, available_minutes: snapshot.available_minutes, dimensions: structuredClone(snapshot.dimensions), work_blocks: structuredClone(snapshot.work_blocks), change_reason: '实际安排调整', notes: snapshot.notes,
    tasks: snapshot.tasks.map(({ project_name, ...task }) => ({ ...task })),
  };
}

function event(state: DayState, overrides: Partial<EventInput> = {}): EventInput {
  const task = state.tasks.find((item) => item.result_type === 'quant' && item.eligible)!;
  return { project_id: task.project_id, task_id: task.task_id, artifact_key: 'chapter-001', metric_key: 'accepted_words', value: 1000, stage: 'finalized', summary: '测试章节已验收', source: '用户确认的验收记录', ...overrides };
}

test('空日期GET不写库、候选稳定且未知不伪造；旧日期时区固定，暂停项目不自动候选', async () => {
  const f = await fixture();
  try {
    const initial = await f.read();
    assert.equal(initial.log, null);
    assert.deepEqual((await f.read()).suggested_draft, initial.suggested_draft);
    assert.equal(initial.suggested_draft.tasks.length, 6);
    assert.equal(initial.suggested_draft.work_blocks.reduce((sum, block) => sum + (block.budget_minutes ?? 0), 0), 135);
    assert.ok(initial.suggested_draft.tasks.every((task) => task.acceptance === ''));
    const database = new DatabaseSync(resolve(f.dataDir, 'personal-company.sqlite'), { readOnly: true });
    try { assert.equal(database.prepare('SELECT count(*) AS count FROM daily_logs').get()!.count, 0); } finally { database.close(); }
    const saved = await f.write('/draft', { draft: initial.suggested_draft }, DATE, 'PUT');
    assert.equal(saved.status, 200); assert.equal(saved.body.log.revision, 1);
    const { revision, ...settings } = f.initial.settings;
    assert.equal((await f.call('PUT', '/api/settings', { revision, settings: { ...settings, timezone: 'UTC' } })).status, 200);
    assert.equal((await f.read()).timezone, 'Asia/Shanghai');
    assert.equal((await f.read('2026-09-18')).timezone, 'UTC');
    const { id, revision: pr, created_at, updated_at, ...project } = f.initial.projects[0];
    await f.call('PUT', `/api/projects/${id}`, { revision: pr, project: { ...project, status: 'paused' } });
    assert.ok(!(await f.read()).suggested_draft.tasks.some((task) => task.project_id === id));
    assert.equal((await f.call('GET', '/api/days/2026-02-30')).status, 400);
  } finally { await f.cleanup(); }
});

test('确认自动分配权重且仍阻止不完整计划与超容量，失败原子回滚；草稿不覆盖原计划', async () => {
  const f = await fixture();
  try {
    const original = plan(f.initial.projects);
    const malformed: PlanDraft[] = [
      { ...original, available_minutes: null },
      { ...original, tasks: original.tasks.map((task, index) => index === 0 ? { ...task, acceptance: '' } : task) },
      { ...original, tasks: original.tasks.map((task, index) => index === 0 ? { ...task, target_value: 0 } : task) },
      { ...original, tasks: original.tasks.map((task, index) => index === 0 ? { ...task, work_block_id: 'missing' } : task) },
      { ...original, work_blocks: [{ ...original.work_blocks[0], budget_minutes: null }] },
      { ...original, available_minutes: 10 },
    ];
    for (const draft of malformed) {
      assert.equal((await f.write('/confirm', { draft, acknowledgeOverCapacity: false })).status, 400);
      assert.equal((await f.read()).log, null);
    }
    const confirmed = await f.write('/confirm', { draft: { ...original, available_minutes: 10, tasks: original.tasks.map((task, index) => index === 0 ? { ...task, raw_points: 24 } : task) }, acknowledgeOverCapacity: true });
    assert.equal(confirmed.status, 200);
    const state = confirmed.body as DayState;
    assert.equal(state.log!.current_plan_version, 1);
    assert.equal(state.log!.plan_snapshots[0].over_capacity_acknowledged, true);
    assert.equal(state.tasks.length, 2);
    assert.deepEqual(state.tasks.map(task => task.raw_points), [24, 26]);
    const originalSnapshot = structuredClone(state.log!.plan_snapshots[0]);
    const changed = draftFrom(state); changed.tasks[0].target_value = 500;
    const draftSave = await f.write('/draft', { draft: changed }, DATE, 'PUT');
    assert.equal(draftSave.status, 200);
    assert.equal(draftSave.body.tasks[0].target_value, 1000);
    assert.deepEqual(draftSave.body.log.plan_snapshots[0], originalSnapshot);
    assert.equal((await f.write('/confirm', { draft: { ...changed, change_reason: '' }, acknowledgeOverCapacity: true })).status, 400);
    const version2 = await f.write('/confirm', { draft: changed, acknowledgeOverCapacity: true });
    assert.equal(version2.status, 200);
    assert.equal(version2.body.tasks[0].task_id, state.tasks[0].task_id);
    assert.equal(version2.body.tasks[0].target_value, 500);
    assert.deepEqual(version2.body.log.plan_snapshots[0], originalSnapshot);
    assert.equal(version2.body.log.current_plan_version, 2);
    assert.equal(version2.body.log.draft_plan, null);
  } finally { await f.cleanup(); }
});

test('幂等重试返回最新日期状态，不重复写；相同请求不同内容和旧revision冲突', async () => {
  const f = await fixture();
  try {
    const payload = { requestId: randomUUID(), revision: 0, draft: plan(f.initial.projects), acknowledgeOverCapacity: false };
    const confirmed = await f.call('POST', `/api/days/${DATE}/confirm`, payload);
    assert.equal(confirmed.status, 200);
    const state = confirmed.body as DayState;
    const changed = await f.write(`/tasks/${state.tasks[0].task_id}/status`, { status: 'doing' });
    assert.equal(changed.status, 200);
    const retry = await f.call('POST', `/api/days/${DATE}/confirm`, payload);
    assert.deepEqual(retry.body, changed.body);
    assert.equal(retry.body.log.plan_snapshots.length, 1);
    assert.equal((await f.call('POST', `/api/days/${DATE}/confirm`, { ...payload, acknowledgeOverCapacity: true })).status, 409);
    assert.equal((await f.call('PUT', `/api/days/${DATE}/draft`, { requestId: randomUUID(), revision: 0, draft: payload.draft })).status, 409);
  } finally { await f.cleanup(); }
});

test('操作done不等验收；明确零、部分数量、二值达成和恢复unknown相互独立', async () => {
  const f = await fixture();
  try {
    const state = (await f.write('/confirm', { draft: plan(f.initial.projects), acknowledgeOverCapacity: false })).body as DayState;
    const quant = state.tasks[0], binary = state.tasks[1];
    const done = await f.write(`/tasks/${quant.task_id}/status`, { status: 'done' });
    assert.equal(done.body.tasks[0].result_state, 'unknown');
    const zero = await f.write(`/tasks/${quant.task_id}/result`, { binary_value: null, explanation: '确认今天没有验收量', clear: false });
    assert.equal(zero.body.tasks[0].confirmed_result.actual_value, 0);
    assert.equal(zero.body.tasks[0].result_state, 'confirmed');
    assert.equal((await f.write(`/tasks/${quant.task_id}/result`, { binary_value: 1, explanation: '', clear: false })).status, 400);
    const result = await f.write(`/tasks/${binary.task_id}/result`, { binary_value: 1, explanation: '按约定核对完成', clear: false });
    assert.equal(result.body.tasks[1].confirmed_result.actual_value, 1);
    assert.equal(result.body.events.length, 0);
    const recorded = await f.write('/events', { event: event(state, { value: 400 }) });
    assert.equal(recorded.body.tasks[0].result_state, 'unknown');
    const partial = await f.write(`/tasks/${quant.task_id}/result`, { binary_value: null, explanation: '', clear: false });
    assert.equal(partial.body.tasks[0].confirmed_result.actual_value, 400);
    const cleared = await f.write(`/tasks/${quant.task_id}/result`, { binary_value: null, explanation: '', clear: true });
    assert.equal(cleared.body.tasks[0].result_state, 'unknown');
    assert.equal(cleared.body.tasks[0].confirmed_result, null);
    assert.equal(cleared.body.tasks[0].status, 'done');
    assert.equal(cleared.body.log.record_state, 'incomplete');
  } finally { await f.cleanup(); }
});

test('成果按业务身份去重，阶段不放大字数；跨日期/项目/指标绑定严格拒绝', async () => {
  const f = await fixture();
  try {
    const state = (await f.write('/confirm', { draft: plan(f.initial.projects), acknowledgeOverCapacity: false })).body as DayState;
    const payload = { requestId: randomUUID(), revision: state.log!.revision, event: event(state) };
    const first = await f.call('POST', `/api/days/${DATE}/events`, payload);
    assert.equal(first.status, 200);
    assert.equal(first.body.events[0].occurred_on, DATE);
    assert.equal(first.body.events[0].occurrence_precision, 'date');
    assert.equal((await f.call('POST', `/api/days/${DATE}/events`, payload)).body.events.length, 1);
    assert.equal((await f.write('/events', { event: event(state, { stage: 'published' }) })).status, 409);
    assert.equal((await f.write('/events', { event: event(state, { task_id: null }) }, '2026-09-18')).status, 409);
    assert.equal((await f.read('2026-09-18')).log, null);
    assert.equal((await f.write('/events', { event: event(state, { artifact_key: 'other-chapter' }) }, '2026-09-18')).status, 404);
    assert.equal((await f.write('/events', { event: event(state, { artifact_key: 'other', project_id: f.initial.projects[1].id }) })).status, 400);
    assert.equal((await f.write('/events', { event: event(state, { artifact_key: 'other', metric_key: 'published_chapters', stage: 'published' }) })).status, 400);
    assert.equal((await f.write('/events', { event: event(state, { task_id: null, artifact_key: 'public-01', metric_key: 'published_chapters', stage: 'submitted', value: 1 }) })).status, 400);
    assert.equal((await f.write('/events', { event: event(state, { task_id: null, artifact_key: 'batch-01', metric_key: 'submission_batches', stage: 'submitted', value: 1, source: '' }) })).status, 400);
    const publication = await f.write('/events', { event: event(state, { task_id: null, metric_key: 'published_chapters', stage: 'published', value: 1 }) });
    assert.equal(publication.status, 200);
    assert.equal(publication.body.effective_events.filter((item: { metric_key: string }) => item.metric_key === 'accepted_words').length, 1);
  } finally { await f.cleanup(); }
});

test('更正链只取末端、撤销可恢复、原值不可覆盖，冲突更正和身份修改被拒绝', async () => {
  const f = await fixture();
  try {
    const state = (await f.write('/confirm', { draft: plan(f.initial.projects), acknowledgeOverCapacity: false })).body as DayState;
    const first = (await f.write('/events', { event: event(state) })).body as DayState;
    const root = first.events[0];
    await f.write(`/tasks/${state.tasks[0].task_id}/result`, { binary_value: null, explanation: '', clear: false });
    const correction = { kind: 'replace', value: 800, stage: 'finalized', summary: '核对后实际800字', source: '用户重新核对', reason: '原计数错误' };
    const corrected = (await f.write(`/events/${root.id}/correct`, correction)).body as DayState;
    assert.equal(corrected.events[0].value, 1000);
    assert.equal(corrected.effective_events.length, 1);
    assert.equal(corrected.effective_events[0].value, 800);
    assert.equal(corrected.effective_events[0].occurred_on, DATE);
    assert.equal(corrected.tasks[0].result_state, 'unknown');
    const conflict = await f.write(`/events/${root.id}/correct`, correction);
    assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'EVENT_NOT_LATEST');
    const latest = corrected.effective_events[0];
    assert.equal((await f.write(`/events/${latest.id}/correct`, { ...correction, task_id: null })).status, 400);
    const removed = (await f.write(`/events/${latest.id}/correct`, { ...correction, kind: 'void', value: null })).body as DayState;
    assert.equal(removed.effective_events.length, 0);
    const restored = (await f.write(`/events/${removed.events.at(-1)!.id}/correct`, { ...correction, value: 500 })).body as DayState;
    assert.equal(restored.events.length, 4);
    assert.equal(restored.effective_events.length, 1);
    assert.equal(restored.effective_events[0].value, 500);
    assert.equal(restored.effective_events[0].root_event_id, root.id);
    const database = new DatabaseSync(resolve(f.dataDir, 'personal-company.sqlite'));
    try { assert.throws(() => database.prepare('UPDATE asset_events SET value=99 WHERE id=?').run(root.id), /immutable/u); } finally { database.close(); }
  } finally { await f.cleanup(); }
});

test('历史投入块和实际时间保留；成员改变自动新块，0与未知null分开且不均分', async () => {
  const f = await fixture();
  try {
    const state = (await f.write('/confirm', { draft: plan(f.initial.projects), acknowledgeOverCapacity: false })).body as DayState;
    const zero = await f.write('/actuals', { block_id: 'block-shared', minutes: 0, source: '用户确认尚未投入' }, DATE, 'PUT');
    assert.equal(zero.body.log.work_block_actuals[0].minutes, 0);
    const unknown = await f.write('/actuals', { block_id: 'block-shared', minutes: null, source: '撤回未核实用时' }, DATE, 'PUT');
    assert.deepEqual(unknown.body.log.work_block_actuals, []);
    await f.write('/actuals', { block_id: 'block-shared', minutes: 18, source: '整段计时' }, DATE, 'PUT');
    const changed = draftFrom(state); changed.tasks[0].acceptance = '另一组不同章节通过验收';
    const version2 = (await f.write('/confirm', { draft: changed, acknowledgeOverCapacity: false })).body as DayState;
    const latest = version2.log!.plan_snapshots.at(-1)!;
    assert.notEqual(latest.tasks[0].task_id, state.tasks[0].task_id);
    assert.notEqual(latest.work_blocks[0].id, 'block-shared');
    assert.equal(version2.log!.work_block_actuals[0].minutes, 18);
    assert.equal(version2.tasks.filter((task) => task.eligible).length, 2);
    assert.equal(version2.tasks.length, 3);
    assert.ok(version2.tasks.every((task) => task.estimated_minutes === null));
    const rest: PlanDraft = { ...changed, day_mode: 'rest', tasks: [], work_blocks: [], dimensions: { cashflow: { applicable: false, reason: '计划休息' }, asset: { applicable: false, reason: '计划休息' }, health: { applicable: false, reason: '计划休息' }, learning: { applicable: false, reason: '计划休息' } } };
    const resting = (await f.write('/confirm', { draft: rest, acknowledgeOverCapacity: false })).body as DayState;
    assert.equal(resting.log!.work_block_actuals[0].minutes, 18);
    assert.ok(resting.tasks.every((task) => !task.eligible));
    assert.equal((await f.write('/actuals', { block_id: 'block-shared', minutes: 20, source: '再次核实计时' }, DATE, 'PUT')).status, 200);
    assert.equal((await f.write('/actuals', { block_id: 'no-block', minutes: 10, source: '输入' }, DATE, 'PUT')).status, 400);
  } finally { await f.cleanup(); }
});

test('确认后项目暂停保留原承诺，禁止为暂停项目新增验收或引用异日任务', async () => {
  const f = await fixture();
  try {
    const state = (await f.write('/confirm', { draft: plan(f.initial.projects), acknowledgeOverCapacity: false })).body as DayState;
    const { id, revision, created_at, updated_at, ...project } = f.initial.projects[0];
    await f.call('PUT', `/api/projects/${id}`, { revision, project: { ...project, status: 'paused' } });
    const preserve = draftFrom(state); preserve.tasks[0].target_value = 900;
    assert.equal((await f.write('/confirm', { draft: preserve, acknowledgeOverCapacity: false })).status, 200);
    const changed = draftFrom(await f.read()); changed.tasks[0].title = '不同的新增任务';
    assert.equal((await f.write('/confirm', { draft: changed, acknowledgeOverCapacity: false })).status, 400);
    const foreign = plan(f.initial.projects); foreign.tasks[1].task_id = state.tasks[1].task_id;
    assert.equal((await f.write('/confirm', { draft: foreign, acknowledgeOverCapacity: false }, '2026-09-18')).status >= 400, true);
    assert.equal((await f.read('2026-09-18')).log, null);
  } finally { await f.cleanup(); }
});


test('一次结束工作原子保存成果/验收/共享时间，重试不重复，失败回滚', async () => {
  const f = await fixture();
  try {
    const state = (await f.write('/confirm', { draft: plan(f.initial.projects), acknowledgeOverCapacity: false })).body as DayState;
    const task = state.tasks.find(item => item.result_type === 'quant')!;
    const body = { requestId: randomUUID(), revision: state.log!.revision, event: event(state), result: { binary_value: null, explanation: '逐项核对' }, actual: { minutes: 23, source: '用户自报' }, mark_done: true };
    const path = `/api/days/${DATE}/tasks/${task.task_id}/finish`;
    const invalid = { ...body, actual: { ...body.actual, minutes: 1441 } };
    assert.equal((await f.call('POST', path, invalid)).status, 400);
    assert.deepEqual(await f.read(), state);
    const lateFailure = { ...body, result: { binary_value: 1, explanation: '' } };
    assert.equal((await f.call('POST', path, lateFailure)).status, 400);
    assert.deepEqual(await f.read(), state);
    const saved = await f.call('POST', path, body);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.log.revision, state.log!.revision + 1);
    assert.equal(saved.body.effective_events.length, 1);
    assert.equal(saved.body.log.work_block_actuals[0].minutes, 23);
    assert.equal(saved.body.tasks.find((item: any) => item.task_id === task.task_id).confirmed_result.actual_value, 1000);
    assert.equal(saved.body.tasks.find((item: any) => item.task_id === task.task_id).status, 'done');
    assert.deepEqual((await f.call('POST', path, body)).body, saved.body);
    assert.equal((await f.call('POST', path, { ...body, requestId: randomUUID() })).status, 409);
    const other = saved.body.tasks.find((item: any) => item.task_id !== task.task_id);
    const wrongTask = { ...body, requestId: randomUUID(), revision: saved.body.log.revision, event: { ...event(state), task_id: other.task_id } };
    assert.equal((await f.call('POST', path, wrongTask)).status, 400);
    assert.equal((await f.read()).effective_events.length, 1);
    const partial = await f.write(`/tasks/${task.task_id}/finish`, { event: null, result: null, actual: null, mark_done: true });
    assert.equal(partial.status, 200);
    assert.equal(partial.body.log.work_block_actuals[0].minutes, 23);
  } finally { await f.cleanup(); }
});

test('沿用最近工作计划只复制安排，跳过休息日，保留共享时段并重建身份', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('GET', `/api/days/${DATE}/previous-plan`)).body, null);
    const state = (await f.write('/confirm', { draft: plan(f.initial.projects), acknowledgeOverCapacity: false })).body as DayState;
    const rest: PlanDraft = { ...plan(f.initial.projects), day_mode: 'rest', tasks: [], work_blocks: [], dimensions: Object.fromEntries(['cashflow','asset','health','learning'].map(key => [key, { applicable: false, reason: '休息' }])) as PlanDraft['dimensions'] };
    await f.write('/confirm', { draft: rest, acknowledgeOverCapacity: false }, '2026-09-18');
    const result = await f.call('GET', '/api/days/2026-09-19/previous-plan');
    assert.equal(result.body.date, DATE);
    assert.equal(result.body.draft.work_blocks.length, 1);
    assert.equal(result.body.draft.work_blocks[0].budget_minutes, 20);
    assert.ok(result.body.draft.tasks.every((item: any) => item.task_id === null));
    assert.equal(result.body.draft.tasks[0].work_block_id, result.body.draft.tasks[1].work_block_id);
    assert.notEqual(result.body.draft.tasks[0].work_block_id, state.tasks[0].work_block_id);
    assert.equal((await f.read('2026-09-19')).log, null);
    assert.equal((await f.write('/confirm', { draft: result.body.draft, acknowledgeOverCapacity: false }, '2026-09-19')).status, 200);
    assert.deepEqual(await f.read(), state);
  } finally { await f.cleanup(); }
});


test('项目完成汇总直接按完成标志，数量更正与项目阶段保持独立', async () => {
  const f = await fixture();
  try {
    const draft = plan(f.initial.projects);
    draft.tasks[1].project_id = draft.tasks[0].project_id;
    const projectId = draft.tasks[0].project_id;
    let state = (await f.write('/confirm', { draft, acknowledgeOverCapacity: false })).body as DayState;
    const quant = state.tasks.find(task => task.result_type === 'quant')!;
    const binary = state.tasks.find(task => task.result_type === 'binary')!;
    assert.equal(projectProgress(state, projectId).label, '今日 0/2 项已完成');
    state = (await f.write(`/tasks/${quant.task_id}/status`, { status: 'done' })).body;
    assert.equal(projectProgress(state, projectId).confirmed, 0);
    assert.equal(projectProgress(state, projectId).completed, 1);
    state = (await f.write('/events', { event: event(state) })).body;
    state = (await f.write(`/tasks/${quant.task_id}/result`, { binary_value: null, explanation: '', clear: false })).body;
    assert.equal(projectProgress(state, projectId).label, '今日 1/2 项已完成');
    state = (await f.write(`/tasks/${binary.task_id}/result`, { binary_value: 0, explanation: '', clear: false })).body;
    assert.equal(projectProgress(state, projectId).label, '今日 1/2 项已完成');
    state = (await f.write(`/tasks/${binary.task_id}/result`, { binary_value: 1, explanation: '', clear: false })).body;
    assert.equal(projectProgress(state, projectId).label, '今日 1/2 项已完成');
    state = (await f.write(`/tasks/${binary.task_id}/status`, { status: 'done' })).body;
    assert.equal(projectProgress(state, projectId).label, '今日任务全部完成');
    const changed = draftFrom(state); changed.tasks = changed.tasks.filter(task => task.task_id === quant.task_id); changed.tasks[0].raw_points = 50;
    state = (await f.write('/confirm', { draft: changed, acknowledgeOverCapacity: false })).body;
    assert.equal(projectProgress(state, projectId).tasks.length, 1);
    const originalEvent = state.effective_events[0];
    state = (await f.write(`/events/${originalEvent.id}/correct`, { kind: 'replace', value: 800, stage: 'finalized', summary: '更正数量', source: '测试核对', reason: '数量有误' })).body;
    assert.equal(projectProgress(state, projectId).label, '今日任务全部完成');
    assert.equal(projectProgress(state, projectId).events[0].value, 800);
    state = (await f.write(`/tasks/${quant.task_id}/result`, { binary_value: null, explanation: '', clear: false })).body;
    assert.equal(projectProgress(state, projectId).label, '今日任务全部完成');
    assert.equal(projectProgress(state, projectId).achieved, 0);
    assert.equal(projectProgress(state, f.initial.projects[2].id).label, '今日未安排任务');
    assert.equal(projectStageLabel('待确认'), '项目阶段未设置');
    assert.equal(projectStageLabel('连载'), '连载');
    assert.equal((await f.call('GET', '/api/state')).body.projects.find((item: Project) => item.id === projectId).stage, '待确认');
  } finally { await f.cleanup(); }
});


test('旧草稿维度和零权重自动适配；原始请求幂等，重新分配不改完成记录与历史', async () => {
  const f = await fixture();
  try {
    const draft = plan(f.initial.projects);
    draft.tasks[0].raw_points = 0;
    draft.tasks[1].raw_points = 0; draft.tasks[1].scoring_dimension = 'asset';
    draft.dimensions.cashflow = { applicable: false, reason: '' };
    draft.dimensions.health = { applicable: true, reason: '' };
    const payload = { requestId: randomUUID(), revision: 0, draft, acknowledgeOverCapacity: false };
    const confirmed = await f.call('POST', `/api/days/${DATE}/confirm`, payload);
    assert.equal(confirmed.status, 200);
    const initial = confirmed.body as DayState;
    assert.deepEqual(initial.tasks.map(task => task.raw_points), [50, 30]);
    assert.deepEqual(initial.log!.plan_snapshots[0].dimensions, {
      cashflow: { applicable: true, reason: '' }, asset: { applicable: true, reason: '' },
      health: { applicable: false, reason: '本日未安排此维度任务' }, learning: { applicable: false, reason: '今天未安排' },
    });
    assert.deepEqual((await f.call('POST', `/api/days/${DATE}/confirm`, payload)).body, initial);
    // This different raw input has the same normalized result, but is not the same request.
    const altered = { ...payload, draft: { ...draft, tasks: draft.tasks.map((task, index) => ({ ...task, raw_points: index === 0 ? 50 : 30 })) } };
    assert.equal((await f.call('POST', `/api/days/${DATE}/confirm`, altered)).status, 409);
    assert.deepEqual(await f.read(), initial);
    const quant = initial.tasks[0];
    await f.write(`/tasks/${quant.task_id}/status`, { status: 'done' });
    await f.write('/events', { event: event(initial, { value: 400 }) });
    await f.write(`/tasks/${quant.task_id}/result`, { binary_value: null, explanation: '已核对数量', clear: false });
    await f.write('/actuals', { block_id: 'block-shared', minutes: 18, source: '整段计时' }, DATE, 'PUT');
    const before = await f.read();
    const adjusted = draftFrom(before);
    adjusted.tasks.forEach(task => { task.scoring_dimension = 'asset'; task.raw_points = 0; });
    const result = await f.write('/confirm', { draft: adjusted, acknowledgeOverCapacity: false });
    assert.equal(result.status, 200);
    const after = result.body as DayState;
    assert.deepEqual(after.tasks.map(task => task.raw_points), [15, 15]);
    assert.deepEqual(after.tasks.map(task => task.task_id), before.tasks.map(task => task.task_id));
    assert.equal(after.tasks[0].status, 'done');
    assert.equal(after.tasks[0].result_state, 'confirmed');
    assert.deepEqual(after.tasks[0].confirmed_result, before.tasks[0].confirmed_result);
    assert.deepEqual(after.events, before.events);
    assert.deepEqual(after.log!.work_block_actuals, before.log!.work_block_actuals);
    assert.deepEqual(after.log!.plan_snapshots[0], before.log!.plan_snapshots[0]);
    const latest = after.log!.plan_snapshots.at(-1)!;
    assert.equal(latest.dimensions.cashflow.applicable, false);
    assert.equal(latest.dimensions.asset.applicable, true);
    assert.equal(latest.work_blocks[0].id, 'block-shared');
  } finally { await f.cleanup(); }
});

test('维度任务数超限返回中文400并回滚，空工作和带任务休息计划仍不可确认', async () => {
  const f = await fixture();
  try {
    const draft = plan(f.initial.projects);
    const excessive: PlanDraft = { ...draft, tasks: Array.from({ length: 31 }, (_, index) => ({
      ...draft.tasks[1], candidate_id: `asset-${index}`, title: `合成任务 ${index}`, scoring_dimension: 'asset', raw_points: 0,
    })) };
    const denied = await f.write('/confirm', { draft: excessive, acknowledgeOverCapacity: false });
    assert.equal(denied.status, 400);
    assert.match(denied.body.error.message, /长期资产最多安排 30 项任务/u);
    assert.equal((await f.read()).log, null);
    const empty = await f.write('/confirm', { draft: { ...draft, tasks: [], work_blocks: [] }, acknowledgeOverCapacity: false });
    assert.equal(empty.status, 400); assert.match(empty.body.error.message, /至少需要一项明确的任务/u);
    assert.equal((await f.read()).log, null);
    const rest = await f.write('/confirm', { draft: { ...draft, day_mode: 'rest' }, acknowledgeOverCapacity: false });
    assert.equal(rest.status, 400); assert.match(rest.body.error.message, /休息计划不包含计分任务/u);
    assert.equal((await f.read()).log, null);
  } finally { await f.cleanup(); }
});

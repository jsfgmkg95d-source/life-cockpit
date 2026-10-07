import { testFetch } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import type { AppState, Project } from '../shared/contracts.ts';
import { DIMENSIONS } from '../shared/day-contracts.ts';
import type { DayState, PlanDraft } from '../shared/day-contracts.ts';
import { buildQuickTaskDraft } from '../shared/quick-task.ts';
import type { QuickTaskInput } from '../shared/quick-task.ts';
import { createApp, PROJECT_ROOT } from '../server/app.ts';

const TEST_ROOT = resolve(PROJECT_ROOT, '.runtime', 'tests');
const DATE = '2026-09-22';

async function fixture() {
  await mkdir(TEST_ROOT, { recursive: true });
  const folder = await mkdtemp(resolve(TEST_ROOT, 'quick-task-'));
  const app = createApp({ dataDir: resolve(folder, 'data'), port: 0 });
  const { url } = await app.listen();
  const token = (await (await testFetch(`${url}/api/session`)).json()).csrfToken as string;
  async function call(method: string, path: string, body?: unknown) {
    const response = await testFetch(`${url}${path}`, { method, headers: { Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  const setup = await call('POST', '/api/setup', { requestId: randomUUID(), timezone: 'Asia/Shanghai', availableMinutes: 180 });
  assert.equal(setup.status, 200);
  async function read(date = DATE): Promise<DayState> { return (await call('GET', `/api/days/${date}`)).body as DayState; }
  return {
    call, read, initial: setup.body as AppState,
    async write(path: string, payload: object, date = DATE, method = 'POST') {
      return call(method, `/api/days/${date}${path}`, { requestId: randomUUID(), revision: (await read(date)).log?.revision ?? 0, ...payload });
    },
    async cleanup() { await app.close(); assert.equal(dirname(folder), TEST_ROOT); await rm(folder, { recursive: true, force: true }); },
  };
}

function input(project: Project, overrides: Partial<QuickTaskInput> = {}): QuickTaskInput {
  return { project_id: project.id, project_revision: project.revision, title: `完成${project.name}的当日事项`, acceptance: '指定当日内容已核对完成', result_type: 'binary', metric_key: null, target_value: 1, budget_minutes: project.daily_budget_minutes ?? 15, available_minutes: 180, resume_project: false, acknowledgeOverCapacity: false, ...overrides };
}

test('快速添加从空安排起步：预览只含所选任务，不导入建议与保存草稿，也不修改输入', async () => {
  const f = await fixture();
  try {
    const state = await f.read();
    const saved = await f.write('/draft', { draft: state.suggested_draft }, DATE, 'PUT');
    assert.equal(saved.status, 200);
    const before = structuredClone(saved.body as DayState);
    const draft = buildQuickTaskDraft(before, f.initial, input(f.initial.projects[0]));
    assert.equal(draft.tasks.length, 1);
    assert.equal(draft.work_blocks.length, 1);
    assert.equal(draft.tasks[0].project_id, f.initial.projects[0].id);
    assert.equal(draft.tasks[0].raw_points, 50);
    assert.deepEqual(before, saved.body);
    const result = await f.write('/quick-task', input(f.initial.projects[0]));
    assert.equal(result.status, 200);
    assert.equal(result.body.tasks.length, 1);
    assert.equal(result.body.tasks[0].result_state, 'unknown');
    assert.equal(result.body.tasks[0].status, 'todo');
    assert.equal(result.body.events.length, 0);
    assert.deepEqual(result.body.log.draft_plan, before.log!.draft_plan);
  } finally { await f.cleanup(); }
});

test('快速添加保留已确认任务、证据、成果和容量；只追加一版并保持草稿独立', async () => {
  const f = await fixture();
  try {
    const first = await f.write('/quick-task', input(f.initial.projects[0], { result_type: 'quant', metric_key: 'accepted_words', target_value: 1000 }));
    assert.equal(first.status, 200);
    const task = (first.body as DayState).tasks[0];
    const finished = await f.write(`/tasks/${task.task_id}/finish`, {
      event: { project_id: task.project_id, task_id: task.task_id, artifact_key: 'quick-test-001', metric_key: 'accepted_words', value: 1000, stage: 'finalized', summary: '隔离测试正文验收', source: '隔离测试用户确认' },
      result: { binary_value: null, explanation: '该段正文确认齐全' }, actual: null, mark_done: true,
    });
    assert.equal(finished.status, 200);
    const pending = structuredClone((finished.body as DayState).suggested_draft);
    pending.notes = '尚未采纳的其他安排';
    assert.equal((await f.write('/draft', { draft: pending }, DATE, 'PUT')).status, 200);
    const before = await f.read();
    const added = await f.write('/quick-task', input(f.initial.projects[1], { available_minutes: 999 }));
    assert.equal(added.status, 200);
    const after = added.body as DayState;
    const preserved = after.tasks.find(item => item.task_id === task.task_id)!;
    assert.equal(preserved.status, 'done');
    assert.equal(preserved.result_state, 'confirmed');
    assert.deepEqual(preserved.confirmed_result, before.tasks[0].confirmed_result);
    assert.deepEqual(after.effective_events, before.effective_events);
    assert.deepEqual(after.log!.draft_plan, pending);
    assert.deepEqual(after.log!.plan_snapshots[0], before.log!.plan_snapshots[0]);
    assert.equal(after.log!.current_plan_version, 2);
    assert.equal(after.log!.plan_snapshots.at(-1)!.available_minutes, 180);
    assert.deepEqual(after.tasks.map(item => item.raw_points), [25, 25]);
  } finally { await f.cleanup(); }
});

test('测试连载平台共享时段只计一次，同项目追加也保留预算；旧时段实际投入不迁移', async () => {
  const f = await fixture();
  try {
    const lin = f.initial.projects.find(project => project.name === '示例连载甲')!;
    const three = f.initial.projects.find(project => project.name === '示例连载乙')!;
    const first = await f.write('/quick-task', input(lin));
    assert.equal(first.status, 200);
    const block = first.body.log.plan_snapshots[0].work_blocks[0];
    assert.equal((await f.write('/actuals', { block_id: block.id, minutes: 5, source: '隔离测试已发生投入' }, DATE, 'PUT')).status, 200);
    const second = await f.write('/quick-task', input(three, { budget_minutes: 999 }));
    assert.equal(second.status, 200);
    const secondPlan = second.body.log.plan_snapshots.at(-1);
    assert.equal(secondPlan.work_blocks.length, 1);
    assert.equal(secondPlan.work_blocks[0].budget_minutes, 15);
    assert.notEqual(secondPlan.work_blocks[0].id, block.id);
    assert.deepEqual(second.body.log.work_block_actuals.map((item: { block_id: string; minutes: number }) => [item.block_id, item.minutes]), [[block.id, 5]]);
    const third = await f.write('/quick-task', input(lin, { title: '另外核对一个发布事项', budget_minutes: null }));
    assert.equal(third.status, 200);
    assert.equal(third.body.log.plan_snapshots.at(-1).work_blocks.length, 1);
    assert.equal(third.body.log.plan_snapshots.at(-1).work_blocks[0].budget_minutes, 15);
  } finally { await f.cleanup(); }
});

test('追加任务按已有比例分配正整数权重，只改变相应维度', async () => {
  const f = await fixture();
  try {
    const draft = (await f.read()).suggested_draft;
    draft.tasks.forEach(task => { task.acceptance = '隔离测试当日标准'; });
    draft.tasks.filter(task => task.scoring_dimension === 'cashflow').forEach((task, index) => { task.raw_points = [30, 10, 5, 5][index]; });
    draft.tasks.filter(task => task.scoring_dimension === 'asset').forEach((task, index) => { task.raw_points = [20, 10][index]; });
    const confirmed = await f.write('/confirm', { draft, acknowledgeOverCapacity: false });
    assert.equal(confirmed.status, 200);
    const before = confirmed.body as DayState;
    const preview = buildQuickTaskDraft(before, f.initial, input(f.initial.projects[0]));
    assert.deepEqual(preview.tasks.filter(task => task.scoring_dimension === 'cashflow').map(task => task.raw_points), [24, 8, 4, 4, 10]);
    assert.deepEqual(preview.tasks.filter(task => task.scoring_dimension === 'asset').map(task => task.raw_points), [20, 10]);
    const added = await f.write('/quick-task', input(f.initial.projects[0]));
    assert.equal(added.status, 200);
    assert.deepEqual(added.body.log.plan_snapshots.at(-1).tasks.map((task: { raw_points: number }) => task.raw_points), preview.tasks.map(task => task.raw_points));
    assert.equal(added.body.log.plan_snapshots.at(-1).work_blocks.reduce((sum: number, block: { budget_minutes: number }) => sum + block.budget_minutes, 0), 135);
  } finally { await f.cleanup(); }
});

test('休息安排添加一项任务后切换工作模式，并保留原版本与备注', async () => {
  const f = await fixture();
  try {
    const rest: PlanDraft = { day_mode: 'rest', available_minutes: null, tasks: [], work_blocks: [], dimensions: Object.fromEntries(DIMENSIONS.map(dimension => [dimension, { applicable: false, reason: '休息' }])) as PlanDraft['dimensions'], change_reason: '', notes: '原本准备休息' };
    assert.equal((await f.write('/confirm', { draft: rest, acknowledgeOverCapacity: false })).status, 200);
    const added = await f.write('/quick-task', input(f.initial.projects[0], { available_minutes: 90 }));
    assert.equal(added.status, 200);
    assert.equal(added.body.log.plan_snapshots[0].day_mode, 'rest');
    assert.equal(added.body.log.plan_snapshots[1].day_mode, 'work');
    assert.equal(added.body.log.plan_snapshots[1].available_minutes, 90);
    assert.equal(added.body.log.plan_snapshots[1].notes, rest.notes);
    assert.equal(added.body.tasks.length, 1);
  } finally { await f.cleanup(); }
});

test('快速添加幂等重试不重复；旧日版本或项目版本不覆盖当前内容', async () => {
  const f = await fixture();
  try {
    const body = { requestId: randomUUID(), revision: 0, ...input(f.initial.projects[0]) };
    const first = await f.call('POST', `/api/days/${DATE}/quick-task`, body);
    assert.equal(first.status, 200);
    assert.deepEqual((await f.call('POST', `/api/days/${DATE}/quick-task`, body)).body, first.body);
    assert.equal((await f.call('POST', `/api/days/${DATE}/quick-task`, { ...body, title: '冲突内容' })).status, 409);
    assert.equal((await f.call('POST', `/api/days/${DATE}/quick-task`, { ...body, requestId: randomUUID() })).status, 409);
    const { id, revision, created_at: _created, updated_at: _updated, ...project } = f.initial.projects[1];
    assert.equal((await f.call('PUT', `/api/projects/${id}`, { revision, project: { ...project, next_action: '新安排' } })).status, 200);
    const latest = await f.read();
    assert.equal((await f.write('/quick-task', input(f.initial.projects[1]))).status, 409);
    assert.deepEqual(await f.read(), latest);
  } finally { await f.cleanup(); }
});

test('暂停、完成、归档项目必须显式恢复；失败同时回滚项目与当天日志', async () => {
  const f = await fixture();
  try {
    for (const [index, status] of (['paused', 'completed', 'archived'] as const).entries()) {
      const original = f.initial.projects[index];
      const { id, revision, created_at: _created, updated_at: _updated, ...project } = original;
      const edited = await f.call('PUT', `/api/projects/${id}`, { revision, project: { ...project, status } });
      assert.equal(edited.status, 200);
      const updated = edited.body.project as Project;
      const date = `2026-09-${23 + index}`;
      assert.equal((await f.write('/quick-task', input(updated), date)).status, 400);
      assert.equal((await f.read(date)).log, null);
      assert.equal((await f.write('/quick-task', input(updated, { resume_project: true, available_minutes: 0 }), date)).status, 400);
      assert.equal((await f.read(date)).log, null);
      assert.deepEqual((await f.call('GET', `/api/projects/${id}`)).body.project, updated);
      const payload = { requestId: randomUUID(), revision: 0, ...input(updated, { resume_project: true }) };
      const added = await f.call('POST', `/api/days/${date}/quick-task`, payload);
      assert.equal(added.status, 200);
      const resumed = (await f.call('GET', `/api/projects/${id}`)).body.project as Project;
      assert.equal(resumed.status, 'active');
      assert.equal(resumed.revision, updated.revision + 1);
      assert.deepEqual((await f.call('POST', `/api/days/${date}/quick-task`, payload)).body, added.body);
      assert.equal((await f.call('GET', `/api/projects/${id}`)).body.project.revision, resumed.revision);
    }
    const others = (await f.call('GET', '/api/state')).body as AppState;
    assert.ok(others.projects.slice(3).every(project => project.status === 'preparing' && project.revision === 1));
  } finally { await f.cleanup(); }
});

test('正在计时的共享时段不能悄悄改成员：恢复项目和新任务一起回滚，其他时段可添加', async () => {
  const f = await fixture();
  try {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const lin = f.initial.projects.find(project => project.name === '示例连载甲')!;
    const three = f.initial.projects.find(project => project.name === '示例连载乙')!;
    const first = await f.write('/quick-task', input(lin), date);
    const block = first.body.log.plan_snapshots[0].work_blocks[0];
    assert.equal((await f.write('/timer/start', { block_id: block.id }, date)).status, 200);
    const { id, revision, created_at: _created, updated_at: _updated, ...project } = three;
    const edited = await f.call('PUT', `/api/projects/${id}`, { revision, project: { ...project, status: 'completed' } });
    const before = await f.read(date);
    const denied = await f.write('/quick-task', input(edited.body.project, { resume_project: true }), date);
    assert.equal(denied.status, 400);
    assert.match(denied.body.error.message, /计时/u);
    assert.deepEqual(await f.read(date), before);
    assert.deepEqual((await f.call('GET', `/api/projects/${id}`)).body.project, edited.body.project);
    assert.equal((await f.call('GET', `/api/days/${date}/timer`)).body.active.block_id, block.id);
    assert.equal((await f.write('/quick-task', input(f.initial.projects[0]), date)).status, 200);
    assert.equal((await f.call('GET', `/api/days/${date}/timer`)).body.active.block_id, block.id);
  } finally { await f.cleanup(); }
});

test('数量目标与已知容量严格验证；超容量需显式同意且无失败残留', async () => {
  const f = await fixture();
  try {
    const bad: Partial<QuickTaskInput>[] = [
      { title: '' }, { acceptance: '' }, { available_minutes: -1 }, { budget_minutes: -1 },
      { result_type: 'quant', metric_key: null, target_value: 1 },
      { result_type: 'quant', metric_key: 'accepted_words', target_value: 0 },
      { result_type: 'binary', metric_key: 'accepted_words' },
      { available_minutes: 30 },
    ];
    for (const overrides of bad) {
      assert.equal((await f.write('/quick-task', input(f.initial.projects[0], overrides))).status, 400);
      assert.equal((await f.read()).log, null);
    }
    const added = await f.write('/quick-task', input(f.initial.projects[0], { available_minutes: 30, acknowledgeOverCapacity: true }));
    assert.equal(added.status, 200);
    assert.equal(added.body.log.plan_snapshots[0].over_capacity_acknowledged, true);
  } finally { await f.cleanup(); }
});

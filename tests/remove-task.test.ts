import { setUnequalTestWeights, setupTestWorkspace, testFetch } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createApp, PROJECT_ROOT } from '../server/app.ts';
import { BackupStore } from '../server/backup-store.ts';
import { DayStore } from '../server/day-store.ts';
import { removeTaskWrite } from '../server/day-validation.ts';
import { RestoreStore } from '../server/restore-store.ts';
import { ScheduleStore } from '../server/schedule-store.ts';
import { ScoreStore } from '../server/score-store.ts';
import { Store } from '../server/store.ts';
import { TimerStore } from '../server/timer-store.ts';
import type { DayState, PlanDraft } from '../shared/day-contracts.ts';
import { buildRemoveTaskDraft, removeDraftCandidate } from '../shared/remove-task.ts';

const ROOT = resolve(PROJECT_ROOT, '.runtime', 'tests');
const DATE = '2026-09-22';
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const current = (state: DayState) => state.log!.plan_snapshots.at(-1)!;
function fixture(date = DATE) {
  mkdirSync(ROOT, { recursive: true }); const folder = mkdtempSync(resolve(ROOT, 'remove-task-'));
  const store = new Store(resolve(folder, 'data')), app = setupTestWorkspace(store, randomUUID(), 'Asia/Shanghai', 180);
  const days = new DayStore(store), timers = new TimerStore(days), scores = new ScoreStore(store), schedules = new ScheduleStore(days);
  const base = () => ({ requestId: randomUUID(), revision: days.findLog(date)?.revision ?? 0 });
  const draft = setUnequalTestWeights(days.suggestedDraft()); draft.tasks.forEach(task => { task.acceptance = `已核对${task.title}的当日内容`; });
  const plan = () => days.confirm(date, { ...base(), draft, acknowledgeOverCapacity: false });
  const single = () => { const project = app.projects[0]; return days.quickTask(date, { ...base(), project_id: project.id, project_revision: project.revision, title: '唯一的当日事项', acceptance: '内容已核对完成', result_type: 'binary', metric_key: null, target_value: 1, budget_minutes: 30, available_minutes: 180, resume_project: false, acknowledgeOverCapacity: false }); };
  const schedule = (taskId: string | null, start = 540) => schedules.save(date, { ...base(), task_id: taskId, title: '测试时间安排', start_minute: start, duration_minutes: 20 });
  return { folder, store, app, days, timers, scores, schedules, date, base, draft, plan, single, schedule,
    close() { store.close(); assert.equal(resolve(folder, '..'), ROOT); rmSync(folder, { recursive: true, force: true }); } };
}

test('移除候选不修改源草稿：空块清理、共享预算保留、权重按比例及零权重等分', () => {
  const f = fixture(); try {
    const before = structuredClone(f.draft), first = f.draft.tasks[0];
    const next = removeDraftCandidate(f.draft, first.candidate_id);
    assert.deepEqual(f.draft, before);
    assert.deepEqual(next.tasks.filter(task => task.scoring_dimension === 'cashflow').map(task => task.raw_points), [25, 13, 12]);
    assert.deepEqual(next.tasks.filter(task => task.scoring_dimension === 'asset'), before.tasks.filter(task => task.scoring_dimension === 'asset'));
    assert.ok(!next.work_blocks.some(block => block.id === first.work_block_id));
    const lin = f.draft.tasks.find(task => task.project_id === f.app.projects.find(project => project.name === '示例连载甲')!.id)!;
    const shared = removeDraftCandidate(f.draft, lin.candidate_id);
    assert.deepEqual(shared.work_blocks.find(block => block.id === lin.work_block_id), before.work_blocks.find(block => block.id === lin.work_block_id));
    const zero = structuredClone(f.draft); zero.tasks.forEach(task => { task.raw_points = 0; });
    const equal = removeDraftCandidate(zero, first.candidate_id);
    assert.deepEqual(equal.tasks.filter(task => task.scoring_dimension === 'cashflow').map(task => task.raw_points), [17, 17, 16]);
    const incomplete = structuredClone(f.draft); incomplete.work_blocks.push({ id: 'empty-in-progress', title: '尚未补齐的时段', budget_minutes: null });
    assert.ok(removeDraftCandidate(incomplete, first.candidate_id).work_blocks.some(block => block.id === 'empty-in-progress'));
    const overfull: PlanDraft = { ...structuredClone(f.draft), tasks: Array.from({ length: 12 }, (_, index) => ({ ...first, candidate_id: `learning-${index}`, scoring_dimension: 'learning', raw_points: 0 })) };
    const reduced = removeDraftCandidate(overfull, 'learning-0');
    assert.equal(reduced.tasks.length, 11); assert.ok(reduced.tasks.every(task => task.raw_points === 0));
    assert.ok(removeDraftCandidate(reduced, 'learning-1').tasks.every(task => task.raw_points === 1));
    assert.throws(() => removeDraftCandidate(f.draft, 'missing'), /不在当前/u);
  } finally { f.close(); }
});

test('移除已确认任务保留项目、成果、投入、结果与评分历史，只软删该任务的安排并新增计划版本', () => {
  const f = fixture(); try {
    const task = f.plan().tasks[0];
    f.days.event(DATE, { ...f.base(), event: { project_id: task.project_id, task_id: task.task_id, artifact_key: 'remove-test-output', metric_key: 'accepted_words', value: 120, stage: 'finalized', summary: '隔离测试成果', source: '用户核对' } });
    f.days.actual(DATE, { ...f.base(), block_id: task.work_block_id, minutes: 12, source: '用户已核对投入' });
    for (const member of f.days.getState(DATE).tasks) f.days.result(DATE, member.task_id, { ...f.base(), binary_value: member.task_id === task.task_id ? 0 : 1, explanation: '逐项核对', clear: false });
    f.scores.write(DATE, f.base(), true);
    f.days.pin(DATE, task.task_id, { ...f.base(), pinned: true });
    const taskSchedule = f.schedule(task.task_id).blocks[0]; f.schedule(null, 600); f.schedule(f.days.getState(DATE).tasks[1].task_id, 660);
    const pending = structuredClone(f.draft); pending.notes = '独立草稿不能被悄悄确认或覆盖';
    f.days.saveDraft(DATE, { ...f.base(), draft: pending });
    const before = f.days.getState(DATE), oldScores = f.scores.getView(DATE), project = f.store.getProject(task.project_id);
    const after = f.days.removeTask(DATE, task.task_id, { ...f.base(), reason: '今日安排已调整' });
    assert.equal(after.log!.current_plan_version, before.log!.current_plan_version + 1);
    assert.deepEqual(after.log!.plan_snapshots.slice(0, -1), before.log!.plan_snapshots);
    assert.deepEqual(after.log!.draft_plan, pending); assert.equal(after.log!.record_state, 'incomplete');
    assert.deepEqual(after.log!.work_block_actuals, before.log!.work_block_actuals); assert.deepEqual(after.events, before.events);
    assert.deepEqual(f.store.getProject(task.project_id), project);
    const removed = after.tasks.find(item => item.task_id === task.task_id)!;
    assert.equal(removed.eligible, false); assert.deepEqual(removed.confirmed_result, before.tasks[0].confirmed_result); assert.equal(removed.status, before.tasks[0].status);
    assert.equal(after.pinned_task_ids!.includes(task.task_id), false);
    assert.equal(f.schedules.view(DATE).blocks.length, 2); assert.ok(f.store.database.prepare('SELECT deleted_at FROM day_schedule WHERE id=?').get(taskSchedule.id)!.deleted_at);
    const scored = f.scores.getView(DATE);
    assert.deepEqual(scored.history, oldScores.history); assert.equal(scored.current_score_id, null);
    assert.equal(scored.comparisons[0].score.display.lower, oldScores.preview.display.final);
    assert.ok(scored.comparisons[0].score.tasks.some(item => item.task_id === task.task_id && item.actual === 0));
    assert.ok(current(after).change_reason.includes('今日安排已调整'));
  } finally { f.close(); }
});

test('最后一项移除后保持空工作日、分数不适用，原承诺可追溯且可再添加任务', () => {
  const f = fixture(); try {
    const task = f.single().tasks[0];
    const after = f.days.removeTask(DATE, task.task_id, { ...f.base(), reason: '今天暂不安排' });
    assert.equal(current(after).day_mode, 'work'); assert.deepEqual(current(after).tasks, []); assert.deepEqual(current(after).work_blocks, []);
    assert.ok(Object.values(current(after).dimensions).every(choice => !choice.applicable && choice.reason));
    const score = f.scores.getView(DATE); assert.equal(score.preview.reason, 'no_eligible_tasks'); assert.equal(score.preview.final_score, null); assert.equal(score.can_settle, false);
    assert.deepEqual(score.comparisons[0].score.missing_task_ids, [task.task_id]);
    // Ordinary plan confirmation keeps its existing guard against accidental empty work plans.
    assert.throws(() => f.days.confirm(DATE, { ...f.base(), draft: buildRemoveTaskDraft({ ...after, log: { ...after.log!, current_plan_version: 1 } }, task.task_id, '对照'), acknowledgeOverCapacity: false }), /至少需要/u);
    assert.equal(current(f.single()).tasks.length, 1);
  } finally { f.close(); }
});

test('共享时段移除一个任务更换时段身份，保留原共享投入且不改其他任务时间安排', () => {
  const f = fixture(); try {
    const state = f.plan(), lin = state.tasks.find(task => task.project_name === '示例连载甲')!, three = state.tasks.find(task => task.project_name === '示例连载乙')!;
    f.days.actual(DATE, { ...f.base(), block_id: lin.work_block_id, minutes: 9, source: '两书共享投入' }); f.schedule(lin.task_id); f.schedule(three.task_id, 600);
    const after = f.days.removeTask(DATE, lin.task_id, { ...f.base(), reason: '只保留另一书安排' });
    const remaining = after.tasks.find(task => task.task_id === three.task_id)!;
    assert.equal(remaining.eligible, true); assert.notEqual(remaining.work_block_id, lin.work_block_id);
    assert.equal(current(after).work_blocks.find(block => block.id === remaining.work_block_id)!.budget_minutes, 15);
    assert.deepEqual(after.log!.work_block_actuals.map(actual => [actual.block_id, actual.minutes]), [[lin.work_block_id, 9]]);
    assert.deepEqual(f.schedules.view(DATE).blocks.map(block => [block.task_id, block.task_eligible]), [[three.task_id, true]]);
  } finally { f.close(); }
});

test('移除后的空工作日、软删时间安排和历史承诺经过备份恢复与重启保留', () => {
  const f = fixture(); try {
    const task = f.single().tasks[0]; f.schedule(task.task_id);
    f.days.removeTask(DATE, task.task_id, { ...f.base(), reason: '当天安排已清空' });
    const before = f.days.getState(DATE), beforeScore = f.scores.getView(DATE);
    const backups = new BackupStore(f.store, resolve(f.folder, 'backups')), restore = new RestoreStore(f.store, backups, () => false), backup = backups.create(randomUUID());
    f.single(); const preview = restore.preview(backup.id); restore.restore(randomUUID(), preview.token, '恢复本地账本');
    assert.deepEqual(f.days.getState(DATE), before); assert.deepEqual(f.scores.getView(DATE), beforeScore); assert.equal(f.schedules.view(DATE).blocks.length, 0);
    f.store.close(); const reopened = new Store(resolve(f.folder, 'data'));
    try { assert.deepEqual(new DayStore(reopened).getState(DATE), before); assert.deepEqual(new ScoreStore(reopened).getView(DATE), beforeScore); }
    finally { reopened.close(); }
  } finally { f.close(); }
});

test('活动任务及其共享成员移除均回滚；无关任务可移除且不会停止现有计时', () => {
  const f = fixture(today()); try {
    const state = f.plan(), lin = state.tasks.find(task => task.project_name === '示例连载甲')!, three = state.tasks.find(task => task.project_name === '示例连载乙')!, other = state.tasks[0];
    f.schedule(lin.task_id); f.schedule(three.task_id, 600); f.days.pin(f.date, lin.task_id, { ...f.base(), pinned: true });
    f.timers.start(f.date, lin.work_block_id, { ...f.base(), task_id: lin.task_id, target_minutes: 25 });
    const before = f.days.getState(f.date), scheduleBefore = f.schedules.view(f.date), active = f.timers.view(f.date).active!;
    for (const task of [lin, three]) {
      assert.throws(() => f.days.removeTask(f.date, task.task_id, { ...f.base(), reason: '测试保护' }), /先暂停/u);
      assert.deepEqual(f.days.getState(f.date), before); assert.deepEqual(f.schedules.view(f.date), scheduleBefore); assert.equal(f.timers.view(f.date).active!.id, active.id);
    }
    f.days.removeTask(f.date, other.task_id, { ...f.base(), reason: '不影响共享专注的调整' });
    assert.equal(f.timers.view(f.date).active!.id, active.id);
    f.store.database.prepare('UPDATE work_sessions SET started_at=? WHERE id=?').run(new Date(Date.now() - 125_000).toISOString(), active.id);
    f.timers.stop(f.date, { ...f.base(), discard: false });
    f.days.removeTask(f.date, lin.task_id, { ...f.base(), reason: '已先暂停并保存投入' });
    assert.equal(f.timers.view(f.date).summary.todayMinutes, 2); assert.equal(f.timers.view(f.date).sessions[0].task_id, lin.task_id);
  } finally { f.close(); }
});

test('移除请求幂等、版本冲突和跨日期拒绝；非法原因不会写入版本或空日志', () => {
  const f = fixture(); try {
    const task = f.plan().tasks[0], input = { ...f.base(), reason: '今天不再安排此任务' };
    const after = f.days.removeTask(DATE, task.task_id, input);
    assert.deepEqual(f.days.removeTask(DATE, task.task_id, input), after);
    assert.throws(() => f.days.removeTask(DATE, task.task_id, { ...input, reason: '相同键不同内容' }), code('IDEMPOTENCY_CONFLICT'));
    assert.throws(() => f.days.removeTask(DATE, after.tasks[1].task_id, { ...input, requestId: randomUUID() }), code('REVISION_CONFLICT'));
    assert.throws(() => f.days.removeTask(DATE, task.task_id, { ...f.base(), reason: '已移除' }), code('TASK_NOT_CURRENT'));
    assert.throws(() => f.days.removeTask('2026-09-23', task.task_id, { requestId: randomUUID(), revision: 0, reason: '不能跨日' }), code('TASK_NOT_FOUND'));
    assert.equal(f.days.findLog('2026-09-23'), null);
    for (const invalid of [{ reason: '' }, { reason: 'a'.repeat(1501) }, { reason: '正常原因', unexpected: true }, { reason: '正常原因', revision: -1 }]) assert.throws(() => removeTaskWrite({ ...f.base(), ...invalid }));
    assert.deepEqual(f.days.getState(DATE), after);
  } finally { f.close(); }
});

test('移除 HTTP 接口遵循 CSRF、严格字段校验并返回刷新后的 DayState', async () => {
  mkdirSync(ROOT, { recursive: true }); const folder = mkdtempSync(resolve(ROOT, 'remove-task-http-')), app = createApp({ dataDir: resolve(folder, 'data'), port: 0 });
  try {
    const { url } = await app.listen(), token = (await (await testFetch(`${url}/api/session`)).json()).csrfToken as string;
    const post = async (path: string, body: unknown, csrf = token) => { const response = await testFetch(url + path, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
    const setup = await post('/api/setup', { requestId: randomUUID(), timezone: 'Asia/Shanghai', availableMinutes: 180 }), project = setup.body.projects[0];
    const first = await post(`/api/days/${DATE}/quick-task`, { requestId: randomUUID(), revision: 0, project_id: project.id, project_revision: project.revision, title: '待移除事项', acceptance: '完成内容核对', result_type: 'binary', metric_key: null, target_value: 1, budget_minutes: 20, available_minutes: 180, resume_project: false, acknowledgeOverCapacity: false });
    assert.equal(first.status, 200); const task = first.body.tasks[0], path = `/api/days/${DATE}/tasks/${task.task_id}/remove`, body = { requestId: randomUUID(), revision: 1, reason: '用户移除当天安排' };
    assert.equal((await post(path, body, 'invalid')).status, 403); assert.equal((await post(path, { ...body, unexpected: true })).status, 400);
    const removed = await post(path, body); assert.equal(removed.status, 200); assert.equal(removed.body.business_date, DATE); assert.equal(removed.body.log.revision, 2); assert.equal(removed.body.tasks[0].eligible, false);
    assert.deepEqual((await post(path, body)).body, removed.body);
  } finally { await app.close(); assert.equal(resolve(folder, '..'), ROOT); rmSync(folder, { recursive: true, force: true }); }
});

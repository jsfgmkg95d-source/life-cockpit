import { setupTestWorkspace } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { calendarMonth } from '../server/calendar-store.ts';
import { createApp } from '../server/app.ts';
import { DayStore } from '../server/day-store.ts';
import { Store } from '../server/store.ts';
import type { EventInput, PlanDraft } from '../shared/day-contracts.ts';

function fixture() {
  const root = resolve(import.meta.dirname, '..', '.runtime', 'tests');
  mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(resolve(root, 'calendar-'));
  const store = new Store(folder), days = new DayStore(store);
  const app = setupTestWorkspace(store, randomUUID(), 'Asia/Shanghai', 180);
  const base = (date: string) => ({ requestId: randomUUID(), revision: days.findLog(date)?.revision ?? 0 });
  const plan = (date: string) => {
    const draft = days.suggestedDraft();
    draft.tasks = draft.tasks.map(task => ({ ...task, acceptance: '隔离测试明确验收', result_type: 'binary', metric_key: null, target_value: 1 }));
    return days.confirm(date, { ...base(date), draft, acknowledgeOverCapacity: false });
  };
  const event = (artifact_key: string, overrides: Partial<EventInput> = {}): EventInput => ({
    project_id: app.projects[0].id, task_id: null, artifact_key, metric_key: 'accepted_words', value: 100,
    stage: 'finalized', summary: '隔离测试成果', source: '测试记录', ...overrides,
  });
  const month = () => calendarMonth(store, '2026-09', new Date('2026-09-22T08:00:00Z'));
  const day = (date: string) => month().days.find(item => item.date === date)!;
  return { folder, store, days, base, plan, event, month, day };
}

test('月历覆盖实际月份和闰年；业务今日按时区计算，读取不生成日账或回执', () => {
  const f = fixture();
  try {
    const changes = f.store.database.prepare('SELECT total_changes() AS n').get()!.n;
    for (const [month, count] of [['2024-02', 29], ['2026-02', 28], ['2026-04', 30], ['2026-12', 31]] as const) {
      const result = calendarMonth(f.store, month, new Date('2026-09-21T16:30:00Z'));
      assert.equal(result.days.length, count);
      assert.equal(result.days[0].date, `${month}-01`);
      assert.equal(result.days.at(-1)!.date, `${month}-${count}`);
      assert.equal(result.today, '2026-09-22');
      assert.ok(result.days.every(day => !day.recorded && day.mode === null && !day.hasHarvest && day.plannedTasks === 0 && day.completedTasks === 0 && day.totals.length === 0));
    }
    for (const month of ['2026-00', '2026-13', '2026-9', '2026-02-01', ' 2026-02', '2026-02 ', '2026-09/anything']) {
      assert.throws(() => calendarMonth(f.store, month));
    }
    assert.equal(f.store.database.prepare('SELECT total_changes() AS n').get()!.n, changes);
    assert.equal(f.store.database.prepare('SELECT COUNT(*) AS n FROM daily_logs').get()!.n, 0);
  } finally { f.store.close(); }
});

test('收获保留部分成果、明确未达成和未知的区别；取消不缩分母，用时不兑换成果', () => {
  const f = fixture(), date = '2026-09-20';
  try {
    const draft = f.days.suggestedDraft();
    draft.tasks = draft.tasks.map(task => ({ ...task, acceptance: '隔离测试明确验收', result_type: 'binary', metric_key: null, target_value: 1 }));
    draft.tasks[0] = { ...draft.tasks[0], result_type: 'quant', metric_key: 'accepted_words', target_value: 10 };
    const state = f.days.confirm(date, { ...f.base(date), draft, acknowledgeOverCapacity: false });
    const [partial, unmet, unknown, achieved, cancelled] = state.tasks;
    f.days.event(date, { ...f.base(date), event: f.event('partial', { project_id: partial.project_id, task_id: partial.task_id, value: 4 }) });
    f.days.result(date, partial.task_id, { ...f.base(date), binary_value: null, explanation: '部分达成', clear: false });
    for (const [task, value] of [[unmet, 0], [achieved, 1]] as const) {
      f.days.result(date, task.task_id, { ...f.base(date), binary_value: value, explanation: '测试确认', clear: false });
    }
    for (const task of [unmet, unknown, achieved]) f.days.status(date, task.task_id, { ...f.base(date), status: 'done' });
    f.days.status(date, cancelled.task_id, { ...f.base(date), status: 'cancelled' });
    const result = f.day(date);
    assert.equal(result.plannedTasks, 6); assert.equal(result.confirmedTasks, 3);
    assert.equal(result.achievedTasks, 1); assert.equal(result.positiveResultTasks, 2);
    assert.equal(result.endedTasks, 3); assert.equal(result.hasHarvest, true);
    assert.equal(result.completedTasks, 3);
    assert.deepEqual(result.totals, [{ metric: 'accepted_words', stage: 'finalized', value: '4', records: 1 }]);

    const inputOnly = '2026-09-21', timeState = f.plan(inputOnly);
    const shared = timeState.log!.plan_snapshots[0].work_blocks.find(block => block.title.includes('测试连载平台'))!;
    f.days.actual(inputOnly, { ...f.base(inputOnly), block_id: shared.id, minutes: 15, source: '共享投入只记一次' });
    for (const task of timeState.tasks) f.days.status(inputOnly, task.task_id, { ...f.base(inputOnly), status: 'done' });
    assert.equal(f.day(inputOnly).hasHarvest, false);
    assert.equal(f.day(inputOnly).confirmedTasks, 0);
    assert.equal(f.day(inputOnly).endedTasks, 6);
    assert.equal(f.day(inputOnly).completedTasks, 6);
    assert.equal(f.day(inputOnly).achievedTasks, 0);
    assert.deepEqual(f.day(inputOnly).totals, []);

    const restDate = '2026-09-22', rest = f.days.suggestedDraft();
    rest.day_mode = 'rest'; rest.tasks = []; rest.work_blocks = [];
    for (const dimension of Object.values(rest.dimensions)) { dimension.applicable = false; dimension.reason = '休息'; }
    f.days.confirm(restDate, { ...f.base(restDate), draft: rest, acknowledgeOverCapacity: false });
    assert.equal(f.day(restDate).mode, 'rest'); assert.equal(f.day(restDate).recorded, true);
    assert.equal(f.day(restDate).hasHarvest, false);
  } finally { f.store.close(); }
});

test('只统计当前计划的任务；原计划任务仍保留历史记录', () => {
  const f = fixture(), date = '2026-09-20';
  try {
    const state = f.plan(date), task = state.tasks[0];
    f.days.result(date, task.task_id, { ...f.base(date), binary_value: 1, explanation: '原计划达成', clear: false });
    f.days.status(date, task.task_id, { ...f.base(date), status: 'done' });
    assert.equal(f.day(date).positiveResultTasks, 1);
    assert.equal(f.day(date).completedTasks, 1);
    const draft: PlanDraft = structuredClone(state.log!.plan_snapshots[0]);
    draft.change_reason = '调整测试计划';
    draft.tasks = draft.tasks.filter(item => item.task_id !== task.task_id);
    draft.work_blocks = draft.work_blocks.filter(block => draft.tasks.some(item => item.work_block_id === block.id));
    draft.tasks.find(item => item.scoring_dimension === task.scoring_dimension)!.raw_points += task.raw_points;
    f.days.confirm(date, { ...f.base(date), draft, acknowledgeOverCapacity: false });
    assert.equal(f.days.getState(date).tasks.length, 6);
    assert.equal(f.day(date).plannedTasks, 5);
    assert.equal(f.day(date).positiveResultTasks, 0);
    assert.equal(f.day(date).completedTasks, 0);
    assert.equal(f.day(date).hasHarvest, false);
  } finally { f.store.close(); }
});

test('更正和撤销重算原日收获；阶段、单位与大整数分别保留，邻月成果不混入', () => {
  const f = fixture(), date = '2026-09-20';
  try {
    let state = f.days.event(date, { ...f.base(date), event: f.event('original') });
    state = f.days.correct(date, state.events[0].id, { ...f.base(date), kind: 'replace', value: 40, stage: 'approved', summary: '已核对', source: '测试', reason: '更正数量' });
    assert.deepEqual(f.day(date).totals, [{ metric: 'accepted_words', stage: 'approved', value: '40', records: 1 }]);
    f.days.correct(date, state.effective_events[0].id, { ...f.base(date), kind: 'void', value: null, stage: 'approved', summary: '撤销', source: '测试', reason: '演练撤销' });
    assert.equal(f.day(date).hasHarvest, false); assert.deepEqual(f.day(date).totals, []);
    f.days.event(date, { ...f.base(date), event: f.event('zero', { value: 0 }) });
    assert.equal(f.day(date).hasHarvest, false);
    for (const key of ['large1', 'large2']) f.days.event(date, { ...f.base(date), event: f.event(key, { value: Number.MAX_SAFE_INTEGER }) });
    f.days.event(date, { ...f.base(date), event: f.event('submit', { metric_key: 'submission_batches', value: 1, stage: 'submitted' }) });
    f.days.event(date, { ...f.base(date), event: f.event('public', { metric_key: 'published_articles', value: 1, stage: 'published' }) });
    for (const other of ['2026-08-31', '2026-10-01']) f.days.event(other, { ...f.base(other), event: f.event(other) });
    assert.deepEqual(f.day(date).totals, [
      { metric: 'accepted_words', stage: 'finalized', value: '18014398509481982', records: 2 },
      { metric: 'published_articles', stage: 'published', value: '1', records: 1 },
      { metric: 'submission_batches', stage: 'submitted', value: '1', records: 1 },
    ]);
    assert.equal(f.month().days.filter(day => day.hasHarvest).length, 1);
  } finally { f.store.close(); }
});

test('未知章号和跨日期跨阶段重复身份不虚增收获；撤销冲突后恢复有效统计', () => {
  const f = fixture();
  try {
    // Reproduce imported legacy identities; normal new writes already reject duplicates.
    const legacy = (date: string, key: string, chapters: number[], stage: EventInput['stage'] = 'finalized') => {
      const id = randomUUID(), event = f.event(key, { metric_key: 'accepted_chapters', value: 1, stage });
      f.days.mutate(date, 'legacy-calendar-fixture', f.base(date), log => {
        f.days.insertEvent({ ...event, id, root_event_id: id, daily_log_id: log.id, occurred_on: date,
          occurrence_precision: 'date', timezone: log.timezone, measurement_scope: 'project', period_key: 'lifetime',
          confirmation_state: 'user_confirmed', change_kind: 'record', supersedes_event_id: null,
          correction_reason: null, created_at: new Date().toISOString() });
        for (const chapter of chapters) f.store.database.prepare('INSERT INTO asset_chapters VALUES(?,?)').run(id, chapter);
      });
      return id;
    };
    legacy('2026-08-31', 'prior', [1]);
    const duplicate = legacy('2026-09-01', 'duplicate', [1], 'published');
    legacy('2026-09-02', 'unidentified', []);
    legacy('2026-09-03', 'unique', [2]);
    assert.equal(f.day('2026-09-01').unresolvedEvents, 1);
    assert.equal(f.day('2026-09-01').hasHarvest, false);
    assert.equal(f.day('2026-09-02').unresolvedEvents, 1);
    assert.equal(f.day('2026-09-02').hasHarvest, false);
    assert.equal(f.day('2026-09-03').totals[0].value, '1');
    // A separate published metric is its own delivery fact, never another accepted chapter.
    f.days.event('2026-09-03', { ...f.base('2026-09-03'), event: f.event('public-chapter', { metric_key: 'published_chapters', chapter_numbers: [2], value: 1, stage: 'published' }) });
    assert.equal(f.day('2026-09-03').totals.length, 2);
    f.days.correct('2026-09-01', duplicate, { ...f.base('2026-09-01'), kind: 'void', value: null, stage: 'published', summary: '撤销重复', source: '测试', reason: '去重' });
    assert.equal(calendarMonth(f.store, '2026-08').days.at(-1)!.totals[0].value, '1');
    assert.equal(f.day('2026-09-01').unresolvedEvents, 0);
  } finally { f.store.close(); }
});

test('月历 GET 接口返回合同；无效月份拒绝，POST 不创建日记录', async () => {
  const f = fixture(); f.store.close();
  const app = createApp({ dataDir: f.folder });
  try {
    const { url } = await app.listen();
    const response = await fetch(`${url}/api/calendar/2024-02`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.month, '2024-02'); assert.equal(body.days.length, 29);
    for (const month of ['2024-13', '2024-2', '2024-02-29', '2024-02/extra']) assert.equal((await fetch(`${url}/api/calendar/${month}`)).status, 400);
    assert.equal((await fetch(`${url}/api/calendar/2024-02`, { method: 'POST' })).status, 403);
    assert.equal((await (await fetch(`${url}/api/days/2024-02-29`)).json()).log, null);
  } finally { await app.close(); }
});

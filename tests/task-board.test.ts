import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DailyTask } from '../shared/day-contracts.ts';
import { taskBoardState } from '../shared/task-board.ts';

function task(actual: number | null, changes: Partial<DailyTask> = {}): DailyTask {
  return {
    candidate_id: 'candidate', task_id: 'task', project_id: 'project', project_name: '隔离看板项目',
    title: '完成指定章节', acceptance: '六章定稿', result_type: 'quant', metric_key: 'accepted_chapters',
    target_value: 6, scoring_dimension: 'cashflow', raw_points: 20, estimated_minutes: null,
    work_block_id: 'shared-block', daily_log_id: 'day', status: 'done',
    result_state: actual === null ? 'unknown' : 'confirmed',
    confirmed_result: actual === null ? null : {
      actual_value: actual, evidence_event_ids: [], evidence_hash: 'test', explanation: '隔离展示测试',
      confirmed_at: '2026-09-20T00:00:00Z', confirmed_by: 'user',
    },
    eligible: true, created_at: '2026-09-20T00:00:00Z', updated_at: '2026-09-20T00:00:00Z',
    ...changes,
  };
}

test('点完成即进入完成列，缺失数量仍保持未知', () => {
  const expected = { column: 'done', completed: true, outcome: 'unknown', actual: null, target: 6, progress: null };
  assert.deepEqual(taskBoardState(task(null)), expected);
  assert.deepEqual(taskBoardState(task(6, { result_state: 'unknown' })), expected);
  assert.deepEqual(taskBoardState(task(null, { result_state: 'confirmed' })), expected);
});

test('结果已核对不等于达标：零、部分、达标、超额分别展示', () => {
  for (const [actual, outcome, progress] of [
    [0, 'unmet', 0], [4, 'partial', 4 / 6], [6, 'achieved', 1], [8, 'achieved', 1],
  ] as const) {
    assert.deepEqual(taskBoardState(task(actual)), { column: 'done', completed: true, outcome, actual, target: 6, progress });
  }
});

test('待开始和进行中即使目标已经达成也保持原工作列', () => {
  for (const status of ['todo', 'doing'] as const) {
    assert.deepEqual(taskBoardState(task(8, { status })), {
      column: status, completed: false, outcome: 'achieved', actual: 8, target: 6, progress: 1,
    });
    assert.equal(taskBoardState(task(null, { status })).column, status);
  }
});

test('取消优先进入独立列，保留已有成果而不假装结束或未知为零', () => {
  assert.deepEqual(taskBoardState(task(4, { status: 'cancelled' })), {
    column: 'cancelled', completed: false, outcome: 'partial', actual: 4, target: 6, progress: 4 / 6,
  });
  assert.deepEqual(taskBoardState(task(null, { status: 'cancelled' })), {
    column: 'cancelled', completed: false, outcome: 'unknown', actual: null, target: 6, progress: null,
  });
});

test('离散验收固定目标为一，仅有未知、未达成和达成', () => {
  const binary: Partial<DailyTask> = { result_type: 'binary', metric_key: null, target_value: 1 };
  assert.deepEqual(taskBoardState(task(null, binary)), { column: 'done', completed: true, outcome: 'unknown', actual: null, target: 1, progress: null });
  assert.deepEqual(taskBoardState(task(0, binary)), { column: 'done', completed: true, outcome: 'unmet', actual: 0, target: 1, progress: 0 });
  assert.deepEqual(taskBoardState(task(1, binary)), { column: 'done', completed: true, outcome: 'achieved', actual: 1, target: 1, progress: 1 });
  for (const actual of [0.5, 2, -1, NaN, Infinity]) {
    assert.deepEqual(taskBoardState(task(actual, binary)), { column: 'done', completed: true, outcome: 'unknown', actual: null, target: 1, progress: null });
  }
});

test('缺失目标不产生伪造的达标比例，展示计算不改变原任务', () => {
  const source = task(4, { target_value: null });
  const before = structuredClone(source);
  const state = taskBoardState(source);
  assert.equal(state.target, Infinity);
  assert.equal(state.progress, null);
  assert.notEqual(state.outcome, 'achieved');
  assert.deepEqual(source, before);
});

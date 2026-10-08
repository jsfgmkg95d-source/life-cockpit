import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIMENSIONS, DIMENSION_LABELS, DIMENSION_WEIGHTS, type Dimension, type PlanDraft } from '../shared/day-contracts.ts';
import { normalizePlanScoring } from '../shared/plan-scoring.ts';
import { removeUnconfirmedCandidate } from '../shared/remove-task.ts';

function draft(groups: Partial<Record<Dimension, number[]>>): PlanDraft {
  return { day_mode: 'work', available_minutes: 60, change_reason: 'Synthetic edit', notes: 'Keep this note',
    dimensions: Object.fromEntries(DIMENSIONS.map(dimension => [dimension, { applicable: false, reason: '' }])) as PlanDraft['dimensions'],
    work_blocks: [{ id: 'shared', title: 'Shared time', budget_minutes: 60 }],
    tasks: DIMENSIONS.flatMap(dimension => (groups[dimension] ?? []).map((weight, index) => ({ candidate_id: `${dimension}-${index}`, task_id: `existing-${dimension}-${index}`,
      project_id: 'synthetic-project', title: `Task ${dimension} ${index}`, acceptance: 'User decides', result_type: 'binary' as const,
      metric_key: null, target_value: 1, scoring_dimension: dimension, raw_points: weight, estimated_minutes: null, work_block_id: 'shared' }))) };
}

test('valid positive allocations are preserved, detached from the input and idempotent', () => {
  const source = draft({ cashflow: [30, 15, 5], asset: [20, 10] });
  source.dimensions.cashflow = source.dimensions.asset = { applicable: true, reason: '' };
  source.dimensions.health.reason = 'A deliberate rest day for this dimension';
  source.dimensions.learning.reason = 'No learning tasks today';
  const before = structuredClone(source), normalized = normalizePlanScoring(source);
  assert.deepEqual(normalized, before); assert.notEqual(normalized, source); assert.notEqual(normalized.tasks[0], source.tasks[0]);
  assert.deepEqual(normalizePlanScoring(normalized), normalized); assert.deepEqual(source, before);
  normalized.work_blocks[0].title = 'Changed copy'; assert.equal(source.work_blocks[0].title, 'Shared time');
});

test('task membership controls applicability and an incomplete total is allocated automatically', () => {
  const source = draft({ cashflow: [24, 25], asset: [0] }); source.dimensions.learning = { applicable: true, reason: '' };
  const before = structuredClone(source), normalized = normalizePlanScoring(source);
  assert.deepEqual(normalized.tasks.map(task => task.raw_points), [24, 26, 30]);
  assert.deepEqual(normalized.dimensions.cashflow, { applicable: true, reason: '' });
  assert.deepEqual(normalized.dimensions.asset, { applicable: true, reason: '' });
  assert.deepEqual(normalized.dimensions.learning, { applicable: false, reason: '本日未安排此维度任务' });
  assert.deepEqual(source, before); assert.deepEqual(normalizePlanScoring(normalized), normalized);
});

test('unassigned tasks receive the positive mean; all-unassigned tasks split the budget', () => {
  const normalized = normalizePlanScoring(draft({ asset: [20, 10, 0], cashflow: [0, 0, 0] }));
  assert.deepEqual(normalized.tasks.filter(task => task.scoring_dimension === 'asset').map(task => task.raw_points), [13, 7, 10]);
  assert.deepEqual(normalized.tasks.filter(task => task.scoring_dimension === 'cashflow').map(task => task.raw_points), [17, 17, 16]);
});

test('removing a draft task preserves blank weights so remaining new tasks receive an equal default', () => {
  const source = draft({ asset: [20, 10, 0] });
  const removed = removeUnconfirmedCandidate(source, 'asset-0');
  assert.deepEqual(removed.tasks.map(task => task.raw_points), [10, 0]);
  assert.deepEqual(normalizePlanScoring(removed).tasks.map(task => task.raw_points), [15, 15]);
  assert.deepEqual(source.tasks.map(task => task.raw_points), [20, 10, 0]);
  assert.equal(removed.work_blocks.length, 1);
  assert.equal(removeUnconfirmedCandidate(removeUnconfirmedCandidate(removed, 'asset-1'), 'asset-2').work_blocks.length, 0);
});

test('moving the last task disables its former dimension without changing task identity or time', () => {
  const source = draft({ cashflow: [50], asset: [30] }); source.tasks[0].scoring_dimension = 'asset';
  const normalized = normalizePlanScoring(source);
  assert.equal(normalized.dimensions.cashflow.applicable, false); assert.equal(normalized.dimensions.asset.applicable, true);
  assert.equal(normalized.tasks.reduce((sum, task) => sum + task.raw_points, 0), 30);
  assert.deepEqual(normalized.tasks.map(({ raw_points: _weight, ...task }) => task), source.tasks.map(({ raw_points: _weight, ...task }) => task));
  assert.deepEqual(normalized.work_blocks, source.work_blocks);
});

test('empty work plans keep their content and rest plans never discard invalid tasks', () => {
  const empty = draft({}); empty.dimensions.cashflow.applicable = true;
  const normalized = normalizePlanScoring(empty);
  assert.ok(DIMENSIONS.every(dimension => !normalized.dimensions[dimension].applicable && normalized.dimensions[dimension].reason));
  assert.deepEqual(normalized.work_blocks, empty.work_blocks); assert.deepEqual(normalized.tasks, []);
  const rest = draft({ cashflow: [0] }); rest.day_mode = 'rest';
  assert.deepEqual(normalizePlanScoring(rest), rest);
});

test('dimension task limits and invalid weights produce actionable Chinese errors', () => {
  for (const dimension of DIMENSIONS) {
    const limit = DIMENSION_WEIGHTS[dimension];
    const maximum = normalizePlanScoring(draft({ [dimension]: Array(limit).fill(0) }));
    assert.ok(maximum.tasks.every(task => task.raw_points === 1));
    assert.throws(() => normalizePlanScoring(draft({ [dimension]: Array(limit + 1).fill(0) })), new RegExp(`${DIMENSION_LABELS[dimension]}最多安排 ${limit} 项任务`, 'u'));
  }
  for (const weight of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
    assert.throws(() => normalizePlanScoring(draft({ asset: [weight] })), /长期资产的相对权重/u);
  }
});

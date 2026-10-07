import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { PlanSnapshot } from '../shared/day-contracts.ts';
import type { ScoreInput } from '../shared/score-contracts.ts';
import { DEFAULT_SCORE_POLICY } from '../shared/score-contracts.ts';
import { calculateScore } from '../shared/scoring.ts';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/scoring-cases.json', import.meta.url), 'utf8'));
function input(weights: number[], actuals: (number | null)[], targets: number[], complete = true): ScoreInput {
  const plan: PlanSnapshot = { schema_version: 1, plan_version: 1, previous_plan_version: null, confirmed_at: '2026-09-18T00:00:00Z', policy: { id: 'default-v1', version: 1, dimension_weights: { cashflow: 50, asset: 30, health: 10, learning: 10 } }, over_capacity_acknowledged: false, day_mode: 'work', available_minutes: 135, dimensions: { cashflow: { applicable: true, reason: '' }, asset: { applicable: false, reason: '测试' }, health: { applicable: false, reason: '测试' }, learning: { applicable: false, reason: '测试' } }, work_blocks: [], change_reason: '', notes: '', tasks: weights.map((weight, i) => ({ task_id: String(i), candidate_id: String(i), project_id: String(i), project_name: `项目${i}`, title: `任务${i}`, acceptance: '测试验收', result_type: 'quant', metric_key: 'accepted_words', target_value: targets[i], raw_points: weight, scoring_dimension: 'cashflow', estimated_minutes: null, work_block_id: 'test' })) };
  return { schema_version: 1, policy: DEFAULT_SCORE_POLICY, business_date: '2026-09-18', timezone: 'Asia/Shanghai', record_state: complete ? 'complete' : 'incomplete', plan, effective_events: [], work_block_actuals: [], results: actuals.map((actual, i) => ({ task_id: String(i), result: actual === null ? null : { actual_value: actual, evidence_event_ids: [], evidence_hash: 'test', explanation: '测试', confirmed_at: '2026-09-18T00:00:00Z', confirmed_by: 'user' } })) };
}
for (const sample of fixtures.scoring_cases) test(`第一天评分契约 ${sample.id} ${sample.name}`, () => {
  const state = input(sample.tasks.map((t: { w: number }) => t.w), sample.tasks.map((t: { r: number | null }) => t.r === null ? null : Math.round(t.r * 100)), sample.tasks.map(() => 100), sample.record_complete);
  if (!sample.plan_confirmed) state.plan = null;
  else state.plan!.day_mode = sample.mode;
  const score = calculateScore(state);
  assert.equal(score.status, sample.expected.state);
  for (const [field, expected] of Object.entries({ lower_bound: sample.expected.lower, upper_bound: sample.expected.upper, coverage_basis_points: sample.expected.coverage, final_score: sample.expected.final })) assert.equal(score[field as 'lower_bound'], expected === null ? null : Math.round(Number(expected) * 100));
  if (sample.id === 'S03') { assert.equal(score.display.lower, '81.3'); assert.equal(score.display.coverage, '93.8'); }
});
test('精确比例直接显示，避免两次舍入；大安全整数和任务拆分不漂移', () => {
  const s = calculateScore(input([50], [81249], [100000]));
  assert.equal(s.final_score, 8125); assert.equal(s.display.final, '81.2');
  assert.equal(calculateScore(input([50], [Number.MAX_SAFE_INTEGER - 1], [Number.MAX_SAFE_INTEGER])).final_score, 10000);
  assert.equal(calculateScore(input([25, 25], [1, 1], [3, 3])).final_score, 3333);
  assert.equal(calculateScore(input([50], [1], [3])).final_score, 3333);
  assert.equal(calculateScore(input([], [], [])).reason, 'no_eligible_tasks');
});

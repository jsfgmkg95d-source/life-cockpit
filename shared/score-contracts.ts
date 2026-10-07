import type { AssetEvent, ConfirmedResult, Dimension, PlanSnapshot, WorkBlockActual } from './day-contracts.ts';

export const DEFAULT_SCORE_POLICY = {
  id: 'default-v1', version: 1,
  dimension_weights: { cashflow: 50, asset: 30, health: 10, learning: 10 },
  rules: { formula: 'weighted-capped-ratio-v1', unknown: 'bounds', rounding: 'HALF_UP', display_decimals: 1, storage_decimals: 2 },
};

export interface ScoreInput {
  schema_version: 1;
  policy: typeof DEFAULT_SCORE_POLICY;
  business_date: string;
  timezone: string;
  record_state: 'incomplete' | 'complete';
  plan: PlanSnapshot | null;
  results: { task_id: string; result: ConfirmedResult | null }[];
  effective_events: AssetEvent[];
  work_block_actuals: WorkBlockActual[];
}
export interface ScoreCalculation {
  status: 'provisional' | 'finalized' | 'not_applicable';
  reason: 'rest' | 'unplanned' | 'no_eligible_tasks' | null;
  final_score: number | null;
  lower_bound: number | null;
  upper_bound: number | null;
  coverage_basis_points: number | null;
  display: { lower: string; upper: string; coverage: string; final: string };
  denominator: number;
  missing_task_ids: string[];
  tasks: { task_id: string; title: string; project_name: string; dimension: Dimension; weight: number; actual: number | null; target: number; contribution: string; completion: string; evidence_event_ids: string[] }[];
}
export interface SavedScore extends ScoreCalculation {
  id: string;
  score_version: number;
  plan_version: number;
  policy_id: string;
  policy_version: number;
  input_hash: string;
  input_snapshot: ScoreInput;
  created_at: string;
}
export interface ScoreView {
  business_date: string;
  revision: number;
  plan_version: number;
  dimensions: PlanSnapshot['dimensions'] | null;
  preview: ScoreCalculation;
  current_score_id: string | null;
  history: SavedScore[];
  comparisons: { plan_version: number; change_reason: string; score: ScoreCalculation }[];
  can_settle: boolean;
}

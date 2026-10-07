import type { MetricKey } from './contracts.ts';

export const DIMENSIONS = ['cashflow', 'asset', 'health', 'learning'] as const;
export type Dimension = typeof DIMENSIONS[number];
export const DIMENSION_WEIGHTS: Record<Dimension, number> = { cashflow: 50, asset: 30, health: 10, learning: 10 };
export const DIMENSION_LABELS: Record<Dimension, string> = { cashflow: '现金流', asset: '长期资产', health: '身体健康', learning: '学习成长' };
export type DeltaMetric = Exclude<MetricKey, 'followers'>;
export const EVENT_STAGES = ['finalized', 'submitted', 'approved', 'published', 'completed'] as const;
export type EventStage = typeof EVENT_STAGES[number];
export const EVENT_STAGE_LABELS: Record<EventStage, string> = { finalized: '已验收 / 定稿', submitted: '提交成功', approved: '审核通过', published: '公开可读', completed: '验收达成' };
export type TaskStatus = 'todo' | 'doing' | 'done' | 'cancelled';

export interface PlanCandidate {
  candidate_id: string;
  task_id: string | null;
  project_id: string;
  title: string;
  acceptance: string;
  result_type: 'quant' | 'binary';
  metric_key: DeltaMetric | null;
  target_value: number | null;
  scoring_dimension: Dimension;
  raw_points: number;
  estimated_minutes: number | null;
  work_block_id: string;
}
export interface WorkBlock { id: string; title: string; budget_minutes: number | null }
export interface DimensionChoice { applicable: boolean; reason: string }
export interface PlanDraft {
  day_mode: 'work' | 'rest';
  available_minutes: number | null;
  dimensions: Record<Dimension, DimensionChoice>;
  tasks: PlanCandidate[];
  work_blocks: WorkBlock[];
  change_reason: string;
  notes: string;
}
export interface SnapshotTask extends PlanCandidate { task_id: string; project_name: string }
export interface PlanSnapshot extends Omit<PlanDraft, 'tasks'> {
  schema_version: 1;
  plan_version: number;
  previous_plan_version: number | null;
  confirmed_at: string;
  policy: { id: 'default-v1'; version: 1; dimension_weights: Record<Dimension, number> };
  tasks: SnapshotTask[];
  over_capacity_acknowledged: boolean;
}
export interface ConfirmedResult {
  actual_value: number;
  evidence_event_ids: string[];
  evidence_hash: string;
  explanation: string;
  confirmed_at: string;
  confirmed_by: 'user';
}
export interface DailyTask extends SnapshotTask {
  daily_log_id: string;
  status: TaskStatus;
  result_state: 'unknown' | 'confirmed';
  confirmed_result: ConfirmedResult | null;
  eligible: boolean;
  created_at: string;
  updated_at: string;
}
export interface WorkBlockActual { block_id: string; minutes: number; source: string; updated_at: string }
export interface DailyLog {
  id: string;
  business_date: string;
  timezone: string;
  revision: number;
  current_plan_version: number;
  draft_plan: PlanDraft | null;
  plan_snapshots: PlanSnapshot[];
  work_block_actuals: WorkBlockActual[];
  record_state: 'incomplete' | 'complete';
  created_at: string;
  updated_at: string;
}
export interface EventInput {
  chapter_numbers?: number[];
  project_id: string;
  task_id: string | null;
  artifact_key: string;
  metric_key: DeltaMetric;
  value: number;
  stage: EventStage;
  summary: string;
  source: string;
}
export interface AssetEvent extends Omit<EventInput, 'value'> {
  evidence_sources?: string[];
  id: string;
  daily_log_id: string;
  occurred_on: string;
  /** Day 3 records date precision explicitly, never invents an occurrence time. */
  occurrence_precision: 'date';
  timezone: string;
  value: number | null;
  measurement_scope: 'project';
  period_key: 'lifetime';
  confirmation_state: 'user_confirmed';
  change_kind: 'record' | 'replace' | 'void';
  supersedes_event_id: string | null;
  root_event_id: string;
  correction_reason: string | null;
  created_at: string;
}
export interface DayState {
  pinned_task_ids?: string[];
  business_date: string;
  timezone: string;
  log: DailyLog | null;
  tasks: DailyTask[];
  events: AssetEvent[];
  effective_events: AssetEvent[];
  suggested_draft: PlanDraft;
}
export interface DayWrite { requestId: string; revision: number }
export interface DraftWrite extends DayWrite { draft: PlanDraft }
export interface ConfirmPlanWrite extends DraftWrite { acknowledgeOverCapacity: boolean }
export interface StatusWrite extends DayWrite { status: TaskStatus }
export interface CompletionWrite extends DayWrite {
  completed: boolean;
  /** Plain attribution only; omitted means manual. Never executed. */
  source?: string;
  /** Optional user-defined completion marker, saved in the mutation receipt. */
  marker?: string;
}
export interface RemoveTaskWrite extends DayWrite { reason: string }
export interface ResultWrite extends DayWrite {
  /** Only binary tasks accept 0/1. Quant results are derived on the server. */
  binary_value: number | null;
  explanation: string;
  clear: boolean;
}
export interface EventWrite extends DayWrite { event: EventInput }
export interface CorrectionWrite extends DayWrite {
  chapter_numbers?: number[];
  kind: 'replace' | 'void';
  value: number | null;
  stage: EventStage;
  summary: string;
  source: string;
  reason: string;
}
export interface ActualWrite extends DayWrite { block_id: string; minutes: number | null; source: string }
export interface FinishWrite extends DayWrite {
  github_chapters?: number[];
  event: EventInput | null;
  result: { binary_value: number | null; explanation: string } | null;
  actual: { minutes: number; source: string } | null;
  mark_done: boolean;
}

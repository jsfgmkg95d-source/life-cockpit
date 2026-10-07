import type { Dimension } from './day-contracts.ts';
import type { GrowthView } from './growth-contracts.ts';

export type ReportType = 'plan' | 'review';
export interface AiSettings { mode: 'local' | 'openai'; model: string; max_output_tokens: number; daily_call_limit: number }
export interface AiSettingsView extends AiSettings { revision: number; has_key: boolean; calls_today: number }
export interface Fact { id: string; text: string }
export interface Suggestion { project_id: string; action: string; acceptance: string; estimated_minutes: number | null; displaces: string; source_ids: string[] }
export interface ReportContent {
  interpretations: { text: string; uncertainty: string; source_ids: string[] }[];
  gaps: { text: string; source_ids: string[] }[];
  suggestions: Suggestion[];
}
export interface ReportInput {
  schema_version: 1; prompt_version: 'ceo-v1' | 'ceo-v2'; date: string; timezone: string; type: ReportType;
  growth?: GrowthView;
  facts: Fact[];
  projects: { id: string; name: string; status: string; next_action: string | null; target_date: string | null }[];
  fingerprint: string;
  config_revision: number;
}
export interface Report {
  id: string; daily_log_id: string; report_type: ReportType; report_version: number;
  plan_version: number; score_id: string | null; input_hash: string; input_snapshot: ReportInput;
  status: 'running' | 'succeeded' | 'degraded' | 'failed'; content: ReportContent | null;
  run_meta: { provider: 'local' | 'openai'; model: string | null; request_id: string; started_at: string; finished_at: string | null; attempts: { code: string; at: string }[]; input_tokens: number | null; output_tokens: number | null; cost_estimate: null; fallback_reason: string | null };
  created_at: string; updated_at: string; stale: boolean;
}
export interface Adoption { report_id: string; suggestion_index: number; target_date: string; candidate_id: string; created_at: string }
export interface ReportView { date: string; revision: number; input_hash: string; facts: Fact[]; reports: Report[]; adoptions: Adoption[]; settings: AiSettingsView }
export interface GenerateReport { requestId: string; revision: number; input_hash: string; force: boolean }
export interface AdoptSuggestion { requestId: string; target_date: string; target_revision: number; suggestion_index: number; action: string; acceptance: string; estimated_minutes: number | null; dimension: Dimension; change_reason: string }

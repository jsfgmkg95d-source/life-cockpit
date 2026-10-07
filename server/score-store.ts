import { createHash, randomUUID } from 'node:crypto';
import type { DayState, DayWrite, PlanSnapshot } from '../shared/day-contracts.ts';
import type { SavedScore, ScoreInput, ScoreView } from '../shared/score-contracts.ts';
import { DEFAULT_SCORE_POLICY } from '../shared/score-contracts.ts';
import { calculateScore } from '../shared/scoring.ts';
import { DayStore } from './day-store.ts';
import { AppError, invalid } from './errors.ts';
import type { Store } from './store.ts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(input: ScoreInput): string { return createHash('sha256').update(canonical(input)).digest('hex'); }
export function scoreInput(state: DayState, plan: PlanSnapshot | null): ScoreInput {
  return {
    schema_version: 1, policy: structuredClone(DEFAULT_SCORE_POLICY), business_date: state.business_date, timezone: state.timezone,
    record_state: plan && plan.plan_version === state.log?.current_plan_version ? state.log!.record_state : 'incomplete', plan,
    results: (plan?.tasks ?? []).map(task => { const current = state.tasks.find(item => item.task_id === task.task_id); return { task_id: task.task_id, result: current?.result_state === 'confirmed' ? current.confirmed_result : null }; }).sort((a, b) => a.task_id.localeCompare(b.task_id)),
    effective_events: [...state.effective_events].sort((a, b) => a.id.localeCompare(b.id)),
    work_block_actuals: [...(state.log?.work_block_actuals ?? [])].sort((a, b) => a.block_id.localeCompare(b.block_id)),
  };
}
function fromRow(row: Record<string, unknown>): SavedScore {
  return { ...JSON.parse(String(row.calculation_json)), id: String(row.id), score_version: Number(row.score_version), plan_version: Number(row.plan_version), policy_id: String(row.policy_id), policy_version: Number(row.policy_version), input_hash: String(row.input_hash), input_snapshot: JSON.parse(String(row.input_snapshot_json)), created_at: String(row.created_at) };
}
export class ScoreStore {
  store: Store;
  days: DayStore;
  constructor(store: Store) { this.store = store; this.days = new DayStore(store); }
  getView(date: string): ScoreView {
    // A single synchronous SQLite read transaction prevents mixing another
    // process's task updates with an older plan/history during preview.
    this.store.database.exec('BEGIN');
    try { const view = this.readView(date); this.store.database.exec('COMMIT'); return view; }
    catch (error) { this.store.database.exec('ROLLBACK'); throw error; }
  }
  private readView(date: string): ScoreView {
    const state = this.days.getState(date);
    const plan = state.log?.plan_snapshots.find(item => item.plan_version === state.log!.current_plan_version) ?? null;
    const input = scoreInput(state, plan);
    const preview = calculateScore(input);
    const history = state.log ? this.store.database.prepare('SELECT * FROM scores WHERE daily_log_id=? ORDER BY score_version DESC').all(state.log.id).map(fromRow) : [];
    return { business_date: date, revision: state.log?.revision ?? 0, plan_version: plan?.plan_version ?? 0, dimensions: plan?.dimensions ?? null, preview,
      current_score_id: history.find(item => item.plan_version === (plan?.plan_version ?? 0) && item.input_hash === hash(input))?.id ?? null,
      history, can_settle: !!plan && state.log?.record_state !== 'complete' && (plan.day_mode === 'rest' || (preview.reason === null && !preview.missing_task_ids.length)),
      comparisons: (state.log?.plan_snapshots ?? []).filter(item => item.plan_version !== plan?.plan_version).map(item => ({ plan_version: item.plan_version, change_reason: item.change_reason, score: calculateScore(scoreInput(state, item)) })),
    };
  }
  // Caller holds the write transaction; used by report creation without settling.
  persistCurrent(date: string): string {
    const now = new Date().toISOString();
    const state = this.days.getState(date);
    if (!state.log) throw new Error("Daily log required");
    const plan = state.log!.plan_snapshots.find(item => item.plan_version === state.log!.current_plan_version) ?? null;
    const snapshot = scoreInput(state, plan);
    const inputHash = hash(snapshot);
    const policyId = plan?.policy.id ?? 'default-v1';
    const policyVersion = plan?.policy.version ?? 1;
    const policy = this.store.database.prepare('SELECT * FROM score_policies WHERE id=? AND version=?').get(policyId, policyVersion);
    if (!policy || canonical(JSON.parse(String(policy.rules_json))) !== canonical(snapshot.policy.rules) || (plan && canonical(JSON.parse(String(policy.dimension_weights_json))) !== canonical(plan.policy.dimension_weights))) invalid('计划评分口径与已保存政策不一致，无法生成评分。');
    if (!this.store.database.prepare('SELECT id FROM scores WHERE daily_log_id=? AND plan_version=? AND policy_id=? AND input_hash=?').get(state.log!.id, plan?.plan_version ?? 0, policyId, inputHash)) {
      const version = Number(this.store.database.prepare('SELECT coalesce(max(score_version),0)+1 AS version FROM scores WHERE daily_log_id=?').get(state.log!.id)!.version);
      this.store.database.prepare('INSERT INTO scores(id,daily_log_id,score_version,plan_version,policy_id,policy_version,input_hash,input_snapshot_json,calculation_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), state.log!.id, version, plan?.plan_version ?? 0, policyId, policyVersion, inputHash, canonical(snapshot), JSON.stringify(calculateScore(snapshot)), now);
    }
    return String(this.store.database.prepare("SELECT id FROM scores WHERE daily_log_id=? AND plan_version=? AND policy_id=? AND input_hash=?").get(state.log.id, plan?.plan_version ?? 0, policyId, inputHash)!.id);
  }
  write(date: string, input: DayWrite, settle: boolean): ScoreView {
    this.store.idempotent(`score:${date}:${settle ? 'settle' : 'calculate'}`, input.requestId, input, () => {
      let state = this.days.getState(date);
      if ((state.log?.revision ?? 0) !== input.revision) throw new AppError(409, 'REVISION_CONFLICT', '当天记录已变化，请读取最新内容并核对后再结算。');
      const preview = this.readView(date);
      if (settle && !preview.can_settle && state.log?.record_state !== 'complete') invalid('请先确认计划及全部任务结果；未知结果不能按零分结算。');
      const now = new Date().toISOString();
      if (!state.log) {
        this.store.database.prepare('INSERT INTO daily_logs(id,business_date,timezone,created_at,updated_at) VALUES(?,?,?,?,?)').run(randomUUID(), date, state.timezone, now, now);
      }
      this.store.database.prepare('UPDATE daily_logs SET revision=revision+1,record_state=CASE WHEN ? THEN ? ELSE record_state END,updated_at=? WHERE business_date=?').run(settle ? 1 : 0, 'complete', now, date);
      state = this.days.getState(date);
      this.persistCurrent(date);
      return { accepted: true };
    });
    return this.getView(date);
  }
}

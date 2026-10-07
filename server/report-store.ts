import { usageCount } from './ai-usage.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './store.ts';
import { DayStore } from './day-store.ts';
import { ScoreStore, scoreInput } from './score-store.ts';
import { calculateScore } from '../shared/scoring.ts';
import { METRICS } from '../shared/contracts.ts';
import { EVENT_STAGE_LABELS } from '../shared/day-contracts.ts';
import type { PlanDraft } from '../shared/day-contracts.ts';
import type { AdoptSuggestion, AiSettings, AiSettingsView, GenerateReport, Report, ReportContent, ReportInput, ReportType, ReportView } from '../shared/report-contracts.ts';
import type { KeyVault } from './ai-vault.ts';
import { localSummary, openAiProvider, ProviderError, validateContent } from './ai-provider.ts';
import type { AiProvider } from './ai-provider.ts';
import { AppError, invalid } from './errors.ts';
import { parseDraft } from './day-validation.ts';
import { growth } from './growth-store.ts';

function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`; return JSON.stringify(value); }
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
function toReport(row: Record<string, unknown>, hash: string): Report { return { id: String(row.id), daily_log_id: String(row.daily_log_id), report_type: row.report_type as ReportType, report_version: Number(row.report_version), plan_version: Number(row.plan_version), score_id: row.score_id as string | null, input_hash: String(row.input_hash), input_snapshot: JSON.parse(String(row.input_snapshot_json)), status: row.status as Report['status'], content: row.content_json === null ? null : JSON.parse(String(row.content_json)), run_meta: JSON.parse(String(row.run_meta_json)), created_at: String(row.created_at), updated_at: String(row.updated_at), stale: row.input_hash !== hash }; }

export class ReportStore {
  store: Store; days: DayStore; scores: ScoreStore; vault: KeyVault; provider: AiProvider;
  jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  savingConfig = false;
  timeoutMs: number;
  constructor(store: Store, vault: KeyVault, provider = openAiProvider, timeoutMs = 20_000) {
    this.store = store; this.days = new DayStore(store); this.scores = new ScoreStore(store); this.vault = vault; this.provider = provider; this.timeoutMs = timeoutMs; this.recover(true);
  }
  today(): string { return new Intl.DateTimeFormat('en-CA', { timeZone: this.store.getState().settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  settings(): AiSettingsView {
    const row = this.store.database.prepare('SELECT * FROM ai_settings WHERE id=1').get()!;
    return { ...JSON.parse(String(row.settings_json)), revision: Number(row.revision), has_key: this.vault.has(), calls_today: usageCount(this.store.database, this.today()) };
  }
  async saveSettings(revision: number, settings: AiSettings, key: string | undefined, clearKey: boolean) {
    if (this.savingConfig || this.jobs.size || this.store.database.prepare("SELECT id FROM reports WHERE status='running' LIMIT 1").get()) throw new AppError(409, 'AI_BUSY', '请等待当前生成结束后再修改 AI 配置。');
    if (this.settings().revision !== revision) throw new AppError(409, 'REVISION_CONFLICT', 'AI 设置已变化，请重新读取。');
    this.savingConfig = true;
    try {
      if (clearKey || key) { try { await this.vault.save(clearKey ? null : key!); } catch { throw new AppError(503, 'KEY_STORAGE_UNAVAILABLE', '密钥未能安全保存；配置未更新。'); } }
      this.store.transaction(() => { if (this.settings().revision !== revision) throw new AppError(409, 'REVISION_CONFLICT', 'AI 设置已变化，请重新读取。'); this.store.database.prepare('UPDATE ai_settings SET settings_json=?,revision=revision+1 WHERE id=1').run(JSON.stringify(settings)); });
      return this.settings();
    } finally { this.savingConfig = false; }
  }
  snapshot(date: string, type: ReportType): ReportInput {
    const state = this.days.getState(date); const app = this.store.getState(); const plan = state.log?.plan_snapshots.at(-1) ?? null;
    const scoredInput = scoreInput(state, plan); const score = calculateScore(scoredInput);
    const projects = app.projects.map(project => ({ id: project.id, name: project.name, status: project.status, next_action: project.next_action, target_date: project.target_date }));
    const history = growth(this.store, date);
    const facts = [
      { id: 'scope', text: `业务日 ${date}，时区 ${state.timezone}。含当日记录、当前项目档案和截至当日的7/30日记录。未提供收入或粉丝数据；缺记录不等于没有工作；历史统计按当前有效更正重算。` },
      { id: 'history-coverage', text: `近7日 ${history.start7}—${date} 有记录 ${history.recordedDays7}/7 天；前7日 ${history.previousStart}—${history.previousEnd} 有记录 ${history.recordedDaysPrevious}/7 天；近30日有记录 ${history.recordedDays30}/30 天。有记录不代表全天资料完整。近7日已记录用时 ${history.actualMinutes7 ?? '未知'} 分钟，来自 ${history.timeDays7} 天，共享时段只计一次。` },
      ...history.projects.map(project => ({ id: `trend:${project.id}`, text: `${project.name}：${project.metrics.map(m => `${m.label}近7日已辨认 ${m.recent7}${m.unit}（${m.recentUnresolved}批未核对），前7日 ${m.previous7}${m.unit}（${m.previousUnresolved}批未核对），近30日 ${m.recent30}${m.unit}，全部记录${m.unresolved}批身份待核对`).join('；') || '没有成果记录，实际推进未知'}。${project.stockNote}` })),
      ...history.adoptions.map((item, index) => ({ id: `followup:${index}`, text: `曾采纳建议：${item.action}；目标日 ${item.targetDate}；${item.state}；观察结果：${item.observed}。执行结果不能单独证明建议导致经营改善。` })),
      { id: 'plan', text: plan ? `计划 v${plan.plan_version}，${plan.day_mode === 'rest' ? '休息日' : '工作日'}；计划预算 ${plan.work_blocks.reduce((sum, block) => sum + (block.budget_minutes ?? 0), 0)} 分钟；可用容量 ${plan.available_minutes ?? '未知'}。` : '尚未确认当日计划；项目参考预算不是实际投入。' },
      { id: 'capacity', text: `设置中的默认可用容量为 ${app.settings.available_minutes ?? '未知'} 分钟；当日容量以用户确认计划为准。` },
      ...app.settings.shared_budget_groups.map(group => ({ id: `shared:${group.id}`, text: `${group.title}：${group.project_ids.map(id => app.projects.find(project => project.id === id)?.name).join('、')}共用参考预算 ${group.budget_minutes} 分钟，只累计一次；未指定各自分钟，不能均分。` })),
      ...app.projects.filter(project => !app.settings.shared_budget_groups.some(group => group.project_ids.includes(project.id))).map(project => ({ id: `budget:${project.id}`, text: `${project.name}参考日预算 ${project.daily_budget_minutes ?? '未知'} 分钟，不是实际投入。` })),
      { id: 'draft', text: state.log?.draft_plan ? `已有未确认草稿：${state.log.draft_plan.tasks.map(task => `${app.projects.find(project => project.id === task.project_id)?.name}：${task.title}（验收：${task.acceptance || '待填写'}）`).join('；') || '尚无任务'}。草稿可用容量 ${state.log.draft_plan.available_minutes ?? '未知'} 分钟，尚未成为承诺。` : '当天没有已保存的计划草稿。' },
      { id: 'score', text: score.status === 'not_applicable' ? '履约评分不适用，无分数。' : `履约${score.status === 'finalized' ? '已结算' : '未结算'}；分数范围 ${score.display.lower}—${score.display.upper}；结果确认覆盖率 ${score.display.coverage}%；未知 ${score.missing_task_ids.length} 项。覆盖率不是完成率。` },
      ...app.projects.map(project => ({ id: `project:${project.id}`, text: `${project.name}（${project.platform ?? '平台未填'}），状态 ${{preparing:'准备中',active:'进行中',paused:'已暂停',completed:'已完成',archived:'已归档'}[project.status]}，下一步 ${project.next_action ?? '未记录'}，里程碑 ${project.next_milestone ?? '未记录'}，目标 ${project.target_value ?? '未知'} ${METRICS.find(metric => metric.key === project.primary_metric_key)?.unit ?? ''}，截止 ${project.target_date ?? '未知'}；基线 ${project.baseline_value ?? '未知'}，日期 ${project.baseline_at ?? '未知'}，来源 ${project.baseline_source ?? '未知'}。` })),
      ...(plan?.tasks ?? []).map(task => { const result = state.tasks.find(item => item.task_id === task.task_id)?.confirmed_result; return { id: `task:${task.task_id}`, text: `${task.project_name}：${task.title}。验收：${task.acceptance}。目标 ${task.target_value} ${METRICS.find(metric => metric.key === task.metric_key)?.label ?? '离散验收'}，确认结果 ${result ? result.actual_value : '未知'}${result ? `（用户确认；${result.explanation || '无补充说明'}）` : ''}。` }; }),
      ...state.effective_events.map(event => ({ id: `event:${event.id}`, text: `${app.projects.find(project => project.id === event.project_id)?.name}，${event.artifact_key}：${METRICS.find(metric => metric.key === event.metric_key)?.label} ${event.value}，${EVENT_STAGE_LABELS[event.stage]}；${event.summary}；来源 ${event.source}（用户确认，发生于${event.occurred_on}）。` })),
      { id: 'actuals', text: !state.log?.work_block_actuals.length ? '实际投入尚未记录，不能用预算替代。' : `已记录实际投入合计 ${state.log.work_block_actuals.reduce((sum, actual) => sum + actual.minutes, 0)} 分钟；共享块只计一次，未填写的时段仍未知。` },
    ];
    return { schema_version: 1, prompt_version: 'ceo-v2', date, timezone: state.timezone, type, projects, facts, growth: history, fingerprint: digest({ score: scoredInput, projects: app.projects, draft: state.log?.draft_plan ?? null, settings: app.settings, history }), config_revision: this.settings().revision };
  }
  getView(date: string, type: ReportType): ReportView {
    this.recover();
    return this.store.transaction(() => {
      const input = this.snapshot(date, type); const hash = digest(input); const log = this.days.findLog(date);
      const rows = log ? this.store.database.prepare('SELECT * FROM reports WHERE daily_log_id=? AND report_type=? ORDER BY report_version DESC').all(log.id, type) : [];
      const adoptions = log ? this.store.database.prepare('SELECT a.* FROM report_adoptions a JOIN reports r ON r.id=a.report_id WHERE r.daily_log_id=? AND r.report_type=?').all(log.id, type) : [];
      return { date, revision: log?.revision ?? 0, input_hash: hash, facts: input.facts, reports: rows.map(row => toReport(row, hash)), adoptions: adoptions as unknown as ReportView['adoptions'], settings: this.settings() };
    });
  }
  recover(startup = false) {
    for (const row of this.store.database.prepare("SELECT * FROM reports WHERE status='running'").all()) {
      if (!startup && String(row.lease_until) > new Date().toISOString() && alive(Number(row.owner_pid))) continue;
      const meta = JSON.parse(String(row.run_meta_json)); meta.finished_at = new Date().toISOString(); meta.fallback_reason = 'INTERRUPTED';
      this.store.database.prepare("UPDATE reports SET status='failed',run_meta_json=?,updated_at=? WHERE id=? AND status='running'").run(JSON.stringify(meta), meta.finished_at, String(row.id));
      this.store.database.prepare("UPDATE ai_calls SET status='INTERRUPTED' WHERE report_id=? AND status='running'").run(String(row.id));
    }
    // The instance lock proves there is no worker from a previous server.
    if (startup) this.store.database.prepare("UPDATE ai_calls SET status='INTERRUPTED' WHERE status='running'").run();
  }
  generate(date: string, type: ReportType, write: GenerateReport): ReportView {
    this.recover(); if (this.savingConfig) throw new AppError(409, 'AI_BUSY', 'AI 设置正在保存，请稍后重试。');
    let launch = false;
    const result = this.store.idempotent(`report:${date}:${type}`, write.requestId, write, () => {
      const state = this.days.getState(date); const input = this.snapshot(date, type); const hash = digest(input);
      if ((state.log?.revision ?? 0) !== write.revision || hash !== write.input_hash) throw new AppError(409, 'REVISION_CONFLICT', '项目或当天记录已变化，请读取最新依据再生成。');
      if (state.log && this.store.database.prepare("SELECT id FROM reports WHERE daily_log_id=? AND report_type=? AND status='running'").get(state.log.id, type)) throw new AppError(409, 'REPORT_RUNNING', '该日同类报告正在生成，稍后读取结果即可。');
      const previous = state.log && this.store.database.prepare("SELECT id FROM reports WHERE daily_log_id=? AND report_type=? AND input_hash=? AND status IN ('succeeded','degraded') ORDER BY report_version DESC LIMIT 1").get(state.log.id, type, hash);
      if (previous && !write.force) return { id: String(previous.id) };
      const now = new Date().toISOString();
      if (!state.log) this.store.database.prepare('INSERT INTO daily_logs(id,business_date,timezone,created_at,updated_at) VALUES(?,?,?,?,?)').run(randomUUID(), date, state.timezone, now, now);
      const log = this.days.findLog(date)!; const scoreId = type === 'review' ? this.scores.persistCurrent(date) : null;
      const version = Number(this.store.database.prepare('SELECT coalesce(max(report_version),0)+1 AS n FROM reports WHERE daily_log_id=? AND report_type=?').get(log.id, type)!.n);
      const settings = this.settings(); const id = randomUUID();
      const meta: Report['run_meta'] = { provider: settings.mode, model: settings.mode === 'openai' ? settings.model : null, request_id: write.requestId, started_at: now, finished_at: null, attempts: [], input_tokens: null, output_tokens: null, cost_estimate: null, fallback_reason: null };
      this.store.database.prepare('INSERT INTO reports(id,daily_log_id,report_type,report_version,plan_version,score_id,input_hash,input_snapshot_json,status,run_meta_json,owner_pid,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, log.id, type, version, log.current_plan_version, scoreId, hash, canonical(input), 'running', JSON.stringify(meta), process.pid, new Date(Date.now() + 120_000).toISOString(), now, now);
      launch = true;
      return { id };
    });
    const row = this.store.database.prepare('SELECT status FROM reports WHERE id=?').get(result.id)!;
    if (launch && row.status === 'running' && !this.jobs.has(result.id)) {
      const controller = new AbortController();
      const done = Promise.resolve().then(() => this.run(result.id, controller)).catch(() => {
        const failed = this.store.database.prepare('SELECT run_meta_json FROM reports WHERE id=?').get(result.id);
        if (failed) { const meta = JSON.parse(String(failed.run_meta_json)); meta.finished_at = new Date().toISOString(); meta.fallback_reason = 'LOCAL_SUMMARY_FAILED'; this.store.database.prepare("UPDATE reports SET status='failed',content_json=NULL,run_meta_json=?,updated_at=? WHERE id=? AND status='running'").run(JSON.stringify(meta), meta.finished_at, result.id); }
      }).finally(() => this.jobs.delete(result.id));
      this.jobs.set(result.id, { controller, done });
    }
    return this.getView(date, type);
  }
  reserveCall(reportId: string | null): string {
    return this.store.transaction(() => { const config = this.settings(); if (config.calls_today >= config.daily_call_limit) throw new ProviderError('DAILY_LIMIT'); const id = randomUUID(); this.store.database.prepare('INSERT INTO ai_calls(id,day,report_id,status,created_at) VALUES(?,?,?,?,?)').run(id, this.today(), reportId, 'running', new Date().toISOString()); return id; });
  }
  async callProvider(input: ReportInput, config: AiSettings, key: string, parent: AbortSignal, reportId: string | null) {
    if (parent.aborted) throw new ProviderError('CANCELLED');
    const id = this.reserveCall(reportId); const signal = AbortSignal.any([parent, AbortSignal.timeout(this.timeoutMs)]);
    try {
      const response = await this.provider(input, config, key, signal);
      this.store.database.prepare('UPDATE ai_calls SET status=?,input_tokens=?,output_tokens=? WHERE id=?').run('succeeded', response.input_tokens, response.output_tokens, id);
      return response;
    } catch (error) { const safe = parent.aborted ? new ProviderError('CANCELLED') : signal.aborted ? new ProviderError('TIMEOUT') : error instanceof ProviderError ? error : new ProviderError('INVALID_OUTPUT'); this.store.database.prepare('UPDATE ai_calls SET status=? WHERE id=?').run(safe.code, id); throw safe; }
  }
  async run(id: string, controller: AbortController): Promise<void> {
    const row = this.store.database.prepare('SELECT * FROM reports WHERE id=?').get(id)!; const input = JSON.parse(String(row.input_snapshot_json)) as ReportInput; const meta = JSON.parse(String(row.run_meta_json)) as Report['run_meta'];
    let content: ReportContent = localSummary(input); let status: Report['status'] = 'degraded';
    try {
      const config = this.settings();
      if (controller.signal.aborted) throw new ProviderError('CANCELLED');
      if (config.mode === 'local') throw new ProviderError('LOCAL_MODE');
      if (!config.model) throw new ProviderError('MODEL_NOT_CONFIGURED');
      const key = await this.vault.read(); if (!key) throw new ProviderError('KEY_NOT_CONFIGURED');
      if (Buffer.byteLength(JSON.stringify(input)) > 60_000) throw new ProviderError('INPUT_TOO_LARGE');
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await this.callProvider(input, config, key, controller.signal, id);
          if (response.input_tokens !== null) meta.input_tokens = (meta.input_tokens ?? 0) + response.input_tokens;
          if (response.output_tokens !== null) meta.output_tokens = (meta.output_tokens ?? 0) + response.output_tokens;
          content = validateContent(response.content, input); meta.attempts.push({ code: 'OK', at: new Date().toISOString() }); status = 'succeeded'; break;
        } catch (error) {
          const safe = error instanceof ProviderError ? error : new ProviderError('INVALID_OUTPUT'); meta.attempts.push({ code: safe.code, at: new Date().toISOString() });
          if (!safe.retryable || attempt === 1 || controller.signal.aborted) throw safe;
          await new Promise<void>(resolve => { const timer = setTimeout(resolve, 500); controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
        }
      }
    } catch (error) { meta.fallback_reason = error instanceof ProviderError ? error.code : 'PROVIDER_UNAVAILABLE'; }
    meta.finished_at = new Date().toISOString();
    this.store.database.prepare("UPDATE reports SET status=?,content_json=?,run_meta_json=?,updated_at=? WHERE id=? AND status='running'").run(status, JSON.stringify(content), JSON.stringify(meta), meta.finished_at, id);
  }
  cancel(id: string) { const job = this.jobs.get(id); if (!job) throw new AppError(409, 'REPORT_NOT_RUNNING', '该报告已结束或属于另一进程，请读取最新状态。'); job.controller.abort(); return { accepted: true }; }
  async testConnection() {
    const config = this.settings(); if (config.mode !== 'openai' || !config.model) invalid('请先保存在线服务与模型名称。'); const key = await this.vault.read(); if (!key) invalid('尚未配置密钥。');
    const input: ReportInput = { schema_version: 1, prompt_version: 'ceo-v1', date: '2000-01-01', timezone: 'UTC', type: 'review', projects: [], facts: [{ id: 'scope', text: '这是合成连接测试，无真实用户数据。请返回空的 interpretations、gaps、suggestions。' }], fingerprint: 'connection-test', config_revision: config.revision };
    try { const response = await this.callProvider(input, config, key, new AbortController().signal, null); validateContent(response.content, input); return { ok: true, message: '连接与结构化输出校验通过。仅发送了合成测试资料。' }; }
    catch (error) { throw new AppError(502, error instanceof ProviderError ? error.code : 'CONNECTION_FAILED', '连接或输出校验未通过，请核对模型、密钥和网络；本地功能可继续使用。'); }
  }
  adopt(id: string, input: AdoptSuggestion) {
    return this.store.idempotent(`adopt:${id}:${input.suggestion_index}`, input.requestId, input, () => {
      const row = this.store.database.prepare('SELECT * FROM reports WHERE id=?').get(id); if (!row) throw new AppError(404, 'NOT_FOUND', '报告不存在。');
      const prior = this.store.database.prepare('SELECT * FROM report_adoptions WHERE report_id=? AND suggestion_index=?').get(id, input.suggestion_index); if (prior) return prior;
      if (!['succeeded', 'degraded'].includes(String(row.status))) invalid('只能采纳已完成报告的建议。');
      const source = JSON.parse(String(row.input_snapshot_json)) as ReportInput;
      if (row.input_hash !== digest(this.snapshot(source.date, source.type))) throw new AppError(409, 'STALE_REPORT', '报告依据已变化，请重新生成并核对建议。');
      const suggestion = (JSON.parse(String(row.content_json)) as ReportContent).suggestions[input.suggestion_index]; if (!suggestion) invalid('建议不存在。');
      const project = this.store.getProject(suggestion.project_id); if (!['active', 'preparing'].includes(project.status)) invalid('暂停、完成或归档项目不能加入新安排。');
      if (project.target_date && project.target_date < input.target_date) invalid('项目截止日早于目标日期，请先在项目档案中核对并明确改期。');
      let day = this.days.getState(input.target_date); if ((day.log?.revision ?? 0) !== input.target_revision) throw new AppError(409, 'REVISION_CONFLICT', '目标日已有新修改，请重新读取草稿作对照。');
      const plan = day.log?.plan_snapshots.at(-1);
      const empty = { ...day.suggested_draft, tasks: [], work_blocks: [], dimensions: Object.fromEntries(Object.keys(day.suggested_draft.dimensions).map(dimension => [dimension, { applicable: false, reason: '尚未安排此维度' }])) as PlanDraft['dimensions'] };
      const draft: PlanDraft = structuredClone(day.log?.draft_plan ?? (plan ? { day_mode: plan.day_mode, available_minutes: plan.available_minutes, dimensions: plan.dimensions, tasks: plan.tasks.map(({ project_name, ...task }) => task), work_blocks: plan.work_blocks, change_reason: '', notes: plan.notes } : empty));
      if (draft.day_mode === 'rest') invalid('目标日是休息日，请先在计划中明确调整为工作草稿。');
      if (plan && !input.change_reason) invalid('目标日已有确认计划，请填写调整草稿的原因。');
      const group = this.store.getState().settings.shared_budget_groups.find(item => item.project_ids.includes(project.id));
      const existing = draft.tasks.find(task => task.project_id === project.id) ?? (group && draft.tasks.find(task => group.project_ids.includes(task.project_id)));
      let blockId = existing?.work_block_id;
      if (!blockId) { blockId = `block-${randomUUID()}`; draft.work_blocks.push({ id: blockId, title: group?.title ?? project.name, budget_minutes: group?.budget_minutes ?? project.daily_budget_minutes }); }
      const candidateId = `adopt-${id}-${input.suggestion_index}`;
      draft.dimensions[input.dimension] = { applicable: true, reason: '' };
      draft.tasks.push({ candidate_id: candidateId, task_id: null, project_id: project.id, title: input.action, acceptance: input.acceptance, result_type: 'binary', metric_key: null, target_value: 1, scoring_dimension: input.dimension, raw_points: 0, estimated_minutes: input.estimated_minutes, work_block_id: blockId });
      draft.change_reason = input.change_reason; const checked = parseDraft(draft); const now = new Date().toISOString();
      if (!day.log) this.store.database.prepare('INSERT INTO daily_logs(id,business_date,timezone,created_at,updated_at) VALUES(?,?,?,?,?)').run(randomUUID(), input.target_date, day.timezone, now, now);
      this.store.database.prepare('UPDATE daily_logs SET draft_plan_json=?,revision=revision+1,updated_at=? WHERE business_date=?').run(JSON.stringify(checked), now, input.target_date);
      this.store.database.prepare('INSERT INTO report_adoptions(report_id,suggestion_index,target_date,candidate_id,created_at) VALUES(?,?,?,?,?)').run(id, input.suggestion_index, input.target_date, candidateId, now);
      return { report_id: id, suggestion_index: input.suggestion_index, target_date: input.target_date, candidate_id: candidateId, created_at: now };
    });
  }
  async close() { for (const job of this.jobs.values()) job.controller.abort(); await Promise.allSettled([...this.jobs.values()].map(job => job.done)); }
}

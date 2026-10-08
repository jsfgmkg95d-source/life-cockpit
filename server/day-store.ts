import { createHash, randomUUID } from 'node:crypto';
import { DIMENSIONS, DIMENSION_WEIGHTS } from '../shared/day-contracts.ts';
import type { ActualWrite, AssetEvent, CompletionWrite, ConfirmPlanWrite, CorrectionWrite, DailyLog, DailyTask, DayState, DayWrite, DeltaMetric, DraftWrite, EventWrite, EventInput, FinishWrite, PlanDraft, PlanSnapshot, RemoveTaskWrite, ResultWrite, SnapshotTask, StatusWrite } from '../shared/day-contracts.ts';
import type { Project } from '../shared/contracts.ts';
import { AppError, invalid } from './errors.ts';
import { DELTA_METRICS, completionWrite, parseDraft, removeTaskWrite, validateStage } from './day-validation.ts';
import { buildQuickTaskDraft } from '../shared/quick-task.ts';
import { buildRemoveTaskDraft } from '../shared/remove-task.ts';
import { normalizePlanScoring } from '../shared/plan-scoring.ts';
import type { QuickTaskWrite } from '../shared/quick-task.ts';
import type { Store } from './store.ts';
import { checkedChapters, chapterMatches, chaptersFor, chapterReplacementRoots, unknownBatches } from './chapter-store.ts';
import { TimerStore } from './timer-store.ts';

function toLog(row: Record<string, unknown>): DailyLog {
  return {
    id: String(row.id), business_date: String(row.business_date), timezone: String(row.timezone), revision: Number(row.revision), current_plan_version: Number(row.current_plan_version),
    draft_plan: row.draft_plan_json === null ? null : JSON.parse(String(row.draft_plan_json)),
    plan_snapshots: JSON.parse(String(row.plan_snapshots_json)), work_block_actuals: JSON.parse(String(row.work_block_actuals_json)),
    record_state: row.record_state as DailyLog['record_state'], created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}
function toTask(row: Record<string, unknown>): DailyTask {
  return { ...JSON.parse(String(row.snapshot_json)), daily_log_id: String(row.daily_log_id), status: row.status, result_state: row.result_state, confirmed_result: row.confirmed_result_json === null ? null : JSON.parse(String(row.confirmed_result_json)), eligible: row.eligible === 1, created_at: String(row.created_at), updated_at: String(row.updated_at) };
}
function identity(task: SnapshotTask | PlanDraft['tasks'][number]): string {
  return JSON.stringify([task.project_id, task.title, task.acceptance, task.metric_key, task.result_type]);
}
function canSchedule(project: Project): boolean { return project.status === 'active' || project.status === 'preparing'; }

export class DayStore {
  store: Store;
  constructor(store: Store) { this.store = store; }

  findLog(date: string): DailyLog | null {
    const row = this.store.database.prepare('SELECT * FROM daily_logs WHERE business_date=?').get(date);
    return row ? toLog(row) : null;
  }

  getTask(id: string, log: DailyLog): DailyTask {
    const row = this.store.database.prepare('SELECT * FROM tasks WHERE id=? AND daily_log_id=?').get(id, log.id);
    if (!row) throw new AppError(404, 'TASK_NOT_FOUND', '该任务不属于当前日期，或已不存在。');
    return toTask(row);
  }

  getEvent(id: string, log: DailyLog): AssetEvent {
    const row = this.store.database.prepare('SELECT * FROM asset_events WHERE id=? AND daily_log_id=?').get(id, log.id);
    if (!row) throw new AppError(404, 'EVENT_NOT_FOUND', '该成果不属于当前日期，或已不存在。');
    return row as unknown as AssetEvent;
  }

  suggestedDraft(): PlanDraft {
    const app = this.store.getState();
    const projects = app.projects.filter(canSchedule);
    const blocks: PlanDraft['work_blocks'] = [];
    const seen = new Set<string>();
    const tasks = projects.map((project) => {
      const group = app.settings.shared_budget_groups.find((item) => item.project_ids.includes(project.id));
      const blockId = group ? `block-${group.id}` : `block-${project.id}`;
      if (!seen.has(blockId)) {
        blocks.push({ id: blockId, title: group?.title ?? project.name, budget_minutes: group?.budget_minutes ?? project.daily_budget_minutes });
        seen.add(blockId);
      }
      const dimension = project.operating_role === 'cashflow' ? 'cashflow' : project.operating_role === 'maintenance' ? (project.primary_metric_key === 'learning_outputs' ? 'learning' : 'health') : 'asset';
      const metric = project.primary_metric_key && DELTA_METRICS.includes(project.primary_metric_key as DeltaMetric) ? project.primary_metric_key as DeltaMetric : null;
      return { candidate_id: `candidate-${project.id}`, task_id: null, project_id: project.id, title: project.next_action ?? `推进${project.name}`, acceptance: '', result_type: metric ? 'quant' as const : 'binary' as const, metric_key: metric, target_value: metric ? null : 1, scoring_dimension: dimension, raw_points: 0, estimated_minutes: null, work_block_id: blockId };
    }) as PlanDraft['tasks'];
    const dimensions = Object.fromEntries(DIMENSIONS.map((dimension) => {
      const members = tasks.filter((task) => task.scoring_dimension === dimension);
      for (let i = 0; i < members.length; i++) members[i].raw_points = Math.floor(DIMENSION_WEIGHTS[dimension] / members.length) + (i < DIMENSION_WEIGHTS[dimension] % members.length ? 1 : 0);
      return [dimension, { applicable: members.length > 0, reason: members.length > 0 ? '' : '今日暂未安排此维度任务' }];
    })) as PlanDraft['dimensions'];
    return { day_mode: 'work', available_minutes: app.settings.available_minutes, dimensions, tasks, work_blocks: blocks, change_reason: '', notes: '' };
  }

  getState(date: string): DayState {
    const log = this.findLog(date);
    const events = log ? (this.store.database.prepare('SELECT * FROM asset_events WHERE daily_log_id=? ORDER BY created_at,rowid').all(log.id) as unknown as AssetEvent[]).map(event => ({ ...event,
      chapter_numbers: chaptersFor(this.store, event.root_event_id), evidence_sources: this.store.database.prepare('SELECT source FROM asset_evidence WHERE root_event_id=? ORDER BY created_at').all(event.root_event_id).map(row => String(row.source)),
    })) : [];
    const replaced = new Set(events.map((event) => event.supersedes_event_id).filter((id) => id !== null));
    return {
      business_date: date, timezone: log?.timezone ?? this.store.getState().settings.timezone, log,
      tasks: log ? this.store.database.prepare('SELECT * FROM tasks WHERE daily_log_id=? ORDER BY created_at,rowid').all(log.id).map(toTask) : [],
      events, effective_events: events.filter((event) => !replaced.has(event.id) && event.change_kind !== 'void'), suggested_draft: this.suggestedDraft(),
      pinned_task_ids: log ? this.store.database.prepare('SELECT p.task_id FROM task_pins p JOIN tasks t ON t.id=p.task_id WHERE t.daily_log_id=? ORDER BY p.pinned_at').all(log.id).map(row => String(row.task_id)) : [],
    };
  }

  mutate<T extends DayWrite>(date: string, operation: string, input: T, work: (log: DailyLog) => void, receipt: Record<string, unknown> = {}): DayState {
    this.store.idempotent(`day:${date}:${operation}`, input.requestId, input, () => {
      let log = this.findLog(date);
      if ((log?.revision ?? 0) !== input.revision) throw new AppError(409, 'REVISION_CONFLICT', '当天记录已更新，请先加载最新内容；当前输入未覆盖已有记录。');
      if (!log) {
        const now = new Date().toISOString();
        this.store.database.prepare('INSERT INTO daily_logs(id,business_date,timezone,created_at,updated_at) VALUES(?,?,?,?,?)')
          .run(randomUUID(), date, this.store.getState().settings.timezone, now, now);
        log = this.findLog(date)!;
      }
      work(log);
      const invalidates = operation !== 'draft' && !operation.startsWith('status:');
      this.store.database.prepare('UPDATE daily_logs SET revision=revision+1,record_state=?,updated_at=? WHERE id=?').run(invalidates ? 'incomplete' : log.record_state, new Date().toISOString(), log.id);
      return { ...receipt, accepted: true };
    });
    return this.getState(date);
  }

  saveDraft(date: string, input: DraftWrite): DayState {
    return this.mutate(date, 'draft', input, (log) => {
      this.store.database.prepare('UPDATE daily_logs SET draft_plan_json=? WHERE id=?').run(JSON.stringify(input.draft), log.id);
    });
  }

  validatePlan(log: DailyLog, input: ConfirmPlanWrite, allowEmptyWorkPlan = false, allowUnknownBudget = false): void {
    const draft = input.draft;
    if (log.current_plan_version > 0 && !draft.change_reason) invalid('调整已确认计划时必须填写原因，旧计划仍会保留。');
    for (const dimension of DIMENSIONS) if (!draft.dimensions[dimension].applicable && !draft.dimensions[dimension].reason) invalid('不适用维度需要说明原因。');
    if (draft.day_mode === 'rest') {
      if (draft.tasks.length || draft.work_blocks.length || DIMENSIONS.some((dimension) => draft.dimensions[dimension].applicable)) invalid('休息计划不包含计分任务和投入块，请将维度设为不适用。');
      return;
    }
    if (draft.available_minutes === null && !allowUnknownBudget) invalid('确认工作计划前，请填写当天可用分钟数。');
    if (draft.tasks.length === 0 && !allowEmptyWorkPlan) invalid('工作计划至少需要一项明确的任务；空计划可以先保存草稿。');
    const current = log.plan_snapshots.find((snapshot) => snapshot.plan_version === log.current_plan_version);
    for (const task of draft.tasks) {
      if (!task.project_id || !task.title || !task.acceptance) invalid('每项任务都需要项目、具体行动和验收标准。');
      const project = this.store.getProject(task.project_id);
      const previous = task.task_id ? this.getTask(task.task_id, log) : null;
      if (previous && !log.plan_snapshots.some((snapshot) => snapshot.tasks.some((item) => item.task_id === previous.task_id))) invalid('引用的任务没有本日已确认计划来源。');
      const preservesCurrent = previous && current?.tasks.some((item) => item.task_id === previous.task_id) && identity(previous) === identity(task);
      if (!canSchedule(project) && !preservesCurrent) invalid('暂停、完成或归档的项目不能新增计划任务；原承诺可保留或明确调整。');
      if (!draft.dimensions[task.scoring_dimension].applicable || task.raw_points <= 0) invalid('计划任务必须属于适用维度，并分配正权重。');
      if (task.result_type === 'quant' && (task.metric_key === null || task.target_value === null || task.target_value <= 0)) invalid('计量任务须选择增量指标，并填写大于零的目标数量。');
      if (task.result_type === 'binary' && task.target_value !== 1) invalid('离散任务的验收目标固定为 1。');
      if (!task.work_block_id || !draft.work_blocks.some((block) => block.id === task.work_block_id)) invalid('每项计划任务必须关联一个投入块。');
    }
    for (const dimension of DIMENSIONS) {
      const total = draft.tasks.filter((task) => task.scoring_dimension === dimension).reduce((sum, task) => sum + task.raw_points, 0);
      if (total !== (draft.dimensions[dimension].applicable ? DIMENSION_WEIGHTS[dimension] : 0)) invalid(`适用维度的权重必须完整分配：${dimension} 的原始预算为 ${DIMENSION_WEIGHTS[dimension]}。`);
    }
    for (const block of draft.work_blocks) {
      if (!block.title || (block.budget_minutes === null && !allowUnknownBudget)) invalid('投入块必须有名称和分钟预算，未知预算只能留在草稿。');
      const members = draft.tasks.filter((task) => task.work_block_id === block.id);
      if (members.length === 0) invalid('投入块不能没有任务；请移除空块或补入任务。');
      if (block.budget_minutes !== null && members.reduce((sum, task) => sum + (task.estimated_minutes ?? 0), 0) > block.budget_minutes) invalid('块内已拆分估时不能超过该投入块预算。');
    }
    const planned = draft.work_blocks.reduce((sum, block) => sum + (block.budget_minutes ?? 0), 0);
    if (draft.available_minutes !== null && planned > draft.available_minutes && !input.acknowledgeOverCapacity) invalid(`计划超过可用容量 ${planned - draft.available_minutes} 分钟，请调整或明确确认超额。`);
  }

  confirm(date: string, input: ConfirmPlanWrite): DayState {
    return this.mutate(date, 'confirm', input, log => this.applyPlan(date, log, input));
  }

  quickTask(date: string, input: QuickTaskWrite, afterApply?: (state: DayState) => void, operation = 'quick-task'): DayState {
    return this.mutate(date, operation, input, log => {
      const project = this.store.getProject(input.project_id);
      if (project.revision !== input.project_revision) throw new AppError(409, 'REVISION_CONFLICT', '项目已更新，请重新加载项目后添加；当天安排没有改变。');
      if (!canSchedule(project)) {
        if (!input.resume_project) invalid('此项目已经暂停、完成或归档。请明确选择恢复项目并添加任务。');
        this.store.database.prepare("UPDATE projects SET status='active',revision=revision+1,updated_at=? WHERE id=? AND revision=?")
          .run(new Date().toISOString(), project.id, project.revision);
      }
      let draft: PlanDraft;
      try { draft = buildQuickTaskDraft(this.getState(date), this.store.getState(), input, { candidate_id: `quick-${randomUUID()}`, block_id: `block-${randomUUID()}` }); }
      catch (error) { invalid(error instanceof Error ? error.message : '无法添加任务，请核对当天安排。'); }
      this.applyPlan(date, log, { requestId: input.requestId, revision: input.revision, draft: parseDraft(draft), acknowledgeOverCapacity: input.acknowledgeOverCapacity }, true, false, true);
      // Inbox promotion uses the same transaction and retry identity as the plan write.
      afterApply?.(this.getState(date));
    });
  }

  removeTask(date: string, id: string, input: RemoveTaskWrite): DayState {
    const checked = removeTaskWrite(input);
    return this.mutate(date, `remove-task:${id}`, checked, log => {
      const task = this.getTask(id, log);
      if (!task.eligible) throw new AppError(409, 'TASK_NOT_CURRENT', '这项任务已移出当前安排，请读取最新内容。');
      let draft: PlanDraft;
      try { draft = buildRemoveTaskDraft(this.getState(date), id, checked.reason); }
      catch (error) { invalid(error instanceof Error ? error.message : '无法移除任务，请核对当天安排。'); }
      const current = log.plan_snapshots.find(snapshot => snapshot.plan_version === log.current_plan_version)!;
      // Only removal can produce an empty work day. It never declares a rest day or a perfect score.
      this.applyPlan(date, log, { ...checked, draft: parseDraft(draft), acknowledgeOverCapacity: current.over_capacity_acknowledged }, true, true, true);
      const now = new Date().toISOString();
      this.store.database.prepare('UPDATE day_schedule SET deleted_at=?,updated_at=? WHERE daily_log_id=? AND task_id=? AND deleted_at IS NULL').run(now, now, log.id, id);
      this.store.database.prepare('DELETE FROM task_pins WHERE task_id=?').run(id);
    });
  }

  private applyPlan(date: string, log: DailyLog, input: ConfirmPlanWrite, preserveDraft = false, allowEmptyWorkPlan = false, allowUnknownBudget = false): void {
      // Normalize only the working copy. mutate() keeps the original request for idempotency.
      try { input = { ...input, draft: normalizePlanScoring(input.draft) }; }
      catch (error) { invalid(error instanceof Error ? error.message : '无法自动分配任务权重，请检查当天安排。'); }
      this.validatePlan(log, input, allowEmptyWorkPlan, allowUnknownBudget);
      const now = new Date().toISOString();
      const tasks: SnapshotTask[] = [];
      for (const candidate of input.draft.tasks) {
        const old = candidate.task_id ? this.getTask(candidate.task_id, log) : null;
        const reuse = old !== null && identity(old) === identity(candidate);
        const task: SnapshotTask = { ...candidate, task_id: reuse ? old.task_id : randomUUID(), project_name: this.store.getProject(candidate.project_id).name };
        tasks.push(task);
      }
      const blocks = input.draft.work_blocks.map((block) => ({ ...block }));
      for (const block of blocks) {
        const existingSnapshot = log.plan_snapshots.find((snapshot) => snapshot.work_blocks.some((old) => old.id === block.id));
        if (!existingSnapshot) continue;
        const beforeMembers = existingSnapshot.tasks.filter((task) => task.work_block_id === block.id).map((task) => task.task_id).sort();
        const afterMembers = tasks.filter((task) => task.work_block_id === block.id).map((task) => task.task_id).sort();
        if (JSON.stringify(beforeMembers) !== JSON.stringify(afterMembers)) {
          const oldId = block.id;
          block.id = `block-${randomUUID()}`;
          for (const task of tasks) if (task.work_block_id === oldId) task.work_block_id = block.id;
        }
      }
      const active = new TimerStore(this).view(date).active;
      if (active?.daily_log_id === log.id && !blocks.some(block => block.id === active.block_id)) {
        invalid('这次调整会替换或移除正在计时的时段，请先暂停并记录计时，再确认计划调整。');
      }
      this.store.database.prepare('UPDATE tasks SET eligible=0 WHERE daily_log_id=?').run(log.id);
      for (const task of tasks) {
        const exists = this.store.database.prepare('SELECT id FROM tasks WHERE id=?').get(task.task_id);
        if (exists) this.store.database.prepare('UPDATE tasks SET snapshot_json=?,eligible=1,updated_at=? WHERE id=?').run(JSON.stringify(task), now, task.task_id);
        else this.store.database.prepare('INSERT INTO tasks(id,daily_log_id,project_id,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(task.task_id, log.id, task.project_id, JSON.stringify(task), now, now);
      }
      const snapshot: PlanSnapshot = {
        ...input.draft, tasks, work_blocks: blocks, schema_version: 1, plan_version: log.current_plan_version + 1, previous_plan_version: log.current_plan_version || null, confirmed_at: now,
        policy: { id: 'default-v1', version: 1, dimension_weights: { ...DIMENSION_WEIGHTS } }, over_capacity_acknowledged: input.acknowledgeOverCapacity,
      };
      this.store.database.prepare(`UPDATE daily_logs SET current_plan_version=?,plan_snapshots_json=?${preserveDraft ? '' : ',draft_plan_json=NULL'} WHERE id=?`)
        .run(snapshot.plan_version, JSON.stringify([...log.plan_snapshots, snapshot]), log.id);
  }

  status(date: string, id: string, input: StatusWrite): DayState {
    return this.mutate(date, `status:${id}`, input, (log) => {
      this.getTask(id, log);
      this.store.database.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run(input.status, new Date().toISOString(), id);
    });
  }

  completion(date: string, id: string, input: CompletionWrite): DayState {
    const checked = completionWrite(input);
    return this.mutate(date, `completion:${id}`, checked, log => {
      const task = this.getTask(id, log);
      if (!task.eligible) throw new AppError(409, 'TASK_NOT_CURRENT', '这项任务已移出当前安排，请读取最新内容。');
      // A shared block is insufficient ownership evidence: only this exact task
      // may finish its own linked session. Legacy unlinked sessions stay running.
      const active = this.store.database.prepare(`SELECT s.id,s.block_id FROM work_sessions s
        JOIN work_session_context c ON c.session_id=s.id
        WHERE s.daily_log_id=? AND s.stopped_at IS NULL AND c.task_id=?`).get(log.id, id);
      if (active) new TimerStore(this).stopInTransaction(log, false, String(active.block_id), String(active.id));
      this.store.database.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?')
        .run(checked.completed ? 'done' : 'todo', new Date().toISOString(), id);
    }, { completion: { task_id: id, completed: checked.completed, source: checked.source, marker: checked.marker } });
  }

  result(date: string, id: string, input: ResultWrite): DayState {
    return this.mutate(date, `result:${id}`, input, (log) => this.applyResult(date, id, input, log));
  }

  private applyResult(date: string, id: string, input: ResultWrite, log: DailyLog): void {
      const task = this.getTask(id, log);
      if (input.clear) {
        if (input.binary_value !== null) invalid('恢复未知时请不要同时提交验收结果。');
        this.invalidateTask(id);
        return;
      }
      const evidence = this.getState(date).effective_events.filter((event) => event.task_id === id && (task.metric_key === null || event.metric_key === task.metric_key));
      let actual: number;
      if (task.result_type === 'binary') {
        if (input.binary_value === null) invalid('请明确选择达成或未达成。');
        actual = input.binary_value;
      } else {
        if (input.binary_value !== null) invalid('计量任务只能依据已确认成果计算数量，不能手工覆盖。');
        actual = evidence.reduce((sum, event) => sum + (event.value ?? 0), 0);
        if (!Number.isSafeInteger(actual)) invalid('确认成果总量超出安全整数范围，请核对记录。');
      }
      const result = { actual_value: actual, evidence_event_ids: evidence.map((event) => event.id), evidence_hash: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'), explanation: input.explanation, confirmed_at: new Date().toISOString(), confirmed_by: 'user' };
      this.store.database.prepare("UPDATE tasks SET result_state='confirmed',confirmed_result_json=?,updated_at=? WHERE id=?").run(JSON.stringify(result), result.confirmed_at, id);
  }

  invalidateTask(id: string | null): void {
    if (id) this.store.database.prepare("UPDATE tasks SET result_state='unknown',confirmed_result_json=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), id);
  }

  insertEvent(event: AssetEvent): void {
    const columns = ['id', 'daily_log_id', 'project_id', 'task_id', 'artifact_key', 'metric_key', 'value', 'stage', 'summary', 'source', 'occurred_on', 'occurrence_precision', 'timezone', 'measurement_scope', 'period_key', 'confirmation_state', 'change_kind', 'supersedes_event_id', 'root_event_id', 'correction_reason', 'created_at'] as const;
    this.store.database.prepare(`INSERT INTO asset_events(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map((column) => event[column]));
  }

  event(date: string, input: EventWrite): DayState {
    return this.mutate(date, 'event', input, (log) => this.applyEvent(date, input, log));
  }

  private applyEvent(date: string, input: EventWrite, log: DailyLog): void {
      const event = input.event;
      if (event.artifact_key.startsWith('pcos-internal:')) invalid('此成果标识前缀由系统保留，请使用自己的成果标识。');
      this.store.getProject(event.project_id);
      validateStage(event.metric_key, event.stage);
      const chapters = checkedChapters(event.chapter_numbers, event.metric_key, event.value, event.artifact_key);
      if (['accepted_chapters', 'published_chapters'].includes(event.metric_key) && event.value > 0) {
        const existing = this.getState(date).effective_events.filter(item => item.project_id === event.project_id && item.metric_key === event.metric_key && (item.value ?? 0) > 0);
        if (existing.length && (!chapters.length || existing.some(item => !item.chapter_numbers?.length))) invalid('当天已有章节记录，请先补齐已有批次和本次成果的真实章号，核对是否重叠。');
      }
      for (const chapter of chapters) if (chapterMatches(this.store, event.project_id, event.metric_key, chapter).length) throw new AppError(409, 'DUPLICATE_CHAPTER', `第 ${chapter} 章已有记录。请核对已有成果或补充来源，不要重复计量。`);
      if (event.task_id !== null) {
        const task = this.getTask(event.task_id, log);
        if (task.project_id !== event.project_id) invalid('成果项目必须与所选任务一致。');
        if (task.metric_key !== null && task.metric_key !== event.metric_key) invalid('成果必须与所选任务已指定的指标一致。');
      }
      const duplicate = this.store.database.prepare("SELECT id FROM asset_events WHERE project_id=? AND artifact_key=? AND metric_key=? AND measurement_scope='project' AND period_key='lifetime' AND change_kind='record'")
        .get(event.project_id, event.artifact_key, event.metric_key);
      if (duplicate) throw new AppError(409, 'DUPLICATE_ASSET', '该成果及指标已记录。请查看已有事实或更正，换日期或阶段不能再记一次。');
      const id = randomUUID();
      this.insertEvent({ ...event, id, daily_log_id: log.id, occurred_on: date, occurrence_precision: 'date', timezone: log.timezone, measurement_scope: 'project', period_key: 'lifetime', confirmation_state: 'user_confirmed', change_kind: 'record', supersedes_event_id: null, root_event_id: id, correction_reason: null, created_at: new Date().toISOString() });
      for (const chapter of chapters) this.store.database.prepare('INSERT INTO asset_chapters VALUES(?,?)').run(id, chapter);
      this.invalidateTask(event.task_id);
  }

  correct(date: string, id: string, input: CorrectionWrite): DayState {
    return this.mutate(date, `correct:${id}`, input, (log) => {
      const previous = this.getEvent(id, log);
      if (this.store.database.prepare('SELECT id FROM asset_events WHERE supersedes_event_id=?').get(id)) throw new AppError(409, 'EVENT_NOT_LATEST', '该事实已有后续更正，请加载并更正当前有效版本。');
      validateStage(previous.metric_key, input.stage);
      const chapters = chaptersFor(this.store, previous.root_event_id);
      if (input.kind !== 'void' && input.chapter_numbers !== undefined) {
        const corrected = checkedChapters(input.chapter_numbers, previous.metric_key, input.value!, '');
        if (JSON.stringify(corrected) !== JSON.stringify(chapters)) {
          if (!chapters.length || !corrected.length) invalid('未知章号请使用“核对章节”；全部撤销请使用“撤销这项成果”。');
          if (previous.change_kind === 'void') invalid('已撤销批次只能恢复原有身份；请在有效批次上更正章号。');
          const root = this.getEvent(previous.root_event_id, log);
          if (root.artifact_key.startsWith('github:')) invalid('GitHub 原始采集记录的章号来自远端文件，不能改成另一章；可撤销并核对原仓库。');
          const lineage = chapterReplacementRoots(this.store, previous.root_event_id);
          for (const chapter of corrected) for (const other of chapterMatches(this.store, previous.project_id, previous.metric_key, chapter)) {
            if (other.root_event_id === previous.root_event_id) continue;
            if (other.change_kind === 'void' && other.occurred_on === date && lineage.has(other.root_event_id)) continue;
            invalid(`第 ${chapter} 章与其他${other.occurred_on === date ? '' : '日期的'}成果记录冲突，未保存本次更正。`);
          }
          const replacementId = randomUUID(), now = new Date().toISOString();
          const artifactKey = `pcos-internal:chapter-correction:${replacementId}`;
          this.insertEvent({ ...previous, id: randomUUID(), value: null, change_kind: 'void', supersedes_event_id: previous.id,
            correction_reason: `${input.reason}；章节身份更正，替代批次：${artifactKey}`, created_at: now });
          this.insertEvent({ ...previous, id: replacementId, root_event_id: replacementId, artifact_key: artifactKey,
            value: input.value, stage: input.stage, summary: input.summary, source: `用户核对更正：${input.source}`,
            change_kind: 'record', supersedes_event_id: null, correction_reason: null, created_at: now });
          for (const chapter of corrected) this.store.database.prepare('INSERT INTO asset_chapters VALUES(?,?)').run(replacementId, chapter);
          this.store.database.prepare('INSERT INTO asset_evidence VALUES(?,?,?,?)').run(replacementId, `pcos-internal:replaces:${previous.root_event_id}`,
            `用户更正章号，替代已撤销批次 ${previous.artifact_key}；原因：${input.reason}。旧章号和旧来源仅保留在原记录，不作为本批次的采集证据。`, now);
          this.invalidateTask(previous.task_id);
          return;
        }
      }
      if (input.kind !== 'void' && previous.change_kind === 'void') {
        const replacement = this.getState(date).effective_events.find(item => item.project_id === previous.project_id && item.metric_key === previous.metric_key && item.root_event_id !== previous.root_event_id && chapterReplacementRoots(this.store, item.root_event_id).has(previous.root_event_id));
        if (replacement) invalid('此批次已有有效的章节更正替代记录，不能恢复为重复成果；请先核对并撤销替代批次。');
      }
      if (input.kind !== 'void' && chapters.length && input.value !== chapters.length) invalid('此成果已有明确章号，数量必须与章号一致；章号填错时请同时填写更正后的章号。');
      if (input.kind !== 'void') for (const chapter of chapters) if (chapterMatches(this.store, previous.project_id, previous.metric_key, chapter).some(item => item.root_event_id !== previous.root_event_id && item.change_kind !== 'void')) invalid('该章已有另一份有效成果，不能恢复成重复记录。');
      this.insertEvent({ ...previous, id: randomUUID(), value: input.value, stage: input.stage, summary: input.summary, source: input.source, change_kind: input.kind, supersedes_event_id: previous.id, correction_reason: input.reason, created_at: new Date().toISOString() });
      this.invalidateTask(previous.task_id);
    });
  }

  actual(date: string, input: ActualWrite): DayState {
    return this.mutate(date, 'actual', input, (log) => {
      // Manual minutes are the complete block total, including time just spent.
      // Close a matching session before applying that total, as finish() does.
      new TimerStore(this).stopInTransaction(log, false, input.block_id);
      this.applyActual(input, log);
    });
  }

  private applyActual(input: ActualWrite, log: DailyLog): void {
      if (!log.plan_snapshots.some((snapshot) => snapshot.work_blocks.some((block) => block.id === input.block_id))) invalid('实际投入必须关联本日已经确认过的投入块。');
      const actuals = log.work_block_actuals.filter((actual) => actual.block_id !== input.block_id);
      if (input.minutes !== null) actuals.push({ block_id: input.block_id, minutes: input.minutes, source: input.source, updated_at: new Date().toISOString() });
      if (actuals.reduce((sum, actual) => sum + actual.minutes, 0) > 1440) invalid('当天不重叠的实际投入不能超过 1440 分钟，请核对是否重复记录。');
      this.store.database.prepare('UPDATE daily_logs SET work_block_actuals_json=? WHERE id=?').run(JSON.stringify(actuals), log.id);
  }
  finish(date: string, id: string, input: FinishWrite, imported: EventInput[] = []): DayState {
    return this.mutate(date, `finish:${id}`, input, log => {
      const task = this.getTask(id, log);
      if (!task.eligible) invalid('请在当前计划中结束这项工作。');
      new TimerStore(this).stopInTransaction(log, false, task.work_block_id);
      if (!input.event && !input.result && !input.actual && !input.mark_done && !imported.length) invalid('请选择本次要保存的内容。');
      if (input.event) {
        if (input.event.task_id !== id || input.event.project_id !== task.project_id) invalid('本次成果必须属于当前任务。');
        this.applyEvent(date, { ...input, event: input.event }, log);
      }
      for (const event of imported) {
        if (event.task_id !== id || event.project_id !== task.project_id) invalid('采集成果必须关联当前任务。');
        this.applyImported(date, input, event, log);
      }
      if (input.actual) this.applyActual({ ...input, ...input.actual, block_id: task.work_block_id }, log);
      if (input.result) this.applyResult(date, id, { ...input, ...input.result, clear: false }, log);
      if (input.mark_done) this.store.database.prepare("UPDATE tasks SET status='done',updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    });
  }

  importEvents(date: string, input: DayWrite, events: EventInput[]): DayState {
    return this.mutate(date, 'github-import', { ...input, events }, log => {
      for (const event of events) this.applyImported(date, input, event, log);
    });
  }

  private applyImported(date: string, input: DayWrite, event: EventInput, log: DailyLog) {
    const chapters = checkedChapters(event.chapter_numbers, event.metric_key, event.value, event.artifact_key);
    if (chapters.length !== 1) invalid('采集成果须逐章核对。');
    const matches = chapterMatches(this.store, event.project_id, event.metric_key, chapters[0]);
    const active = matches.filter(item => item.change_kind !== 'void');
    if (active.length > 1 || (!active.length && matches.length)) invalid('该章存在冲突或已撤销记录，请先核对已有成果。');
    if (!active.length) {
      if (unknownBatches(this.store, event.project_id, date).length) invalid('当天有未填写章号的定稿批次，请先点击“核对章节”确认范围，再导入新章节。');
      this.applyEvent(date, { ...input, event }, log); return;
    }
    const existing = active[0];
    if (chaptersFor(this.store, existing.root_event_id).length !== existing.value) invalid('已有批次的数量与章号不一致，请先核对。');
    if (existing.occurred_on !== date) invalid(`第 ${chapters[0]} 章已计入 ${existing.occurred_on}，请切换到该日期补充来源。`);
    if (event.task_id) {
      const task = this.getTask(event.task_id, log);
      if (task.project_id !== event.project_id || (task.metric_key && task.metric_key !== event.metric_key)) invalid('任务与成果指标不一致。');
      if (existing.task_id && existing.task_id !== event.task_id) invalid('该章已关联另一任务，请先核对，不会重复归属。');
      if (!existing.task_id) {
        this.insertEvent({ ...existing, id: randomUUID(), task_id: event.task_id, change_kind: 'replace', supersedes_event_id: existing.id, correction_reason: '采集核对：将已记录成果关联当天任务，数量不变', created_at: new Date().toISOString() });
        this.invalidateTask(event.task_id);
      }
    }
    this.store.database.prepare('INSERT OR IGNORE INTO asset_evidence VALUES(?,?,?,?)').run(existing.root_event_id, event.artifact_key, event.source, new Date().toISOString());
  }

  identifyChapters(date: string, id: string, input: DayWrite & { chapters: number[]; merge: boolean }): DayState {
    return this.mutate(date, `identify:${id}`, input, log => {
      const event = this.getEvent(id, log);
      if (event.change_kind === 'void' || this.store.database.prepare('SELECT id FROM asset_events WHERE supersedes_event_id=?').get(id)) invalid('请核对当前有效的成果。');
      const chapters = checkedChapters(input.chapters, event.metric_key, event.value!, event.artifact_key);
      if (!chapters.length || chaptersFor(this.store, event.root_event_id).length) invalid('此处只补充尚未确定的章号。');
      const overlaps = new Map<string, AssetEvent>();
      for (const chapter of chapters) for (const other of chapterMatches(this.store, event.project_id, event.metric_key, chapter)) if (other.change_kind !== 'void' && other.root_event_id !== event.root_event_id) overlaps.set(other.root_event_id, other);
      if (overlaps.size && !input.merge) invalid('这些章号已有记录。确认是同一批后，选择合并重复记录。');
      for (const other of overlaps.values()) {
        const otherChapters = chaptersFor(this.store, other.root_event_id);
        if (other.occurred_on !== date || otherChapters.some(n => !chapters.includes(n)) || other.value !== otherChapters.length) invalid('重叠记录跨日期或仅部分重叠，请先逐项核对，系统不会自动合并。');
        this.insertEvent({ ...other, id: randomUUID(), change_kind: 'void', value: null, supersedes_event_id: other.id, correction_reason: `用户确认同批章节，合并计入 ${event.artifact_key}；来源与旧记录保留`, created_at: new Date().toISOString() });
        this.store.database.prepare('INSERT OR IGNORE INTO asset_evidence VALUES(?,?,?,?)').run(event.root_event_id, other.artifact_key, other.source, new Date().toISOString());
        for (const row of this.store.database.prepare('SELECT * FROM asset_evidence WHERE root_event_id=?').all(other.root_event_id)) this.store.database.prepare('INSERT OR IGNORE INTO asset_evidence VALUES(?,?,?,?)').run(event.root_event_id, String(row.evidence_key), String(row.source), String(row.created_at));
        this.invalidateTask(other.task_id);
      }
      for (const chapter of chapters) this.store.database.prepare('INSERT INTO asset_chapters VALUES(?,?)').run(event.root_event_id, chapter);
      this.store.database.prepare('INSERT INTO asset_evidence VALUES(?,?,?,?)').run(event.root_event_id, `identity:${input.requestId}`, `用户核对章号：${chapters.join(',')}${overlaps.size ? '；同批记录已合并，数量只计一次' : ''}`, new Date().toISOString());
    });
  }

  pin(date: string, id: string, input: DayWrite & { pinned: boolean }) {
    return this.mutate(date, `status:pin:${id}`, input, log => {
      this.getTask(id, log);
      if (input.pinned) this.store.database.prepare('INSERT OR IGNORE INTO task_pins VALUES(?,?)').run(id, new Date().toISOString());
      else this.store.database.prepare('DELETE FROM task_pins WHERE task_id=?').run(id);
    });
  }

  previousPlan(date: string): { date: string; draft: PlanDraft } | null {
    const rows = this.store.database.prepare('SELECT * FROM daily_logs WHERE business_date < ? ORDER BY business_date DESC').all(date);
    for (const row of rows) {
      const log = toLog(row);
      const snapshot = log.plan_snapshots.find(item => item.plan_version === log.current_plan_version);
      if (!snapshot || snapshot.day_mode !== 'work') continue;
      const scheduled = snapshot.tasks.filter(task => canSchedule(this.store.getProject(task.project_id)));
      if (!scheduled.length) continue;
      const dimensions = structuredClone(snapshot.dimensions);
      for (const dimension of DIMENSIONS) {
        const members = scheduled.filter(task => task.scoring_dimension === dimension);
        if (!members.length) dimensions[dimension] = { applicable: false, reason: '当前没有此维度的活跃项目安排' };
        else if (scheduled.length !== snapshot.tasks.length) members.forEach((task, i) => { task.raw_points = Math.floor(DIMENSION_WEIGHTS[dimension] / members.length) + (i < DIMENSION_WEIGHTS[dimension] % members.length ? 1 : 0); });
      }
      const blocks = new Map(snapshot.work_blocks.map(block => [block.id, randomUUID()]));
      return { date: log.business_date, draft: {
        day_mode: 'work', available_minutes: snapshot.available_minutes, dimensions,
        tasks: scheduled.map(({ project_name: _name, ...task }) => ({ ...task, candidate_id: randomUUID(), task_id: null, work_block_id: blocks.get(task.work_block_id)! })),
        work_blocks: snapshot.work_blocks.filter(block => scheduled.some(task => task.work_block_id === block.id)).map(block => ({ ...block, id: blocks.get(block.id)! })), change_reason: '', notes: '',
      } };
    }
    return null;
  }

}

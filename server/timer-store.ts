import { randomUUID } from 'node:crypto';
import type { DayStore } from './day-store.ts';
import type { DailyLog, DayWrite } from '../shared/day-contracts.ts';
import type { ActiveTimer, TimerPeriodWrite, TimerPoint, TimerPointDeleteWrite, TimerPointWrite, TimerSession, TimerStartWrite, TimerStopWrite, TimerView } from '../shared/timer-contracts.ts';
import { AppError, invalid } from './errors.ts';
import { integer, object, requestId } from './validation.ts';

export const PERIOD_SOURCE = '时间段补记（精确起止，已按整分钟累计）';
const SESSION_SOURCES = ['计时记录（开始至暂停，已按整分钟累计）', '追加计时记录', '一刻导入（按完整专注时长累计）', '本机计时与一刻导入（按共享时段累计）', PERIOD_SOURCE];
function dateAt(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp));
}
function dateShift(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10);
}
function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') invalid(`${label}必须是含时区的有效时间。`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) invalid(`${label}必须是含时区的有效时间。`);
  const [, year, month, day, hour, minute, second, offset] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}` || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))) invalid(`${label}不是有效的日期或时刻。`);
  return new Date(value).toISOString();
}
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f]/u.test(value)) invalid(`${label}无效。`);
  return value;
}
function writeBase(body: Record<string, unknown>): DayWrite { return { requestId: requestId(body.requestId), revision: integer(body.revision, '日期版本', 0) }; }
export function timerPointWrite(value: unknown): TimerPointWrite {
  const body = object(value, '时间点记录', ['requestId', 'revision', 'label', 'occurred_at']);
  if (typeof body.label !== 'string' || !body.label.trim() || body.label.trim().length > 120 || /[\u0000-\u001f]/u.test(body.label)) invalid('请填写 1 到 120 字的时间点名称。');
  return { ...writeBase(body), label: body.label.trim(), occurred_at: timestamp(body.occurred_at, '发生时间') };
}
export function timerPeriodWrite(value: unknown): TimerPeriodWrite {
  const body = object(value, '补记时间段', ['requestId', 'revision', 'block_id', 'started_at', 'stopped_at', 'acknowledgeUntrackedActual']);
  if (body.acknowledgeUntrackedActual !== undefined && typeof body.acknowledgeUntrackedActual !== 'boolean') invalid('请明确核对该段是否已含在原累计用时中。');
  return { ...writeBase(body), block_id: id(body.block_id, '投入时段'), started_at: timestamp(body.started_at, '开始时间'), stopped_at: timestamp(body.stopped_at, '结束时间'), acknowledgeUntrackedActual: body.acknowledgeUntrackedActual === true };
}
export function timerPointDeleteWrite(value: unknown): TimerPointDeleteWrite {
  const body = object(value, '撤销时间点', ['requestId', 'revision', 'point_id']);
  return { ...writeBase(body), point_id: id(body.point_id, '时间点') };
}
export function timerStartWrite(value: unknown): TimerStartWrite {
  const body = object(value, '开始专注', ['requestId', 'revision', 'block_id', 'task_id', 'target_minutes']);
  return { ...writeBase(body), block_id: id(body.block_id, '投入时段'),
    ...(body.task_id === undefined ? {} : { task_id: body.task_id === null ? null : id(body.task_id, '专注任务') }),
    ...(body.target_minutes === undefined ? {} : { target_minutes: body.target_minutes === null ? null : integer(body.target_minutes, '专注目标分钟', 1, 240) }) };
}
export function timerStopWrite(value: unknown): TimerStopWrite {
  const body = object(value, '暂停专注', ['requestId', 'revision', 'discard', 'expected_session_id', 'stopped_at']);
  if (typeof body.discard !== 'boolean') invalid('请选择记录或弃计当前时段。');
  if (body.stopped_at !== undefined && !body.expected_session_id) invalid('指定停止时刻时，必须核对这次专注的身份。');
  return { ...writeBase(body), discard: body.discard,
    ...(body.expected_session_id === undefined ? {} : { expected_session_id: body.expected_session_id === null ? null : id(body.expected_session_id, '预期专注记录') }),
    ...(body.stopped_at === undefined ? {} : { stopped_at: timestamp(body.stopped_at, '停止时间') }) };
}

/** Compare labels with the actual physical session ledger. Untracked totals
 * need the user's explicit check because their intervals cannot be inferred. */
function trackedActual(days: DayStore, log: DailyLog, blockId: string): boolean {
  const actual = log.work_block_actuals.find(item => item.block_id === blockId);
  const seconds = Number(days.store.database.prepare('SELECT coalesce(sum(elapsed_seconds),0) AS seconds FROM work_sessions WHERE daily_log_id=? AND block_id=?').get(log.id, blockId)!.seconds);
  if (!actual && seconds > 0) throw new AppError(409, 'TIMER_UNKNOWN_ACTUAL', '该时段有历史会话，但累计用时已被清空为未知。请先查看已有记录，并确认正确累计用时后再补记。');
  return !actual || (actual.minutes === Math.floor(seconds / 60) && actual.source.split('；').every(part => SESSION_SOURCES.includes(part)));
}

export class TimerStore {
  days: DayStore;
  constructor(days: DayStore) { this.days = days; }
  view(date: string): TimerView {
    const db = this.days.store.database;
    const selected = this.days.findLog(date);
    const now = Date.now();
    const title = (log: DailyLog | null, blockId: string) => [...(log?.plan_snapshots ?? [])].reverse().flatMap(plan => plan.work_blocks).find(block => block.id === blockId)?.title ?? '历史投入时段';
    const session = (row: Record<string, unknown>, log: DailyLog | null): TimerSession => {
      const context = db.prepare('SELECT c.task_id,c.target_minutes,t.snapshot_json FROM work_session_context c LEFT JOIN tasks t ON t.id=c.task_id WHERE c.session_id=?').get(String(row.id));
      return { id: String(row.id), block_id: String(row.block_id), block_title: title(log, String(row.block_id)), started_at: String(row.started_at), stopped_at: row.stopped_at === null ? null : String(row.stopped_at), elapsed_seconds: row.elapsed_seconds === null ? null : Number(row.elapsed_seconds),
        task_id: context?.task_id == null ? null : String(context.task_id), target_minutes: context?.target_minutes == null ? null : Number(context.target_minutes),
        task_title: context?.snapshot_json == null ? null : String(JSON.parse(String(context.snapshot_json)).title) };
    };
    const activeRow = db.prepare(`SELECT s.*,l.business_date,l.timezone FROM work_sessions s JOIN daily_logs l ON l.id=s.daily_log_id WHERE s.stopped_at IS NULL`).get();
    const active: ActiveTimer | null = activeRow ? { ...session(activeRow, this.days.findLog(String(activeRow.business_date))), daily_log_id: String(activeRow.daily_log_id), business_date: String(activeRow.business_date), timezone: String(activeRow.timezone) } : null;
    const sessions = db.prepare('SELECT s.* FROM work_sessions s JOIN daily_logs l ON l.id=s.daily_log_id WHERE l.business_date=? ORDER BY s.started_at,s.id').all(date).map(row => session(row, selected));
    const points = db.prepare('SELECT p.id,p.label,p.occurred_at,p.created_at FROM timer_points p JOIN daily_logs l ON l.id=p.daily_log_id WHERE l.business_date=? AND p.deleted_at IS NULL ORDER BY p.occurred_at DESC,p.id').all(date) as unknown as TimerPoint[];
    const totals = new Map<string, number | null>();
    for (const row of db.prepare('SELECT business_date,timezone,work_block_actuals_json FROM daily_logs WHERE business_date<=? ORDER BY business_date').all(date)) {
      const day = String(row.business_date);
      if (day > dateAt(now, String(row.timezone))) continue;
      const actuals = JSON.parse(String(row.work_block_actuals_json)) as DailyLog['work_block_actuals'];
      totals.set(day, actuals.length ? actuals.reduce((sum, actual) => sum + actual.minutes, 0) : null);
    }
    const week = Array.from({ length: 7 }, (_, i) => { const day = dateShift(date, i - 6); return { date: day, minutes: totals.get(day) ?? null }; });
    const knownTotal = [...totals.values()].filter(value => value !== null);
    const knownWeek = week.map(day => day.minutes).filter(value => value !== null);
    const pointCount = db.prepare('SELECT p.occurred_at,l.business_date,l.timezone FROM timer_points p JOIN daily_logs l ON l.id=p.daily_log_id WHERE l.business_date<=? AND p.deleted_at IS NULL').all(date)
      .filter(row => String(row.business_date) <= dateAt(now, String(row.timezone)) && Date.parse(String(row.occurred_at)) <= now).length;
    return { active, sessions, points, summary: { todayMinutes: totals.get(date) ?? null, weekMinutes: knownWeek.length ? knownWeek.reduce((sum, value) => sum + value, 0) : null,
      totalMinutes: knownTotal.length ? knownTotal.reduce((sum, value) => sum + value, 0) : null, timeDays: knownTotal.filter(value => value > 0).length, week, pointCount } };
  }
  point(date: string, input: TimerPointWrite) {
    return this.days.mutate(date, 'status:timer-point', input, log => {
      const at = timestamp(input.occurred_at, '发生时间');
      if (Date.parse(at) > Date.now() || dateAt(Date.parse(at), log.timezone) !== date) invalid('时间点须已经发生，且属于所选业务日期。');
      if (typeof input.label !== 'string' || !input.label.trim() || input.label.trim().length > 120 || /[\u0000-\u001f]/u.test(input.label)) invalid('请填写 1 到 120 字的时间点名称。');
      const db = this.days.store.database;
      if (db.prepare('SELECT id FROM timer_points WHERE daily_log_id=? AND label=? AND occurred_at=? AND deleted_at IS NULL').get(log.id, input.label.trim(), at)) invalid('已有相同时间点，请查看现有记录。');
      db.prepare('INSERT INTO timer_points VALUES(?,?,?,?,?,NULL)').run(randomUUID(), log.id, input.label.trim(), at, new Date().toISOString());
    });
  }
  deletePoint(date: string, input: TimerPointDeleteWrite) {
    return this.days.mutate(date, 'status:timer-point-delete', input, log => {
      const db = this.days.store.database;
      const point = db.prepare('SELECT id FROM timer_points WHERE id=? AND daily_log_id=?').get(input.point_id, log.id);
      if (!point) throw new AppError(404, 'TIMER_POINT_NOT_FOUND', '该时间点不属于所选日期。');
      db.prepare('UPDATE timer_points SET deleted_at=coalesce(deleted_at,?) WHERE id=?').run(new Date().toISOString(), input.point_id);
    });
  }
  period(date: string, input: TimerPeriodWrite) {
    return this.days.mutate(date, 'timer-period', input, log => {
      const started = timestamp(input.started_at, '开始时间'), stopped = timestamp(input.stopped_at, '结束时间');
      const start = Date.parse(started), end = Date.parse(stopped), now = Date.now();
      if (end > now || start > now) invalid('只能补记已经发生的时间段。');
      if (end <= start) invalid('结束时间必须晚于开始时间。');
      if (end - start > 8 * 3600_000) invalid('每段最多 8 小时，请分别补记实际投入。');
      if (dateAt(start, log.timezone) !== date || dateAt(end, log.timezone) !== date) invalid('时间段的起止须属于所选业务日期，跨日请分日补记。');
      if (!log.plan_snapshots.some(plan => plan.work_blocks.some(block => block.id === input.block_id))) invalid('请先确认包含此投入时段的计划。');
      const db = this.days.store.database;
      if (db.prepare('SELECT id FROM work_sessions WHERE stopped_at IS NULL').get()) invalid('已有计时正在进行，请先暂停后再补记时间段。');
      for (const row of db.prepare('SELECT started_at,stopped_at FROM work_sessions WHERE daily_log_id=? AND elapsed_seconds>0').all(log.id)) {
        if (start < Date.parse(String(row.stopped_at)) && Date.parse(String(row.started_at)) < end) invalid('此时间段与当天已有计时或导入记录重叠，请核对起止时间。');
      }
      const tracked = trackedActual(this.days, log, input.block_id);
      if (!tracked && input.acknowledgeUntrackedActual !== true) throw new AppError(409, 'TIMER_MANUAL_ACTUAL', '该投入时段已有手填或待核对的累计用时。请先查看已有用时及来源，明确勾选“这段时间未包含在已有累计实际分钟中”后再追加；已有记录未覆盖。');
      const seconds = Math.floor((end - start) / 1000);
      if (seconds < 1) invalid('时间段至少需要 1 秒。');
      const prior = Number(db.prepare('SELECT coalesce(sum(elapsed_seconds),0) AS seconds FROM work_sessions WHERE daily_log_id=? AND block_id=?').get(log.id, input.block_id)!.seconds);
      const added = Math.floor((prior + seconds) / 60) - Math.floor(prior / 60);
      const actuals = [...log.work_block_actuals], previous = actuals.find(item => item.block_id === input.block_id);
      const next = { block_id: input.block_id, minutes: (previous?.minutes ?? 0) + added, source: previous ? `${previous.source}；${PERIOD_SOURCE}${tracked ? '' : '（用户已确认本段未含在原累计中）'}` : PERIOD_SOURCE, updated_at: new Date().toISOString() };
      if (previous) actuals.splice(actuals.indexOf(previous), 1, next); else actuals.push(next);
      if (actuals.reduce((sum, item) => sum + item.minutes, 0) > 1440) invalid('当天累计实际投入不能超过 1440 分钟，请核对已有记录。');
      db.prepare('INSERT INTO work_sessions VALUES(?,?,?,?,?,?)').run(randomUUID(), log.id, input.block_id, started, stopped, seconds);
      db.prepare('UPDATE daily_logs SET work_block_actuals_json=? WHERE id=?').run(JSON.stringify(actuals), log.id);
      log.work_block_actuals = actuals;
    });
  }
  start(date: string, blockId: string, input: DayWrite & { task_id?: string | null; target_minutes?: number | null }) {
    const checked = timerStartWrite({ ...input, block_id: blockId });
    const { block_id: _blockId, ...write } = checked;
    // Schema 8 stored the internal camelcase blockId in the retry fingerprint.
    // Preserve that shape, including omitted optional fields, across upgrades.
    return this.days.mutate(date, 'timer-start', { ...write, blockId }, log => {
      if (this.view(date).active) invalid('已有计时正在进行，请先暂停该时段。');
      const plan = log.plan_snapshots.find(p => p.plan_version === log.current_plan_version);
      if (!plan?.work_blocks.some(b => b.id === blockId)) invalid('请先确认包含此时段的计划。');
      const task = checked.task_id ? this.days.getTask(checked.task_id, log) : null;
      if (task && (!task.eligible || task.work_block_id !== blockId)) invalid('专注任务须属于本日当前计划和所选投入时段。');
      if (task && (task.status === 'done' || task.status === 'cancelled')) invalid('这项任务已经结束，请先明确调整任务状态后再开始专注。');
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: log.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      if (date !== today) invalid('计时只能在今天开始，历史用时请手工补记。');
      const sessionId = randomUUID(), now = new Date().toISOString(), db = this.days.store.database;
      db.prepare('INSERT INTO work_sessions VALUES(?,?,?,?,NULL,NULL)').run(sessionId, log.id, blockId, now);
      db.prepare('INSERT INTO work_session_context VALUES(?,?,?)').run(sessionId, checked.task_id ?? null, checked.target_minutes ?? null);
      if (task?.status === 'todo') db.prepare("UPDATE tasks SET status='doing',updated_at=? WHERE id=?").run(now, task.task_id);
    });
  }
  stop(date: string, input: TimerStopWrite) {
    const checked = timerStopWrite(input);
    return this.days.mutate(date, 'timer-stop', checked, log => this.stopInTransaction(log, checked.discard, undefined, checked.expected_session_id ?? undefined, checked.stopped_at));
  }
  stopInTransaction(log: DailyLog, discard = false, blockId?: string, expectedSessionId?: string, stoppedAt?: string) {
    const db = this.days.store.database;
    const active = db.prepare('SELECT * FROM work_sessions WHERE stopped_at IS NULL AND daily_log_id=?').get(log.id);
    if (expectedSessionId && active?.id !== expectedSessionId) throw new AppError(409, 'TIMER_SESSION_CHANGED', '这段专注已结束或在其他页面切换，请读取当前任务后再操作。');
    if (!active || (blockId && active.block_id !== blockId)) return;
    const recordedAt = new Date();
    const now = stoppedAt === undefined ? recordedAt : new Date(stoppedAt);
    if (!Number.isFinite(now.getTime()) || now.getTime() > recordedAt.getTime() || now.getTime() < Date.parse(String(active.started_at))) invalid('停止时间须已经发生，且不能早于这次专注开始。');
    const seconds = discard ? 0 : Math.max(0, Math.floor((now.getTime() - Date.parse(String(active.started_at))) / 1000));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: log.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    if (!discard && today !== log.business_date) invalid('计时已跨过业务日期，请弃计本段后分别补记两天用时，避免全部计入同一天。');
    if (seconds > 8 * 3600) invalid('本段计时超过8小时，可能包含离开时间。请先弃计本段，再补记实际分钟。');
    const prior = Number(db.prepare('SELECT coalesce(sum(elapsed_seconds),0) AS seconds FROM work_sessions WHERE daily_log_id=? AND block_id=?').get(log.id, String(active.block_id))!.seconds);
    const added = Math.floor((prior + seconds) / 60) - Math.floor(prior / 60);
    const actuals = [...log.work_block_actuals]; const previous = actuals.find(a => a.block_id === active.block_id);
    if (seconds > 0) {
      const next = { block_id: String(active.block_id), minutes: (previous?.minutes ?? 0) + added, source: previous ? `${previous.source}；追加计时记录` : '计时记录（开始至暂停，已按整分钟累计）', updated_at: recordedAt.toISOString() };
      if (previous) actuals.splice(actuals.indexOf(previous), 1, next); else actuals.push(next);
    }
    if (actuals.reduce((n, a) => n + a.minutes, 0) > 1440) invalid('累计用时超过当天容量上限，请弃计本段并核对已有用时。');
    db.prepare('UPDATE work_sessions SET stopped_at=?,elapsed_seconds=? WHERE id=?').run(now.toISOString(), seconds, String(active.id));
    db.prepare('UPDATE daily_logs SET work_block_actuals_json=? WHERE id=?').run(JSON.stringify(actuals), log.id);
    log.work_block_actuals = actuals;
  }
}

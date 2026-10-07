import type { DailyLog, DayState, DayWrite, WorkBlockActual } from '../shared/day-contracts.ts';
import type { DayStore } from './day-store.ts';
import { AppError, invalid } from './errors.ts';
import { integer, object, requestId } from './validation.ts';
import { PERIOD_SOURCE } from './timer-store.ts';

const MINUTE = 60_000;
const SOURCE_NATIVE = '计时记录（开始至暂停，已按整分钟累计）';
const SOURCE_NATIVE_ADDED = '追加计时记录';
const SOURCE_IMPORT = '一刻导入（按完整专注时长累计）';
const SOURCE_MIXED = '本机计时与一刻导入（按共享时段累计）';

export interface FocusImportSession {
  id: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  blockId: string;
}

export interface FocusImportWrite extends DayWrite {
  sessions: FocusImportSession[];
}

interface SessionRow {
  id: string;
  daily_log_id: string;
  block_id: string;
  started_at: string;
  stopped_at: string | null;
  elapsed_seconds: number | null;
}

function conflict(code: string, message: string): never {
  throw new AppError(409, code, message);
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > Date.now()) {
    invalid(`${label}必须是已发生的有效毫秒时间戳。`);
  }
  return value as number;
}

export function focusImportWrite(value: unknown): FocusImportWrite {
  const input = object(value, '一刻导入', ['requestId', 'revision', 'sessions']);
  if (!Array.isArray(input.sessions) || input.sessions.length < 1 || input.sessions.length > 100) {
    invalid('每次请选择 1 到 100 段完整专注记录。');
  }
  const sessions = input.sessions.map((item) => {
    const row = object(item, '专注记录', ['id', 'startedAt', 'completedAt', 'durationMs', 'blockId']);
    if (typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/u.test(row.id)) invalid('一刻会话标识无效。');
    if (typeof row.blockId !== 'string' || !row.blockId.trim() || row.blockId.length > 160 || /[\u0000-\u001f]/u.test(row.blockId)) {
      invalid('投入时段标识无效。');
    }
    const startedAt = timestamp(row.startedAt, '开始时间');
    const completedAt = timestamp(row.completedAt, '完成时间');
    const durationMs = integer(row.durationMs, '专注时长毫秒数', MINUTE, 180 * MINUTE);
    if (durationMs % 1000 !== 0) invalid('专注时长须以整秒记录。');
    if (completedAt <= startedAt || completedAt - startedAt < durationMs) {
      invalid('专注记录的完成时间与时长不一致。');
    }
    return { id: row.id, startedAt, completedAt, durationMs, blockId: row.blockId };
  });
  return { requestId: requestId(input.requestId), revision: integer(input.revision, '当天版本', 0), sessions };
}

function dateAt(timestampMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(timestampMs));
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function trustedActualSource(source: string): boolean {
  return source.split('；').every((part) => [SOURCE_NATIVE, SOURCE_NATIVE_ADDED, SOURCE_IMPORT, SOURCE_MIXED, PERIOD_SOURCE].includes(part));
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function sameRow(row: SessionRow, session: FocusImportSession, dailyLogId: string): boolean {
  return row.daily_log_id === dailyLogId && row.block_id === session.blockId
    && row.started_at === new Date(session.startedAt).toISOString()
    && row.stopped_at === new Date(session.completedAt).toISOString()
    && row.elapsed_seconds === session.durationMs / 1000;
}

export class FocusImportStore {
  private readonly days: DayStore;
  constructor(days: DayStore) { this.days = days; }

  private evaluate(date: string, log: DailyLog, sessions: FocusImportSession[]) {
    const db = this.days.store.database;
    const plan = log.plan_snapshots.find((item) => item.plan_version === log.current_plan_version);
    if (!plan || plan.day_mode !== 'work') invalid('请先确认当前工作日计划，再选择投入时段。');
    if (db.prepare('SELECT id FROM work_sessions WHERE stopped_at IS NULL LIMIT 1').get()) {
      conflict('FOCUS_IMPORT_ACTIVE_TIMER', '本机仍有计时在运行，请先暂停并核对实际用时。');
    }
    const blocks = new Set(plan.work_blocks.map((block) => block.id));
    const existing = db.prepare('SELECT * FROM work_sessions WHERE daily_log_id=?').all(log.id) as unknown as SessionRow[];
    const inputIds = new Map<string, FocusImportSession>();
    const newSessions: FocusImportSession[] = [];
    const touchedBlocks = new Set<string>();
    for (const session of sessions) {
      if (!blocks.has(session.blockId)) invalid('选择的投入时段不在当前已确认计划中，请重新核对。');
      if (dateAt(session.startedAt, log.timezone) !== date || dateAt(session.completedAt, log.timezone) !== date) {
        invalid('专注记录跨越业务日期，须分日核对后手工补记。');
      }
      touchedBlocks.add(session.blockId);
      const previousInput = inputIds.get(session.id);
      if (previousInput) {
        if (JSON.stringify(previousInput) !== JSON.stringify(session)) conflict('FOCUS_IMPORT_CONFLICT', '同一个一刻会话包含不同内容，请核对备份。');
        continue;
      }
      inputIds.set(session.id, session);
      const id = `still-focus:${session.id}`;
      const prior = db.prepare('SELECT * FROM work_sessions WHERE id=?').get(id) as SessionRow | undefined;
      if (prior) {
        if (!sameRow(prior, session, log.id)) conflict('FOCUS_IMPORT_CONFLICT', '该一刻会话已导入，但时长、日期或投入时段不同；已有记录未改动。');
      } else {
        newSessions.push(session);
      }
    }
    for (const session of newSessions) {
      for (const row of existing) {
        if (overlaps(session.startedAt, session.completedAt, Date.parse(row.started_at), Date.parse(row.stopped_at!))) {
          conflict('FOCUS_IMPORT_OVERLAP', '一刻记录与当天已有计时时段重叠，请先核对，避免重复累计。');
        }
      }
      for (const other of newSessions) {
        if (other === session) break;
        if (overlaps(session.startedAt, session.completedAt, other.startedAt, other.completedAt)) {
          conflict('FOCUS_IMPORT_OVERLAP', '本次选择的一刻记录时间相互重叠，请先核对。');
        }
      }
    }
    // Hand-entered minutes have no physical interval to compare against the
    // imported session, even when assigned to another block. Never infer that
    // they are disjoint and silently add more time to the same business day.
    for (const actual of log.work_block_actuals) {
      const priorSeconds = existing.filter((row) => row.block_id === actual.block_id)
        .reduce((sum, row) => sum + Number(row.elapsed_seconds ?? 0), 0);
      if (!trustedActualSource(actual.source) || actual.minutes !== Math.floor(priorSeconds / 60)) {
        conflict('FOCUS_IMPORT_MANUAL_CONFLICT', '该投入时段已有手填或更正的累计用时，请先人工核对，不能直接叠加。');
      }
    }
    for (const blockId of touchedBlocks) {
      const priorSeconds = existing.filter((row) => row.block_id === blockId).reduce((sum, row) => sum + Number(row.elapsed_seconds ?? 0), 0);
      const actual = log.work_block_actuals.find((item) => item.block_id === blockId);
      if (!actual && priorSeconds > 0) {
        conflict('FOCUS_IMPORT_MANUAL_CONFLICT', '该时段已有计时但累计用时被清空，请先人工核对。');
      }
    }
    return { existing, newSessions };
  }

  import(date: string, input: FocusImportWrite): DayState {
    if (this.days.store.database.prepare('SELECT 1 FROM request_dedup WHERE scope=? AND request_id=?')
      .get(`day:${date}:focus-import`, input.requestId)) {
      // Let the existing DayStore receipt verify the payload hash and replay
      // before today's plan, active timer, or manual edits are re-examined.
      return this.days.mutate(date, 'focus-import', input, () => {
        throw new Error('Existing import receipt was not replayed.');
      });
    }
    const log = this.days.findLog(date);
    if (!log) invalid('请先确认当前工作日计划，再导入专注记录。');
    const initial = this.evaluate(date, log, input.sessions);
    if (!initial.newSessions.length) {
      // An identical backup is a genuine no-op. Keep DayStore's dedup scope
      // without consuming another revision or changing a settled score.
      this.days.store.idempotent(`day:${date}:focus-import`, input.requestId, input, () => ({ accepted: true }));
      return this.days.getState(date);
    }
    return this.days.mutate(date, 'focus-import', input, (current) => {
      const { existing, newSessions } = this.evaluate(date, current, input.sessions);
      const db = this.days.store.database;
      for (const session of newSessions) {
        db.prepare('INSERT INTO work_sessions(id,daily_log_id,block_id,started_at,stopped_at,elapsed_seconds) VALUES(?,?,?,?,?,?)')
          .run(`still-focus:${session.id}`, current.id, session.blockId, new Date(session.startedAt).toISOString(),
            new Date(session.completedAt).toISOString(), session.durationMs / 1000);
      }
      const actuals: WorkBlockActual[] = [...current.work_block_actuals];
      const changedBlocks = new Set(newSessions.map((session) => session.blockId));
      const now = new Date().toISOString();
      for (const blockId of changedBlocks) {
        const rows = existing.filter((row) => row.block_id === blockId);
        const seconds = rows.reduce((sum, row) => sum + Number(row.elapsed_seconds ?? 0), 0)
          + newSessions.filter((session) => session.blockId === blockId).reduce((sum, session) => sum + session.durationMs / 1000, 0);
        const minutes = Math.floor(seconds / 60);
        const mixed = rows.some((row) => !row.id.startsWith('still-focus:') && Number(row.elapsed_seconds ?? 0) > 0);
        const next: WorkBlockActual = { block_id: blockId, minutes, source: mixed ? SOURCE_MIXED : SOURCE_IMPORT, updated_at: now };
        const index = actuals.findIndex((item) => item.block_id === blockId);
        if (index >= 0) actuals[index] = next;
        else actuals.push(next);
      }
      if (actuals.reduce((sum, item) => sum + item.minutes, 0) > 1440) invalid('当天实际投入不能超过 1440 分钟，请核对重复时段。');
      db.prepare('UPDATE daily_logs SET work_block_actuals_json=? WHERE id=?').run(JSON.stringify(actuals), current.id);
    });
  }
}

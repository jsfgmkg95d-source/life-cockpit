import { randomUUID } from 'node:crypto';
import type { ScheduleDeleteWrite, ScheduleSaveWrite, ScheduleView } from '../shared/schedule-contracts.ts';
import type { DayStore } from './day-store.ts';
import { dayText } from './day-validation.ts';
import { AppError, invalid } from './errors.ts';
import { integer, object, requestId } from './validation.ts';

const identity = (value: unknown, label: string) => dayText(value, label, 160);
export function scheduleSaveWrite(value: unknown): ScheduleSaveWrite {
  const body = object(value, '安排时间', ['requestId', 'revision', 'id', 'task_id', 'title', 'start_minute', 'duration_minutes']);
  const input: ScheduleSaveWrite = {
    requestId: requestId(body.requestId), revision: integer(body.revision, '日期版本', 0),
    id: body.id === undefined || body.id === null || body.id === '' ? null : identity(body.id, '安排标识'),
    task_id: body.task_id === null ? null : identity(body.task_id, '任务'), title: dayText(body.title, '安排名称', 240),
    start_minute: integer(body.start_minute, '开始分钟', 0, 1439), duration_minutes: integer(body.duration_minutes, '安排时长', 1, 720),
  };
  if (input.start_minute + input.duration_minutes > 1440) invalid('安排须在当天结束，跨日请分两天安排。');
  return input;
}
export function scheduleDeleteWrite(value: unknown): ScheduleDeleteWrite {
  const body = object(value, '移除安排', ['requestId', 'revision', 'id']);
  return { requestId: requestId(body.requestId), revision: integer(body.revision, '日期版本', 0), id: identity(body.id, '安排标识') };
}

export class ScheduleStore {
  days: DayStore;
  constructor(days: DayStore) { this.days = days; }
  view(date: string): ScheduleView {
    const state = this.days.getState(date);
    const rows = state.log ? this.days.store.database.prepare('SELECT * FROM day_schedule WHERE daily_log_id=? AND deleted_at IS NULL ORDER BY start_minute,created_at,id').all(state.log.id) : [];
    const blocks = rows.map(row => ({ id: String(row.id), task_id: row.task_id === null ? null : String(row.task_id), title: String(row.title),
      start_minute: Number(row.start_minute), duration_minutes: Number(row.duration_minutes),
      task_eligible: row.task_id === null ? null : state.tasks.some(task => task.task_id === row.task_id && task.eligible) }));
    return { business_date: date, timezone: state.timezone, revision: state.log?.revision ?? 0, blocks, plannedMinutes: blocks.reduce((sum, block) => sum + block.duration_minutes, 0) };
  }
  save(date: string, input: ScheduleSaveWrite): ScheduleView {
    const checked = scheduleSaveWrite(input);
    this.days.mutate(date, 'status:schedule-save', checked, log => {
      const db = this.days.store.database;
      const previous = checked.id ? db.prepare('SELECT * FROM day_schedule WHERE id=? AND daily_log_id=? AND deleted_at IS NULL').get(checked.id, log.id) : null;
      if (checked.id && !previous) throw new AppError(404, 'SCHEDULE_NOT_FOUND', '该安排已移除或不属于所选日期。');
      if (checked.task_id) {
        const task = this.days.getTask(checked.task_id, log);
        if (!task.eligible) invalid('请选择本日当前安排中的任务；旧任务的历史时间安排仍然保留。');
      }
      const conflict = db.prepare('SELECT id FROM day_schedule WHERE daily_log_id=? AND deleted_at IS NULL AND id!=? AND start_minute<? AND start_minute+duration_minutes>? LIMIT 1')
        .get(log.id, checked.id ?? '', checked.start_minute + checked.duration_minutes, checked.start_minute);
      if (conflict) throw new AppError(409, 'SCHEDULE_OVERLAP', '此时间与已有安排重叠，请调整开始时刻或时长。');
      const now = new Date().toISOString();
      if (previous) db.prepare('UPDATE day_schedule SET task_id=?,title=?,start_minute=?,duration_minutes=?,updated_at=? WHERE id=?').run(checked.task_id, checked.title, checked.start_minute, checked.duration_minutes, now, checked.id!);
      else db.prepare('INSERT INTO day_schedule VALUES(?,?,?,?,?,?,?,?,NULL)').run(randomUUID(), log.id, checked.task_id, checked.title, checked.start_minute, checked.duration_minutes, now, now);
    });
    return this.view(date);
  }
  delete(date: string, input: ScheduleDeleteWrite): ScheduleView {
    const checked = scheduleDeleteWrite(input);
    this.days.mutate(date, 'status:schedule-delete', checked, log => {
      const db = this.days.store.database;
      if (!db.prepare('SELECT id FROM day_schedule WHERE id=? AND daily_log_id=?').get(checked.id, log.id)) throw new AppError(404, 'SCHEDULE_NOT_FOUND', '该安排不属于所选日期。');
      const now = new Date().toISOString();
      db.prepare('UPDATE day_schedule SET deleted_at=coalesce(deleted_at,?),updated_at=? WHERE id=?').run(now, now, checked.id);
    });
    return this.view(date);
  }
}

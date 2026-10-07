import { randomUUID } from 'node:crypto';
import type { DayState } from '../shared/day-contracts.ts';
import type { InboxArchiveWrite, InboxCaptureWrite, InboxItem, InboxPromoteWrite, InboxRestoreWrite, InboxView } from '../shared/inbox-contracts.ts';
import type { DayStore } from './day-store.ts';
import { dayText, quickTaskWrite } from './day-validation.ts';
import { AppError } from './errors.ts';
import { integer, object, requestId } from './validation.ts';

export function inboxCaptureWrite(value: unknown): InboxCaptureWrite {
  const body = object(value, '快速记录', ['requestId', 'title', 'project_id', 'estimated_minutes']);
  return { requestId: requestId(body.requestId), title: dayText(body.title, '要记录的事', 240),
    project_id: body.project_id === undefined || body.project_id === null ? null : dayText(body.project_id, '项目', 160),
    estimated_minutes: body.estimated_minutes === undefined || body.estimated_minutes === null ? null : integer(body.estimated_minutes, '预计分钟', 0, 1440) };
}
export function inboxArchiveWrite(value: unknown): InboxArchiveWrite {
  const body = object(value, '归档记录', ['requestId', 'revision']);
  return { requestId: requestId(body.requestId), revision: integer(body.revision, '记录版本', 1) };
}
export function inboxRestoreWrite(value: unknown): InboxRestoreWrite {
  const body = object(value, '恢复待安排记录', ['requestId', 'revision']);
  return { requestId: requestId(body.requestId), revision: integer(body.revision, '记录版本', 1) };
}
export function inboxPromoteWrite(value: unknown): InboxPromoteWrite {
  const body = object(value, '安排收件箱事项', ['requestId', 'revision', 'inbox_id', 'inbox_revision', 'project_id', 'project_revision', 'title', 'acceptance', 'result_type', 'metric_key', 'target_value', 'budget_minutes', 'available_minutes', 'resume_project', 'acknowledgeOverCapacity']);
  const { inbox_id, inbox_revision, ...task } = body;
  return { ...quickTaskWrite(task), inbox_id: dayText(inbox_id, '收件箱记录', 160), inbox_revision: integer(inbox_revision, '收件箱版本', 1) };
}

export class InboxStore {
  days: DayStore;
  constructor(days: DayStore) { this.days = days; }
  view(): InboxView {
    const items = this.days.store.database.prepare('SELECT * FROM inbox_items ORDER BY created_at DESC,rowid DESC').all().map(row => ({ ...row }) as unknown as InboxItem);
    return { items, inboxCount: items.filter(item => item.status === 'inbox').length };
  }
  get(id: string): InboxItem {
    const row = this.days.store.database.prepare('SELECT * FROM inbox_items WHERE id=?').get(id);
    if (!row) throw new AppError(404, 'INBOX_NOT_FOUND', '未找到这条记录，请刷新收件箱。');
    return { ...row } as unknown as InboxItem;
  }
  capture(input: InboxCaptureWrite): InboxView & { item: InboxItem } {
    const checked = inboxCaptureWrite(input);
    return this.days.store.idempotent('inbox:capture', checked.requestId, checked, () => {
      if (checked.project_id) this.days.store.getProject(checked.project_id);
      const id = randomUUID(), now = new Date().toISOString();
      this.days.store.database.prepare('INSERT INTO inbox_items VALUES(?,?,?,?,1,\'inbox\',NULL,NULL,?,?)').run(id, checked.title, checked.project_id ?? null, checked.estimated_minutes ?? null, now, now);
      return { ...this.view(), item: this.get(id) };
    });
  }
  archive(id: string, input: InboxArchiveWrite): InboxView & { item: InboxItem } {
    const checked = inboxArchiveWrite(input);
    return this.days.store.idempotent(`inbox:${id}:archive`, checked.requestId, checked, () => {
      const item = this.get(id);
      if (item.revision !== checked.revision) throw new AppError(409, 'REVISION_CONFLICT', '这条记录已经更新，请刷新后再归档。');
      this.days.store.database.prepare("UPDATE inbox_items SET status='archived',revision=revision+1,updated_at=? WHERE id=?").run(new Date().toISOString(), id);
      return { ...this.view(), item: this.get(id) };
    });
  }
  restore(id: string, input: InboxRestoreWrite): InboxView & { item: InboxItem } {
    const checked = inboxRestoreWrite(input);
    return this.days.store.idempotent(`inbox:${id}:restore`, checked.requestId, checked, () => {
      const item = this.get(id);
      if (item.revision !== checked.revision) throw new AppError(409, 'REVISION_CONFLICT', '这条记录已经更新，请刷新后再恢复。');
      if (item.status === 'planned' || item.planned_task_id !== null || item.planned_date !== null) throw new AppError(409, 'INBOX_ALREADY_PLANNED', '这条记录已加入当日任务，请查看原任务，不会重复恢复为待安排事项。');
      if (item.status !== 'archived') throw new AppError(409, 'INBOX_NOT_ARCHIVED', '这条记录已在待安排清单中，无需再次恢复。');
      this.days.store.database.prepare("UPDATE inbox_items SET status='inbox',revision=revision+1,updated_at=? WHERE id=?")
        .run(new Date().toISOString(), id);
      return { ...this.view(), item: this.get(id) };
    });
  }
  promote(date: string, input: InboxPromoteWrite): DayState {
    const checked = inboxPromoteWrite(input);
    return this.days.quickTask(date, checked, (state) => {
      const item = this.get(checked.inbox_id);
      if (item.revision !== checked.inbox_revision) throw new AppError(409, 'REVISION_CONFLICT', '收件箱记录已经更新，请刷新后再安排。');
      if (item.status !== 'inbox') throw new AppError(409, 'INBOX_ALREADY_PLANNED', '这条记录已安排或归档，不会重复添加任务。');
      const task = state.log!.plan_snapshots.find(plan => plan.plan_version === state.log!.current_plan_version)!.tasks.at(-1)!;
      this.days.store.database.prepare("UPDATE inbox_items SET status='planned',planned_date=?,planned_task_id=?,revision=revision+1,updated_at=? WHERE id=?")
        .run(date, task.task_id, new Date().toISOString(), item.id);
    }, 'inbox-promote');
  }
}

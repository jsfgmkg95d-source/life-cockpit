import type { QuickTaskWrite } from './quick-task.ts';

export interface InboxItem {
  id: string;
  title: string;
  project_id: string | null;
  estimated_minutes: number | null;
  revision: number;
  status: 'inbox' | 'planned' | 'archived';
  planned_date: string | null;
  planned_task_id: string | null;
  created_at: string;
  updated_at: string;
}
export interface InboxView { items: InboxItem[]; inboxCount: number }
export interface InboxCaptureWrite {
  requestId: string;
  title: string;
  project_id?: string | null;
  estimated_minutes?: number | null;
}
export interface InboxArchiveWrite { requestId: string; revision: number }
export interface InboxRestoreWrite { requestId: string; revision: number }
export interface InboxPromoteWrite extends QuickTaskWrite { inbox_id: string; inbox_revision: number }

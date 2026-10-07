import type { DatabaseSync } from 'node:sqlite';

export function migrateScheduleTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE day_schedule (
      id TEXT PRIMARY KEY NOT NULL,
      daily_log_id TEXT NOT NULL REFERENCES daily_logs(id),
      task_id TEXT REFERENCES tasks(id),
      title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 240),
      start_minute INTEGER NOT NULL CHECK(start_minute BETWEEN 0 AND 1439),
      duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 1 AND 720),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      CHECK(start_minute+duration_minutes<=1440)
    ) STRICT;
    CREATE INDEX day_schedule_day ON day_schedule(daily_log_id,start_minute);
    CREATE TABLE inbox_items (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 240),
      project_id TEXT REFERENCES projects(id),
      estimated_minutes INTEGER CHECK(estimated_minutes IS NULL OR estimated_minutes BETWEEN 0 AND 1440),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
      status TEXT NOT NULL DEFAULT 'inbox' CHECK(status IN ('inbox','planned','archived')),
      planned_date TEXT,
      planned_task_id TEXT REFERENCES tasks(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK((planned_date IS NULL AND planned_task_id IS NULL) OR (planned_date IS NOT NULL AND planned_task_id IS NOT NULL)),
      CHECK(status!='inbox' OR planned_task_id IS NULL),
      CHECK(status!='planned' OR planned_task_id IS NOT NULL)
    ) STRICT;
    CREATE INDEX inbox_items_status ON inbox_items(status,created_at);
    CREATE TABLE work_session_context (
      session_id TEXT PRIMARY KEY NOT NULL REFERENCES work_sessions(id),
      task_id TEXT REFERENCES tasks(id),
      target_minutes INTEGER CHECK(target_minutes IS NULL OR target_minutes BETWEEN 1 AND 240)
    ) STRICT;
    PRAGMA user_version = 9;
  `);
}

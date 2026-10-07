import type { DatabaseSync } from 'node:sqlite';

export function migrateTimerTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE timer_points (
      id TEXT PRIMARY KEY NOT NULL,
      daily_log_id TEXT NOT NULL REFERENCES daily_logs(id),
      label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 120),
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    ) STRICT;
    CREATE INDEX timer_points_day ON timer_points(daily_log_id,occurred_at);
    CREATE UNIQUE INDEX timer_points_unique ON timer_points(daily_log_id,label,occurred_at) WHERE deleted_at IS NULL;
    PRAGMA user_version = 8;
  `);
}

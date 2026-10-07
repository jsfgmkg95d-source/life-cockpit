import type { DatabaseSync } from 'node:sqlite';
import { chapterFromKey } from '../shared/chapters.ts';

export function migrateGrowthTables(db: DatabaseSync, legacyConnection: unknown = null): void {
  db.exec(`
    CREATE TABLE connector_states (id TEXT PRIMARY KEY, state_json TEXT NOT NULL CHECK(json_valid(state_json)), updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE asset_chapters (root_event_id TEXT NOT NULL REFERENCES asset_events(id), chapter INTEGER NOT NULL CHECK(chapter>0), PRIMARY KEY(root_event_id,chapter)) STRICT;
    CREATE TABLE asset_evidence (root_event_id TEXT NOT NULL REFERENCES asset_events(id), evidence_key TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(root_event_id,evidence_key)) STRICT;
    CREATE TABLE work_sessions (id TEXT PRIMARY KEY, daily_log_id TEXT NOT NULL REFERENCES daily_logs(id), block_id TEXT NOT NULL, started_at TEXT NOT NULL, stopped_at TEXT, elapsed_seconds INTEGER CHECK(elapsed_seconds IS NULL OR elapsed_seconds>=0)) STRICT;
    CREATE UNIQUE INDEX one_active_timer ON work_sessions((1)) WHERE stopped_at IS NULL;
    CREATE TABLE task_pins (task_id TEXT PRIMARY KEY REFERENCES tasks(id), pinned_at TEXT NOT NULL) STRICT;
    PRAGMA user_version = 6;
  `);
  db.prepare('INSERT INTO connector_states VALUES(?,?,?)').run('wedding', JSON.stringify(legacyConnection), legacyConnection ? String((legacyConnection as { checked_at?: string }).checked_at ?? '') : '');
  for (const row of db.prepare("SELECT id,artifact_key,value FROM asset_events WHERE change_kind='record' AND metric_key IN ('accepted_chapters','published_chapters')").all()) {
    const numbers = chapterFromKey(String(row.artifact_key));
    if (numbers.length === Number(row.value)) for (const chapter of numbers) db.prepare('INSERT INTO asset_chapters VALUES(?,?)').run(String(row.id), chapter);
  }
}

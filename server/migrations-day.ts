import type { DatabaseSync } from 'node:sqlite';

export function migrateDayTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE daily_logs (
      id TEXT PRIMARY KEY NOT NULL,
      business_date TEXT NOT NULL UNIQUE CHECK(length(business_date)=10),
      timezone TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
      current_plan_version INTEGER NOT NULL DEFAULT 0 CHECK(current_plan_version>=0),
      draft_plan_json TEXT CHECK(draft_plan_json IS NULL OR json_valid(draft_plan_json)),
      plan_snapshots_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(plan_snapshots_json)),
      work_block_actuals_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(work_block_actuals_json)),
      record_state TEXT NOT NULL DEFAULT 'incomplete' CHECK(record_state IN ('incomplete','complete')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(business_date,timezone)
    ) STRICT;
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY NOT NULL,
      daily_log_id TEXT NOT NULL REFERENCES daily_logs(id) ON DELETE RESTRICT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
      status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','done','cancelled')),
      result_state TEXT NOT NULL DEFAULT 'unknown' CHECK(result_state IN ('unknown','confirmed')),
      confirmed_result_json TEXT CHECK(confirmed_result_json IS NULL OR json_valid(confirmed_result_json)),
      eligible INTEGER NOT NULL DEFAULT 1 CHECK(eligible IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK((result_state='unknown' AND confirmed_result_json IS NULL) OR (result_state='confirmed' AND confirmed_result_json IS NOT NULL))
    ) STRICT;
    CREATE INDEX tasks_day_idx ON tasks(daily_log_id);
    CREATE TABLE asset_events (
      id TEXT PRIMARY KEY NOT NULL,
      daily_log_id TEXT NOT NULL REFERENCES daily_logs(id) ON DELETE RESTRICT,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
      artifact_key TEXT NOT NULL,
      metric_key TEXT NOT NULL CHECK(metric_key IN ('accepted_words','accepted_chapters','published_chapters','accepted_articles','published_articles','submission_batches','milestone_completed','health_sessions','learning_outputs')),
      value INTEGER CHECK(value IS NULL OR value>=0),
      stage TEXT NOT NULL CHECK(stage IN ('finalized','submitted','approved','published','completed')),
      summary TEXT NOT NULL,
      source TEXT NOT NULL,
      occurred_on TEXT NOT NULL,
      occurrence_precision TEXT NOT NULL DEFAULT 'date' CHECK(occurrence_precision='date'),
      timezone TEXT NOT NULL,
      measurement_scope TEXT NOT NULL DEFAULT 'project' CHECK(measurement_scope='project'),
      period_key TEXT NOT NULL DEFAULT 'lifetime' CHECK(period_key='lifetime'),
      confirmation_state TEXT NOT NULL DEFAULT 'user_confirmed' CHECK(confirmation_state='user_confirmed'),
      change_kind TEXT NOT NULL CHECK(change_kind IN ('record','replace','void')),
      supersedes_event_id TEXT REFERENCES asset_events(id) ON DELETE RESTRICT,
      root_event_id TEXT NOT NULL REFERENCES asset_events(id) ON DELETE RESTRICT,
      correction_reason TEXT,
      created_at TEXT NOT NULL,
      CHECK((change_kind='record' AND supersedes_event_id IS NULL AND root_event_id=id AND correction_reason IS NULL)
        OR (change_kind IN ('replace','void') AND supersedes_event_id IS NOT NULL AND correction_reason IS NOT NULL)),
      CHECK((change_kind='void' AND value IS NULL) OR (change_kind!='void' AND value IS NOT NULL))
    ) STRICT;
    CREATE UNIQUE INDEX asset_business_root_unique ON asset_events(project_id,artifact_key,metric_key,measurement_scope,period_key) WHERE change_kind='record';
    CREATE UNIQUE INDEX asset_successor_unique ON asset_events(supersedes_event_id) WHERE supersedes_event_id IS NOT NULL;
    CREATE INDEX asset_day_idx ON asset_events(daily_log_id);
    CREATE INDEX asset_task_idx ON asset_events(task_id);
    CREATE TRIGGER asset_events_no_update BEFORE UPDATE ON asset_events BEGIN SELECT RAISE(ABORT,'Confirmed asset facts are immutable'); END;
    CREATE TRIGGER asset_events_no_delete BEFORE DELETE ON asset_events BEGIN SELECT RAISE(ABORT,'Confirmed asset facts are immutable'); END;
    PRAGMA user_version = 2;
  `);
}

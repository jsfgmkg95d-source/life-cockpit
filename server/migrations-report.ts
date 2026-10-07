import type { DatabaseSync } from 'node:sqlite';
export function migrateReportTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE ai_settings(id INTEGER PRIMARY KEY CHECK(id=1),settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),revision INTEGER NOT NULL DEFAULT 1);
    INSERT INTO ai_settings VALUES(1,'{"mode":"local","model":"","max_output_tokens":2400,"daily_call_limit":10}',1);
    CREATE TABLE reports (
      id TEXT PRIMARY KEY, daily_log_id TEXT NOT NULL REFERENCES daily_logs(id), report_type TEXT NOT NULL CHECK(report_type IN ('plan','review')),
      report_version INTEGER NOT NULL,plan_version INTEGER NOT NULL,score_id TEXT REFERENCES scores(id),input_hash TEXT NOT NULL,
      input_snapshot_json TEXT NOT NULL CHECK(json_valid(input_snapshot_json)),status TEXT NOT NULL CHECK(status IN ('running','succeeded','degraded','failed')),
      content_json TEXT CHECK(content_json IS NULL OR json_valid(content_json)),run_meta_json TEXT NOT NULL CHECK(json_valid(run_meta_json)),
      owner_pid INTEGER NOT NULL,lease_until TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(daily_log_id,report_type,report_version), CHECK((report_type='plan' AND score_id IS NULL) OR (report_type='review' AND score_id IS NOT NULL))
    ) STRICT;
    CREATE UNIQUE INDEX report_one_running ON reports(daily_log_id,report_type) WHERE status='running';
    CREATE UNIQUE INDEX report_request_id ON reports(json_extract(run_meta_json,'$.request_id'));
    CREATE TRIGGER reports_frozen BEFORE UPDATE ON reports WHEN OLD.status!='running' BEGIN SELECT RAISE(ABORT,'Finished reports are immutable'); END;
    CREATE TRIGGER reports_no_delete BEFORE DELETE ON reports BEGIN SELECT RAISE(ABORT,'Reports are immutable'); END;
    CREATE TABLE report_adoptions (
      report_id TEXT NOT NULL REFERENCES reports(id),suggestion_index INTEGER NOT NULL,target_date TEXT NOT NULL,candidate_id TEXT NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(report_id,suggestion_index)
    ) STRICT;
    CREATE TABLE ai_calls(id TEXT PRIMARY KEY,day TEXT NOT NULL,report_id TEXT REFERENCES reports(id),status TEXT NOT NULL,input_tokens INTEGER,output_tokens INTEGER,created_at TEXT NOT NULL) STRICT;
    PRAGMA user_version=4;
  `);
}

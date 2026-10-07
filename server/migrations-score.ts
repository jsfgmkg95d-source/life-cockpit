import type { DatabaseSync } from 'node:sqlite';
export function migrateScoreTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE score_policies (
      id TEXT PRIMARY KEY, version INTEGER NOT NULL UNIQUE CHECK(version>0),
      name TEXT NOT NULL, dimension_weights_json TEXT NOT NULL CHECK(json_valid(dimension_weights_json)),
      rules_json TEXT NOT NULL CHECK(json_valid(rules_json)), effective_from TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO score_policies VALUES('default-v1',1,'默认四维履约 v1',
      '{"cashflow":50,"asset":30,"health":10,"learning":10}',
      '{"formula":"weighted-capped-ratio-v1","unknown":"bounds","rounding":"HALF_UP","display_decimals":1,"storage_decimals":2}',
      '2026-09-17','2026-09-17T00:00:00.000Z');
    CREATE TABLE scores (
      id TEXT PRIMARY KEY, daily_log_id TEXT NOT NULL REFERENCES daily_logs(id),
      score_version INTEGER NOT NULL CHECK(score_version>0), plan_version INTEGER NOT NULL CHECK(plan_version>=0),
      policy_id TEXT NOT NULL REFERENCES score_policies(id), policy_version INTEGER NOT NULL,
      input_hash TEXT NOT NULL, input_snapshot_json TEXT NOT NULL CHECK(json_valid(input_snapshot_json)),
      calculation_json TEXT NOT NULL CHECK(json_valid(calculation_json)), created_at TEXT NOT NULL,
      UNIQUE(daily_log_id,score_version), UNIQUE(daily_log_id,plan_version,policy_id,input_hash)
    ) STRICT;
    CREATE TRIGGER scores_no_update BEFORE UPDATE ON scores BEGIN SELECT RAISE(ABORT,'Scores are immutable'); END;
    CREATE TRIGGER scores_no_delete BEFORE DELETE ON scores BEGIN SELECT RAISE(ABORT,'Scores are immutable'); END;
    CREATE TRIGGER policies_no_update BEFORE UPDATE ON score_policies BEGIN SELECT RAISE(ABORT,'Policies are immutable'); END;
    CREATE TRIGGER policies_no_delete BEFORE DELETE ON score_policies BEGIN SELECT RAISE(ABORT,'Policies are immutable'); END;
    PRAGMA user_version = 3;
  `);
}

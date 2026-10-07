import type { DatabaseSync } from 'node:sqlite';
import { migrateDayTables } from './migrations-day.ts';
import { migrateScoreTables } from './migrations-score.ts';
import { migrateReportTables } from './migrations-report.ts';
import { migrateRestoreTables } from './migrations-restore.ts';
import { migrateGrowthTables } from './migrations-growth.ts';
import { migrateFortuneTables } from './migrations-fortune.ts';
import { migrateTimerTables } from './migrations-timer.ts';
import { migrateScheduleTables } from './migrations-schedule.ts';

export const SCHEMA_VERSION = 9;

export function migrate(database: DatabaseSync, target = SCHEMA_VERSION, legacyConnection: unknown = null): void {
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const current = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (current > target) throw new Error('数据库版本高于应用版本，请使用较新版本打开。');
  if (current === target) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    // Another local launch may have completed the migration while this connection waited.
    const lockedVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (lockedVersion === target) { database.exec('COMMIT'); return; }
    if (lockedVersion > target) throw new Error('数据库版本高于应用版本，请使用较新版本打开。');
    if (lockedVersion < 1) database.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
        project_type TEXT NOT NULL CHECK(project_type IN ('novel','publication','product','research','foundation')),
        platform TEXT,
        operating_role TEXT NOT NULL CHECK(operating_role IN ('cashflow','growth','future_asset','maintenance')),
        stage TEXT NOT NULL DEFAULT '待确认' CHECK(length(trim(stage)) BETWEEN 1 AND 120),
        status TEXT NOT NULL DEFAULT 'preparing' CHECK(status IN ('preparing','active','paused','completed','archived')),
        primary_metric_key TEXT,
        baseline_value INTEGER CHECK(baseline_value IS NULL OR baseline_value >= 0),
        baseline_at TEXT,
        baseline_source TEXT,
        target_value INTEGER CHECK(target_value IS NULL OR target_value > 0),
        target_date TEXT,
        next_milestone TEXT,
        next_action TEXT,
        daily_budget_minutes INTEGER CHECK(daily_budget_minutes IS NULL OR daily_budget_minutes BETWEEN 0 AND 1440),
        cadence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(cadence_json)),
        notes TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK((baseline_value IS NULL AND baseline_at IS NULL AND baseline_source IS NULL)
          OR (baseline_value IS NOT NULL AND baseline_at IS NOT NULL AND baseline_source IS NOT NULL AND length(trim(baseline_source)) > 0)),
        CHECK(primary_metric_key IS NOT NULL OR (baseline_value IS NULL AND target_value IS NULL))
      ) STRICT;
      CREATE INDEX projects_status_idx ON projects(status);
      CREATE TABLE app_settings (
        id INTEGER PRIMARY KEY CHECK(id=1),
        settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        setup_completed INTEGER NOT NULL DEFAULT 0 CHECK(setup_completed IN (0,1)),
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE request_dedup (
        scope TEXT NOT NULL,
        request_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        response_json TEXT NOT NULL CHECK(json_valid(response_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY(scope,request_id)
      ) STRICT;
      PRAGMA user_version = 1;
    `);
    if (lockedVersion < 2 && target >= 2) migrateDayTables(database);
    if (lockedVersion < 3 && target >= 3) migrateScoreTables(database);
    if (lockedVersion < 4 && target >= 4) migrateReportTables(database);
    if (lockedVersion < 5 && target >= 5) migrateRestoreTables(database);
    if (lockedVersion < 6 && target >= 6) migrateGrowthTables(database, legacyConnection);
    if (lockedVersion < 7 && target >= 7) migrateFortuneTables(database);
    if (lockedVersion < 8 && target >= 8) migrateTimerTables(database);
    if (lockedVersion < 9 && target >= 9) migrateScheduleTables(database);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

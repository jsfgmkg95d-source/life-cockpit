import type { DatabaseSync } from 'node:sqlite';
export function migrateRestoreTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE restore_receipts (
      request_id TEXT PRIMARY KEY NOT NULL, token TEXT NOT NULL UNIQUE,
      backup_id TEXT NOT NULL, preservation_backup_id TEXT NOT NULL,
      source_sha256 TEXT NOT NULL, restored_at TEXT NOT NULL,
      usage_offsets_json TEXT NOT NULL CHECK(json_valid(usage_offsets_json))
    ) STRICT;
    CREATE TRIGGER restore_receipts_frozen BEFORE UPDATE ON restore_receipts BEGIN SELECT RAISE(ABORT,'Restore history is immutable'); END;
    CREATE TRIGGER restore_receipts_no_delete BEFORE DELETE ON restore_receipts BEGIN SELECT RAISE(ABORT,'Restore history is immutable'); END;
    PRAGMA user_version=5;
  `);
}

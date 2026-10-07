import type { DatabaseSync } from 'node:sqlite';

export function migrateFortuneTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE daily_fortune_records (
      business_date TEXT PRIMARY KEY NOT NULL CHECK(length(business_date)=10),
      revision INTEGER NOT NULL CHECK(revision>=1),
      intention TEXT NOT NULL DEFAULT '' CHECK(length(intention)<=500),
      reflection TEXT NOT NULL DEFAULT '' CHECK(length(reflection)<=2000),
      mood TEXT NOT NULL DEFAULT '' CHECK(length(mood)<=32),
      completed_action_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(completed_action_ids_json)),
      updated_at TEXT NOT NULL
    ) STRICT;
    PRAGMA user_version = 7;
  `);
}

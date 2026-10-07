import type { DatabaseSync } from 'node:sqlite';
export function usageOffsets(db: DatabaseSync): Record<string, number> {
  const row = db.prepare('SELECT usage_offsets_json FROM restore_receipts ORDER BY rowid DESC LIMIT 1').get();
  return row ? JSON.parse(String(row.usage_offsets_json)) : {};
}
export function usageCount(db: DatabaseSync, day: string): number {
  return Number(db.prepare('SELECT count(*) AS n FROM ai_calls WHERE day=?').get(day)!.n) + (usageOffsets(db)[day] ?? 0);
}

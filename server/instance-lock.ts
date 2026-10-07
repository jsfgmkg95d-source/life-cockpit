import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function lockInstance(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  // SQLite holds the OS lock for this connection's lifetime. A process crash
  // releases it without PID files, partial publication or stale-lock deletion.
  // This operational file is independent of the business DB and its backups.
  const db = new DatabaseSync(resolve(dataDir, 'service-lock.sqlite'));
  try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
  catch (error) { db.close(); if (String(error).includes('locked')) throw new Error('该账本已有应用服务运行，请使用现有窗口，或先停止该服务。'); throw error; }
  return () => { try { db.exec('ROLLBACK'); } finally { db.close(); } };
}

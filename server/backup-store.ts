import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Store } from './store.ts';
import type { BackupList, BackupManifest } from '../shared/dashboard-contracts.ts';
import { AppError } from './errors.ts';
import { APP_VERSION } from '../shared/version.ts';

const names = ['database.sqlite', 'export.json', 'manifest.json'] as const;
function fingerprint(bytes: Buffer) { return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
export class BackupStore {
  constructor(privateStore: Store, directory: string) { this.store = privateStore; this.directory = resolve(directory); }
  store: Store;
  directory: string;
  private id(id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) throw new AppError(400, 'INVALID_BACKUP_ID', '备份编号无效。');
    return id;
  }
  manifest(id: string): BackupManifest {
    this.id(id);
    try {
      const manifest = JSON.parse(readFileSync(resolve(this.directory, id, 'manifest.json'), 'utf8')) as BackupManifest;
      if (manifest.id !== id || manifest.format !== 'personal-company-backup-v1') throw new Error('Invalid manifest');
      for (const name of names.slice(0, 2) as ('database.sqlite' | 'export.json')[]) {
        const actual = fingerprint(readFileSync(resolve(this.directory, id, name)));
        if (actual.sha256 !== manifest.files[name].sha256 || actual.bytes !== manifest.files[name].bytes) throw new Error('Checksum mismatch');
      }
      return manifest;
    } catch { throw new AppError(409, 'BACKUP_UNAVAILABLE', '备份文件缺失或校验不一致。请保留原文件并重新创建备份。'); }
  }
  list(): BackupList {
    const backups: BackupManifest[] = []; let unreadable = 0;
    if (existsSync(this.directory)) for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try { backups.push(this.manifest(entry.name)); } catch { unreadable++; }
    }
    return { directory: this.directory, backups: backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), unreadable };
  }
  create(id: string): BackupManifest {
    this.id(id);
    if (existsSync(resolve(this.directory, id))) return this.manifest(id);
    if (this.store.database.prepare('SELECT id FROM work_sessions WHERE stopped_at IS NULL').get()) throw new AppError(409, 'TIMER_RUNNING', '请先暂停计时再创建完整备份，避免恢复时把间隔时间计入工作。');
    if (this.store.database.prepare("SELECT id FROM reports WHERE status='running' UNION ALL SELECT id FROM ai_calls WHERE status='running' LIMIT 1").get()) throw new AppError(409, 'BACKUP_BUSY', '报告生成或 AI 连接测试尚未结束，请等待完成后再创建可恢复的完整备份。');
    mkdirSync(this.directory, { recursive: true });
    const pending = resolve(this.directory, `.pending-${randomUUID()}`);
    mkdirSync(pending);
    try {
      // VACUUM INTO includes committed WAL data in one consistent snapshot.
      this.store.database.prepare('VACUUM INTO ?').run(resolve(pending, 'database.sqlite'));
      const db = new DatabaseSync(resolve(pending, 'database.sqlite'), { readOnly: true });
      let schemaVersion: number; const tables: Record<string, unknown[]> = {};
      try {
        if (db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Backup verification failed');
        schemaVersion = Number(db.prepare('PRAGMA user_version').get()!.user_version);
        for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
          const name = String(row.name); tables[name] = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all();
        }
      } finally { db.close(); }
      const createdAt = new Date().toISOString();
      const excluded = ['API 密钥与 data/secrets', '环境变量', '外部链接所指向的稿件与附件', '源码、运行日志、其他备份', '可重建的 Git 对象缓存（采集基线与候选已随数据库备份）'];
      writeFileSync(resolve(pending, 'export.json'), JSON.stringify({ format: 'personal-company-export-v1', schemaVersion, createdAt, excluded, tables }, null, 2));
      const manifest: BackupManifest = { format: 'personal-company-backup-v1', id, createdAt, appVersion: APP_VERSION, schemaVersion,
        files: { 'database.sqlite': fingerprint(readFileSync(resolve(pending, 'database.sqlite'))), 'export.json': fingerprint(readFileSync(resolve(pending, 'export.json'))) },
        rowCounts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])), excluded };
      writeFileSync(resolve(pending, 'manifest.json'), JSON.stringify(manifest, null, 2));
      renameSync(pending, resolve(this.directory, id));
      return manifest;
    } catch (error) {
      // Only the unique temporary directory created by this call is removed.
      rmSync(pending, { recursive: true, force: true }); throw error;
    }
  }
  download(id: string, name: string): { bytes: Buffer; filename: string; type: string } {
    if (!(names as readonly string[]).includes(name)) throw new AppError(404, 'NOT_FOUND', '没有这个备份文件。');
    const manifest = this.manifest(id);
    const bytes = readFileSync(resolve(this.directory, id, name));
    if (name !== 'manifest.json' && fingerprint(bytes).sha256 !== manifest.files[name as 'database.sqlite' | 'export.json'].sha256) throw new AppError(409, 'BACKUP_UNAVAILABLE', '备份文件发生变化，请重新校验。');
    return { bytes, filename: `${id}-${name}`, type: name.endsWith('.json') ? 'application/json' : 'application/vnd.sqlite3' };
  }
}

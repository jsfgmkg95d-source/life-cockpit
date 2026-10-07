import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type { Store } from './store.ts';
import type { BackupStore } from './backup-store.ts';
import type { RestorePreview, RestoreReceipt } from '../shared/restore-contracts.ts';
import { AppError } from './errors.ts';
import { migrate, SCHEMA_VERSION } from './migrations.ts';
import { usageOffsets } from './ai-usage.ts';

type Rows = Record<string, SQLOutputValue>[];
type Snapshot = Record<string, Rows>;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function schema(db: DatabaseSync, businessOnly = false) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().filter(row => !businessOnly || row.tbl_name !== 'restore_receipts');
}
function snapshot(db: DatabaseSync): Snapshot {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => [String(row.name), db.prepare(`SELECT * FROM ${quote(String(row.name))} ORDER BY rowid`).all()]));
}
/** Only preview freshness ignores successful checks with otherwise identical connector facts.
 * Source validation, backup contents and restored rows always use the full snapshot. */
function previewHash(data: Snapshot): string {
  return digest(Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, name !== 'connector_states' ? rows : rows.map(row => {
    if (row.id !== 'wedding') return row;
    const state = JSON.parse(String(row.state_json));
    if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.checked_at !== 'string' || !Number.isFinite(Date.parse(state.checked_at)) || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) return row;
    return { ...row, state_json: JSON.stringify({ ...state, checked_at: null }), updated_at: null };
  })])));
}
function counts(data: Snapshot): Record<string, number> { return Object.fromEntries(Object.entries(data).filter(([name]) => name !== 'restore_receipts').map(([name, rows]) => [name, rows.length])); }
function check(db: DatabaseSync) {
  if (db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new AppError(409, 'RESTORE_INVALID', '备份未通过完整性或关联检查，不能恢复。');
}
function receipt(row: Record<string, SQLOutputValue>): RestoreReceipt {
  return { requestId: String(row.request_id), backupId: String(row.backup_id), preservationBackupId: String(row.preservation_backup_id), sourceSha256: String(row.source_sha256), restoredAt: String(row.restored_at) };
}
interface Candidate { preview: RestorePreview; data: Snapshot; sourceHash: string }
export class RestoreStore {
  store: Store; backups: BackupStore; busy: () => boolean;
  candidates = new Map<string, Candidate>();
  /** Used only by isolated fault/crash tests; never selected through HTTP input. */
  beforeCommit?: () => void;
  constructor(store: Store, backups: BackupStore, busy: () => boolean) { this.store = store; this.backups = backups; this.busy = busy; }
  private available() {
    if (this.busy() || this.store.database.prepare("SELECT id FROM reports WHERE status='running' UNION ALL SELECT id FROM ai_calls WHERE status='running' LIMIT 1").get()) throw new AppError(409, 'RESTORE_BUSY', 'AI 生成、连接测试、后台采集或设置保存尚未结束，请等待完成后再恢复。');
  }
  private readCandidate(id: string) {
    const manifest = this.backups.manifest(id);
    if (![4, 5, 6, 7, 8, SCHEMA_VERSION].includes(manifest.schemaVersion)) throw new AppError(409, 'RESTORE_VERSION', '该备份的数据版本不受当前应用支持，请使用对应版本。');
    const source = this.backups.download(id, 'database.sqlite').bytes;
    const sourceHash = createHash('sha256').update(source).digest('hex');
    if (sourceHash !== manifest.files['database.sqlite'].sha256) throw new AppError(409, 'BACKUP_CHANGED', '备份文件发生变化，请重新核对。');
    const root = resolve(this.backups.directory, '.restore-work'); mkdirSync(root, { recursive: true });
    const temp = mkdtempSync(resolve(root, 'candidate-'));
    try {
      const path = resolve(temp, 'candidate.sqlite'); writeFileSync(path, source);
      const db = new DatabaseSync(path);
      try {
        const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
        if (version !== manifest.schemaVersion) throw new AppError(409, 'RESTORE_SCHEMA', '备份版本不一致。');
        const expected = new DatabaseSync(':memory:');
        try { migrate(expected, version); if (digest(schema(db)) !== digest(schema(expected))) throw new AppError(409, 'RESTORE_SCHEMA', '备份结构与此应用不兼容，未修改当前账本。'); }
        finally { expected.close(); }
        check(db);
        const original = snapshot(db);
        if (original.work_sessions?.some(row => row.stopped_at === null)) throw new AppError(409, 'RESTORE_RUNNING_TIMER', '此备份包含未暂停的计时，请使用暂停计时后创建的备份。');
        const exported = JSON.parse(this.backups.download(id, 'export.json').bytes.toString('utf8'));
        if (exported.format !== 'personal-company-export-v1' || digest(original) !== digest(exported.tables) || digest(Object.fromEntries(Object.entries(original).map(([name, rows]) => [name, rows.length]))) !== digest(manifest.rowCounts)) throw new AppError(409, 'RESTORE_EXPORT_MISMATCH', '备份清单、数据库与 JSON 内容不一致，请更换完整备份。');
        if (original.reports.some(row => row.status === 'running') || original.ai_calls.some(row => row.status === 'running')) throw new AppError(409, 'RESTORE_RUNNING_SOURCE', '这份备份含未结束的 AI 请求，不能恢复。请选择生成结束后创建的完整备份。');
        if (original.app_settings.length !== 1 || original.ai_settings.length !== 1 || original.score_policies.length < 1) throw new AppError(409, 'RESTORE_INVALID', '备份缺少必要的设置或评分规则。');
        // Known schema is checked before migrations; never execute source-provided DDL.
        migrate(db); check(db);
        return { manifest, data: snapshot(db), sourceHash };
      } finally { db.close(); }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  preview(id: string): RestorePreview {
    this.available();
    for (const [token, candidate] of this.candidates) if (candidate.preview.expiresAt <= new Date().toISOString()) this.candidates.delete(token);
    if (this.candidates.size >= 20) this.candidates.delete(this.candidates.keys().next().value!);
    const source = this.readCandidate(id);
    const current = this.store.transaction(() => snapshot(this.store.database));
    const preview: RestorePreview = { token: randomUUID(), backup: source.manifest, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), currentCounts: counts(current), incomingCounts: counts(source.data), currentHash: previewHash(current),
      warnings: ['将整体替换项目、基础与 AI 设置、每日计划、成果、评分、报告及历史版本；备份之后的改动将从当前账本移出。', '确认后先自动创建当前账本备份；密钥文件、外部稿件和已有备份不变。', '恢复审计历史继续保留；已消耗的 AI 调用额度不随恢复减少。', '恢复后请刷新所有已打开页面。此核对在五分钟后或账本变化后失效。'] };
    if (source.manifest.schemaVersion < 6) preview.warnings.push('旧备份不含采集基线与待核对候选；恢复后连接为空，需要重新连接。原采集状态保留在自动创建的保护备份里。');
    else preview.warnings.push('采集配置、基线、候选、章节身份及计时记录随账本一起恢复；Git缓存可重新获取。');
    if (source.manifest.schemaVersion < 7) preview.warnings.push('旧备份没有每日行运记录；恢复后该记录为空。当前记录会保存在恢复前自动创建的保护备份中。');
    else preview.warnings.push('每日行运中的意向、心情、练习及回顾随本地账本一起恢复。');
    if (source.manifest.schemaVersion < 8) preview.warnings.push('旧备份没有钟表时间点；恢复后时间点为空。当前时间点保存在恢复前自动创建的保护备份中。');
    else preview.warnings.push('钟表时间点（含撤销记录）和精确时间段随本地账本一起恢复。');
    if (source.manifest.schemaVersion < 9) preview.warnings.push('旧备份没有收件箱、时间安排和任务专注关联；恢复后这些记录为空，当前记录保存在恢复前自动创建的保护备份中。');
    else preview.warnings.push('收件箱、时间安排和任务专注关联随本地账本一起恢复。');
    this.candidates.set(preview.token, { preview, data: source.data, sourceHash: source.sourceHash }); return preview;
  }
  get(requestId: string): RestoreReceipt {
    const row = this.store.database.prepare('SELECT * FROM restore_receipts WHERE request_id=?').get(requestId);
    if (!row) throw new AppError(404, 'RESTORE_NOT_FOUND', '尚无该次恢复的成功记录，可重新核对后再操作。');
    return receipt(row);
  }
  restore(requestId: string, token: string, confirmation: string): RestoreReceipt {
    if (confirmation !== '恢复本地账本') throw new AppError(400, 'RESTORE_CONFIRMATION', '请核对覆盖范围并输入“恢复本地账本”。');
    const previous = this.store.database.prepare('SELECT * FROM restore_receipts WHERE request_id=?').get(requestId);
    if (previous) { if (previous.token !== token) throw new AppError(409, 'RESTORE_REQUEST_CONFLICT', '恢复编号已用于其他核对，请刷新页面。'); return receipt(previous); }
    this.available();
    const candidate = this.candidates.get(token);
    if (!candidate || candidate.preview.expiresAt <= new Date().toISOString()) throw new AppError(409, 'RESTORE_PREVIEW_EXPIRED', '核对已过期或服务已重启，请重新选择备份核对。');
    const source = this.backups.manifest(candidate.preview.backup.id);
    if (source.files['database.sqlite'].sha256 !== candidate.sourceHash || digest(source) !== digest(candidate.preview.backup)) throw new AppError(409, 'BACKUP_CHANGED', '备份在核对后发生变化，请重新核对。');
    const db = this.store.database;
    if (previewHash(snapshot(db)) !== candidate.preview.currentHash) throw new AppError(409, 'RESTORE_STATE_CHANGED', '账本在核对后发生变化，请重新核对，避免覆盖新记录。');
    const preservation = this.backups.create(randomUUID());
    const saved = new DatabaseSync(resolve(this.backups.directory, preservation.id, 'database.sqlite'), { readOnly: true });
    let savedHash: string; let savedFullHash: string; try { const protectedRows = snapshot(saved); savedHash = previewHash(protectedRows); savedFullHash = digest(protectedRows); } finally { saved.close(); }
    const restoredAt = new Date().toISOString();
    db.exec('PRAGMA foreign_keys=OFF');
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = snapshot(db);
        if (previewHash(current) !== candidate.preview.currentHash || savedHash !== candidate.preview.currentHash || digest(current) !== savedFullHash) throw new AppError(409, 'RESTORE_STATE_CHANGED', '创建保护备份时账本发生变化，请重新核对。');
        const offsets = usageOffsets(db); const spent: Record<string, number> = { ...offsets }; const incoming: Record<string, number> = {};
        for (const row of current.ai_calls) spent[String(row.day)] = (spent[String(row.day)] ?? 0) + 1;
        for (const row of candidate.data.ai_calls) incoming[String(row.day)] = (incoming[String(row.day)] ?? 0) + 1;
        const sourceOffsets: Record<string, number> = candidate.data.restore_receipts.length ? JSON.parse(String(candidate.data.restore_receipts.at(-1)!.usage_offsets_json)) : {};
        const retained = Object.fromEntries([...new Set([...Object.keys(spent), ...Object.keys(sourceOffsets)])].map(day => [day, Math.max(sourceOffsets[day] ?? 0, (spent[day] ?? 0) - (incoming[day] ?? 0), 0)]).filter(([, n]) => Number(n) > 0));
        const triggers = schema(db, true).filter(row => row.type === 'trigger');
        for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(String(trigger.name))}`);
        for (const name of Object.keys(candidate.data).filter(name => name !== 'restore_receipts')) db.exec(`DELETE FROM ${quote(name)}`);
        for (const [name, rows] of Object.entries(candidate.data)) {
          if (name === 'restore_receipts' || !rows.length) continue;
          const columns = Object.keys(rows[0]); const insert = db.prepare(`INSERT INTO ${quote(name)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
          for (const row of rows) insert.run(...columns.map(column => row[column]));
        }
        for (const trigger of triggers) db.exec(String(trigger.sql));
        check(db);
        const restored = snapshot(db);
        for (const name of Object.keys(candidate.data).filter(name => name !== 'restore_receipts')) if (digest(restored[name]) !== digest(candidate.data[name])) throw new Error('Restored rows differ');
        db.prepare('INSERT INTO restore_receipts(request_id,token,backup_id,preservation_backup_id,source_sha256,restored_at,usage_offsets_json) VALUES(?,?,?,?,?,?,?)').run(requestId, token, source.id, preservation.id, candidate.sourceHash, restoredAt, JSON.stringify(retained));
        this.beforeCommit?.();
        db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back after an I/O error. */ } throw error; }
    } finally { db.exec('PRAGMA foreign_keys=ON'); }
    this.candidates.clear(); return this.get(requestId);
  }
}

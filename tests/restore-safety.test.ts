import { setupTestWorkspace } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Store } from '../server/store.ts';
import { BackupStore } from '../server/backup-store.ts';
import { RestoreStore } from '../server/restore-store.ts';
import { DayStore } from '../server/day-store.ts';
import { FortuneStore } from '../server/fortune-store.ts';
import { usageCount } from '../server/ai-usage.ts';
import { AppError } from '../server/errors.ts';
import { SCHEMA_VERSION } from '../server/migrations.ts';
import type { BackupManifest } from '../shared/dashboard-contracts.ts';

const projectRoot = resolve(import.meta.dirname, '..');
const root = resolve(projectRoot, '.runtime/tests');
const date = '2026-09-19';
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

function rows(db: DatabaseSync, includeReceipts = true) {
  const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name));
  return Object.fromEntries(names.filter(name => includeReceipts || name !== 'restore_receipts').map(name => [name, db.prepare(`SELECT * FROM ${quote(name)} ORDER BY rowid`).all()]));
}
function schema(db: DatabaseSync) { return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(); }
function healthy(db: DatabaseSync) {
  assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION);
}
function failure(code: string) { return (error: unknown) => error instanceof AppError && error.status === 409 && error.code === code; }

function fixture() {
  mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(resolve(root, 'restore-safety-'));
  const dataDir = resolve(folder, 'data');
  const store = new Store(dataDir);
  const initial = setupTestWorkspace(store, randomUUID(), 'Asia/Shanghai', 135);
  const days = new DayStore(store);
  days.event(date, { requestId: randomUUID(), revision: 0, event: { project_id: initial.projects[0].id, task_id: null, artifact_key: 'isolated-safety-fixture', metric_key: 'accepted_words', value: 1000, stage: 'finalized', summary: '隔离故障演练', source: '测试生成' } });
  const backups = new BackupStore(store, resolve(folder, 'backups'));
  const restores = new RestoreStore(store, backups, () => false);
  return {
    folder, dataDir, store, backups, restores,
    edit(note: string) { const { id, revision, created_at: _created, updated_at: _updated, ...project } = store.getState().projects[0]; store.updateProject(id, revision, { ...project, notes: note }); },
    backupFile: (id: string, name = 'database.sqlite') => resolve(backups.directory, id, name),
    close() { store.close(); assert.equal(dirname(folder), root); rmSync(folder, { recursive: true, force: true }); },
  };
}

/** Rewrite a complete isolated bundle after an intentional fixture mutation. */
function rewriteBundle(backups: BackupStore, id: string, mutate: (db: DatabaseSync) => void) {
  const folder = resolve(backups.directory, id);
  const path = resolve(folder, 'database.sqlite');
  const manifest = JSON.parse(readFileSync(resolve(folder, 'manifest.json'), 'utf8')) as BackupManifest;
  const exported = JSON.parse(readFileSync(resolve(folder, 'export.json'), 'utf8'));
  const db = new DatabaseSync(path);
  try {
    mutate(db);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    manifest.schemaVersion = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    exported.schemaVersion = manifest.schemaVersion;
    exported.tables = rows(db);
    manifest.rowCounts = Object.fromEntries(Object.entries(exported.tables).map(([name, data]) => [name, (data as unknown[]).length]));
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  if (manifest.schemaVersion === 4) manifest.appVersion = '0.6.0';
  writeFileSync(resolve(folder, 'export.json'), JSON.stringify(exported, null, 2));
  for (const name of ['database.sqlite', 'export.json'] as const) {
    const bytes = readFileSync(resolve(folder, name));
    manifest.files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  writeFileSync(resolve(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

function addCall(db: DatabaseSync, status = 'succeeded') {
  const id = randomUUID();
  db.prepare('INSERT INTO ai_calls(id,day,report_id,status,input_tokens,output_tokens,created_at) VALUES(?,?,NULL,?,?,?,?)').run(id, date, status, 10, 5, new Date().toISOString());
  return id;
}

test('恢复提交前异常整体回滚业务、触发器与审计回执，连接重新启用外键', () => {
  const f = fixture();
  try {
    const backup = f.backups.create(randomUUID());
    f.edit('隔离演练：当前有效记录必须在失败后保留');
    const before = rows(f.store.database); const originalSchema = schema(f.store.database);
    const preview = f.restores.preview(backup.id); const requestId = randomUUID();
    f.restores.beforeCommit = () => {
      assert.equal(f.store.getState().projects[0].notes, '', '故障应在替换数据以后发生');
      assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM restore_receipts').get()!.n, 1);
      throw new Error('ISOLATED_PRE_COMMIT_FAILURE');
    };
    assert.throws(() => f.restores.restore(requestId, preview.token, '恢复本地账本'), /ISOLATED_PRE_COMMIT_FAILURE/u);
    assert.deepEqual(rows(f.store.database), before);
    assert.deepEqual(schema(f.store.database), originalSchema);
    healthy(f.store.database);
    assert.throws(() => f.store.database.exec('DELETE FROM asset_events'), /immutable/u);
    assert.throws(() => f.restores.get(requestId), (error: unknown) => error instanceof AppError && error.status === 404);
    const preservation = f.backups.list().backups.find(item => item.id !== backup.id)!;
    assert.ok(preservation);
    const protectedDb = new DatabaseSync(f.backupFile(preservation.id), { readOnly: true });
    try { assert.deepEqual(rows(protectedDb), before); } finally { protectedDb.close(); }
  } finally { f.close(); }
});

test('真实子进程在替换后提交前被终止，重新打开仍是完整旧账本且无成功回执', { timeout: 20_000 }, () => {
  const f = fixture();
  try {
    const backup = f.backups.create(randomUUID());
    f.edit('隔离演练：崩溃前已提交记录');
    const before = rows(f.store.database); const originalSchema = schema(f.store.database);
    const marker = resolve(f.folder, 'crash-hook-reached.json');
    const requestId = randomUUID();
    f.store.close();
    const moduleUrl = (file: string) => pathToFileURL(resolve(projectRoot, 'server', file)).href;
    const code = `
      import { writeFileSync } from 'node:fs';
      import { Store } from ${JSON.stringify(moduleUrl('store.ts'))};
      import { BackupStore } from ${JSON.stringify(moduleUrl('backup-store.ts'))};
      import { RestoreStore } from ${JSON.stringify(moduleUrl('restore-store.ts'))};
      const store = new Store(${JSON.stringify(f.dataDir)});
      const backups = new BackupStore(store, ${JSON.stringify(f.backups.directory)});
      const restores = new RestoreStore(store, backups, () => false);
      const preview = restores.preview(${JSON.stringify(backup.id)});
      restores.beforeCommit = () => {
        writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ notes: store.getState().projects[0].notes, receiptCount: store.database.prepare('SELECT count(*) AS n FROM restore_receipts').get().n }));
        process.kill(process.pid, 'SIGKILL');
        process.exit(92);
      };
      restores.restore(${JSON.stringify(requestId)}, preview.token, '恢复本地账本');
      process.exit(93);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', code], { cwd: projectRoot, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    assert.equal(child.error, undefined, child.stderr);
    assert.notEqual(child.status, 0, child.stderr);
    assert.notEqual(child.status, 93, '故障注入必须发生在提交之前');
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { notes: '', receiptCount: 1 });
    const reopened = new Store(f.dataDir);
    try {
      assert.deepEqual(rows(reopened.database), before);
      assert.deepEqual(schema(reopened.database), originalSchema);
      healthy(reopened.database);
      assert.throws(() => reopened.database.exec('DELETE FROM asset_events'), /immutable/u);
      assert.equal(reopened.database.prepare('SELECT count(*) AS n FROM restore_receipts').get()!.n, 0);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('第六天 schema 4 一致性备份可迁移恢复，当前 schema 5 和历史保护触发器保留', () => {
  const f = fixture();
  try {
    const expected = rows(f.store.database, false); const expectedSchema = schema(f.store.database);
    const backup = f.backups.create(randomUUID());
    const old = rewriteBundle(f.backups, backup.id, db => {
      db.exec('DROP TABLE work_session_context; DROP TABLE day_schedule; DROP TABLE inbox_items; DROP TABLE timer_points; DROP TABLE daily_fortune_records; DROP TABLE task_pins; DROP TABLE work_sessions; DROP TABLE asset_evidence; DROP TABLE asset_chapters; DROP TABLE connector_states; DROP TRIGGER restore_receipts_frozen; DROP TRIGGER restore_receipts_no_delete; DROP TABLE restore_receipts; PRAGMA user_version=4;');
    });
    assert.equal(old.schemaVersion, 4);
    assert.equal(Object.keys(old.rowCounts).length, 12);
    f.edit('隔离演练：恢复前新记录');
    const preview = f.restores.preview(backup.id);
    assert.equal(preview.backup.schemaVersion, 4);
    const receipt = f.restores.restore(randomUUID(), preview.token, '恢复本地账本');
    assert.equal(receipt.sourceSha256, old.files['database.sqlite'].sha256);
    assert.deepEqual(rows(f.store.database, false), expected);
    assert.deepEqual(schema(f.store.database), expectedSchema);
    healthy(f.store.database);
    assert.throws(() => f.store.database.exec('DELETE FROM restore_receipts'), /immutable/u);
  } finally { f.close(); }
});

test('schema 6 旧备份升级为空行运记录，恢复前记录留在保护备份', () => {
  const f = fixture();
  try {
    const backup = f.backups.create(randomUUID());
    const old = rewriteBundle(f.backups, backup.id, db => {
      db.exec('DROP TABLE work_session_context; DROP TABLE day_schedule; DROP TABLE inbox_items; DROP TABLE timer_points; DROP TABLE daily_fortune_records; PRAGMA user_version=6;');
    });
    assert.equal(old.schemaVersion, 6);
    const fortune = new FortuneStore(f.store);
    fortune.put(date, { revision: 0, intention: '恢复前的真实记录', reflection: '', mood: '', completedActionIds: ['practice-a'] });
    const preview = f.restores.preview(old.id);
    assert.ok(preview.warnings.some(warning => warning.includes('旧备份没有每日行运记录')));
    const receipt = f.restores.restore(randomUUID(), preview.token, '恢复本地账本');
    assert.equal(fortune.get(date).revision, 0);
    const protectedDb = new DatabaseSync(f.backupFile(receipt.preservationBackupId), { readOnly: true });
    try {
      assert.equal(protectedDb.prepare('SELECT intention FROM daily_fortune_records WHERE business_date=?').get(date)!.intention, '恢复前的真实记录');
    } finally { protectedDb.close(); }
    healthy(f.store.database);
  } finally { f.close(); }
});

test('文件校验正确仍拒绝不兼容结构或含未结束请求的来源，当前账本不变', () => {
  const f = fixture();
  try {
    const malformed = f.backups.create(randomUUID());
    rewriteBundle(f.backups, malformed.id, db => db.exec('DROP INDEX projects_status_idx'));
    const before = rows(f.store.database); const originalSchema = schema(f.store.database);
    assert.throws(() => f.restores.preview(malformed.id), failure('RESTORE_SCHEMA'));
    assert.deepEqual(rows(f.store.database), before);
    assert.deepEqual(schema(f.store.database), originalSchema);
    const running = f.backups.create(randomUUID());
    // Simulate a legacy/externally supplied unsafe bundle; new backups reject running calls.
    rewriteBundle(f.backups, running.id, db => { addCall(db, 'running'); });
    const afterCall = rows(f.store.database);
    assert.throws(() => f.restores.preview(running.id), failure('RESTORE_RUNNING_SOURCE'));
    assert.deepEqual(rows(f.store.database), afterCall);
    healthy(f.store.database);
  } finally { f.close(); }
});

test('恢复不能减少已消耗 AI 额度；恢复后新调用及带额度补偿的备份在新账本仍计数', () => {
  const f = fixture();
  try {
    const empty = f.backups.create(randomUUID());
    assert.equal(usageCount(f.store.database, date), 0);
    addCall(f.store.database); addCall(f.store.database);
    assert.equal(usageCount(f.store.database, date), 2);
    let preview = f.restores.preview(empty.id);
    f.restores.restore(randomUUID(), preview.token, '恢复本地账本');
    assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM ai_calls').get()!.n, 0);
    assert.equal(usageCount(f.store.database, date), 2);
    addCall(f.store.database);
    assert.equal(usageCount(f.store.database, date), 3);
    preview = f.restores.preview(empty.id);
    f.restores.restore(randomUUID(), preview.token, '恢复本地账本');
    assert.equal(usageCount(f.store.database, date), 3);
    const compensated = f.backups.create(randomUUID());
    const fresh = new Store(resolve(f.folder, 'fresh-data'));
    try {
      const freshBackups = new BackupStore(fresh, f.backups.directory);
      const freshRestores = new RestoreStore(fresh, freshBackups, () => false);
      assert.equal(usageCount(fresh.database, date), 0);
      const imported = freshRestores.preview(compensated.id);
      freshRestores.restore(randomUUID(), imported.token, '恢复本地账本');
      assert.equal(usageCount(fresh.database, date), 3);
      assert.equal(usageCount(fresh.database, '2026-09-20'), 0);
      addCall(fresh.database);
      assert.equal(usageCount(fresh.database, date), 4);
      const repeated = freshRestores.preview(empty.id);
      freshRestores.restore(randomUUID(), repeated.token, '恢复本地账本');
      assert.equal(usageCount(fresh.database, date), 4);
      healthy(fresh.database);
    } finally { fresh.close(); }
  } finally { f.close(); }
});

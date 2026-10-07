import { setupTestWorkspace } from './fixtures/workspace.ts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../server/store.ts';
import { DayStore } from '../server/day-store.ts';
import { ReportStore } from '../server/report-store.ts';
import { BackupStore } from '../server/backup-store.ts';
import { RestoreStore } from '../server/restore-store.ts';
import { GitHubStore } from '../server/github-store.ts';
import { AppError } from '../server/errors.ts';

const root = resolve(import.meta.dirname, '..', '.runtime', 'tests');
const rejected = (code: string) => (error: unknown) => error instanceof AppError && error.status === 409 && error.code === code;
function fixture() {
  mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(resolve(root, 'backup-recovery-checks-'));
  const store = new Store(resolve(folder, 'data')); const initial = setupTestWorkspace(store, randomUUID(), 'Asia/Shanghai', 135);
  const days = new DayStore(store); const backups = new BackupStore(store, resolve(folder, 'backups')); const restores = new RestoreStore(store, backups, () => false);
  const github = new GitHubStore(days, resolve(folder, 'data'), async () => ({ head: 'a'.repeat(40), paths: ['正文/第001章.md'] }));
  const connection = () => store.database.prepare("SELECT * FROM connector_states WHERE id='wedding'").get()!;
  function setConnection(state: unknown, updatedAt = '2000-01-01T00:00:00.000Z') { store.database.prepare("UPDATE connector_states SET state_json=?,updated_at=? WHERE id='wedding'").run(JSON.stringify(state), updatedAt); }
  return { folder, store, backups, restores, github, connection, setConnection,
    async connect() { await github.scan(initial.projects.find(p => p.name === '示例长篇甲')!.id); const state = JSON.parse(String(connection().state_json)); setConnection({ ...state, checked_at: '2000-01-01T00:00:00.000Z' }); },
    close() { store.close(); assert.equal(dirname(folder), root); rmSync(folder, { recursive: true, force: true }); },
  };
}

test('报告运行时不创建不可恢复备份，已有备份请求保持幂等，完成后可备份并恢复', async () => {
  const f = fixture(); const reports = new ReportStore(f.store, { has: () => false, read: async () => null, save: async () => {} });
  try {
    const before = f.backups.create(randomUUID());
    const view = reports.getView('2026-09-20', 'review');
    reports.generate('2026-09-20', 'review', { requestId: randomUUID(), revision: view.revision, input_hash: view.input_hash, force: false });
    const blockedId = randomUUID();
    assert.throws(() => f.backups.create(blockedId), rejected('BACKUP_BUSY'));
    assert.equal(existsSync(resolve(f.backups.directory, blockedId)), false);
    assert.deepEqual(f.backups.create(before.id), before);
    await Promise.all([...reports.jobs.values()].map(job => job.done));
    const complete = f.backups.create(randomUUID()); const preview = f.restores.preview(complete.id);
    assert.equal(f.restores.restore(randomUUID(), preview.token, '恢复本地账本').backupId, complete.id);
  } finally { await reports.close(); f.close(); }
});

test('独立 AI 连接测试运行时也阻止新备份，已结束调用不会阻止', () => {
  const f = fixture();
  try {
    const call = randomUUID();
    f.store.database.prepare('INSERT INTO ai_calls(id,day,report_id,status,created_at) VALUES(?,?,NULL,?,?)').run(call, '2026-09-20', 'running', new Date().toISOString());
    assert.throws(() => f.backups.create(randomUUID()), rejected('BACKUP_BUSY'));
    assert.equal(existsSync(f.backups.directory), false);
    f.store.database.prepare('UPDATE ai_calls SET status=? WHERE id=?').run('succeeded', call);
    assert.ok(f.restores.preview(f.backups.create(randomUUID()).id).token);
  } finally { f.close(); }
});

test('无新事实的 GitHub 检查不使恢复核对失效，保护备份与恢复仍保留完整时间字段', async () => {
  const f = fixture();
  try {
    await f.connect(); const original = f.connection(); const backup = f.backups.create(randomUUID()); const preview = f.restores.preview(backup.id);
    await f.github.scan(); const latest = f.connection();
    assert.notEqual(latest.state_json, original.state_json); assert.notEqual(latest.updated_at, original.updated_at);
    const receipt = f.restores.restore(randomUUID(), preview.token, '恢复本地账本');
    assert.deepEqual(f.connection(), original, '恢复后的全部字段精确回到源备份，包括检查时间');
    const protectedDb = new DatabaseSync(resolve(f.backups.directory, receipt.preservationBackupId, 'database.sqlite'), { readOnly: true });
    try { assert.deepEqual(protectedDb.prepare("SELECT * FROM connector_states WHERE id='wedding'").get(), latest, '保护备份精确保留恢复前最后检查时间'); }
    finally { protectedDb.close(); }
  } finally { f.close(); }
});

test('连接器的远端版本、章节、候选、归属、基线及其他业务改动仍使恢复核对失效', async t => {
  const changes: [string, (state: any) => void][] = [
    ['head', state => { state.head = 'b'.repeat(40); }],
    ['known', state => { state.known.push(2); }],
    ['candidates', state => { state.candidates.push({ chapter: 2, path: '正文/第002章.md' }); }],
    ['project_id', state => { state.project_id = randomUUID(); }],
    ['baseline_at', state => { state.baseline_at = '2001-01-01T00:00:00.000Z'; }],
    ['invalid_checked_at', state => { state.checked_at = null; }],
  ];
  for (const [name, change] of changes) await t.test(name, async () => {
    const f = fixture();
    try {
      await f.connect(); const backup = f.backups.create(randomUUID()); const preview = f.restores.preview(backup.id);
      const state = JSON.parse(String(f.connection().state_json)); change(state); f.setConnection(state);
      assert.throws(() => f.restores.restore(randomUUID(), preview.token, '恢复本地账本'), rejected('RESTORE_STATE_CHANGED'));
    } finally { f.close(); }
  });
  await t.test('project_notes', async () => {
    const f = fixture();
    try {
      await f.connect(); const preview = f.restores.preview(f.backups.create(randomUUID()).id);
      const { id, revision, created_at: _created, updated_at: _updated, ...project } = f.store.getState().projects[0];
      f.store.updateProject(id, revision, { ...project, notes: '预览后新记录必须保留' });
      assert.throws(() => f.restores.restore(randomUUID(), preview.token, '恢复本地账本'), rejected('RESTORE_STATE_CHANGED'));
    } finally { f.close(); }
  });
});

test('源备份数据库与 JSON 的检查时间不一致仍拒绝，不能套用预览归一化', async () => {
  const f = fixture();
  try {
    await f.connect(); const backup = f.backups.create(randomUUID()); const folder = resolve(f.backups.directory, backup.id);
    const exported = JSON.parse(readFileSync(resolve(folder, 'export.json'), 'utf8'));
    exported.tables.connector_states[0].updated_at = '2001-01-01T00:00:00.000Z';
    const bytes = Buffer.from(JSON.stringify(exported)); writeFileSync(resolve(folder, 'export.json'), bytes);
    backup.files['export.json'] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    writeFileSync(resolve(folder, 'manifest.json'), JSON.stringify(backup));
    assert.throws(() => f.restores.preview(backup.id), rejected('RESTORE_EXPORT_MISMATCH'));
  } finally { f.close(); }
});

test('保护备份创建后即使只有检查时间发生变化，也不能覆盖未进入保护备份的现场', async () => {
  const f = fixture();
  try {
    await f.connect(); const backup = f.backups.create(randomUUID()); const preview = f.restores.preview(backup.id);
    const create = f.backups.create.bind(f.backups);
    f.backups.create = id => {
      const result = create(id); const state = JSON.parse(String(f.connection().state_json));
      f.setConnection({ ...state, checked_at: '2001-01-01T00:00:00.000Z' }, '2001-01-01T00:00:00.000Z'); return result;
    };
    assert.throws(() => f.restores.restore(randomUUID(), preview.token, '恢复本地账本'), rejected('RESTORE_STATE_CHANGED'));
    assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM restore_receipts').get()!.n, 0);
    assert.equal(JSON.parse(String(f.connection().state_json)).checked_at, '2001-01-01T00:00:00.000Z');
  } finally { f.close(); }
});

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, request, errorMessage } from './api';
import type { BackupList, BackupManifest } from '../shared/dashboard-contracts';
import { RESTORE_CONFIRMATION, type RestorePreview, type RestoreReceipt, type RestoreRequest } from '../shared/restore-contracts';
import './dashboard-styles.css';

const PENDING_KEY = 'personal-company-pending-restore-v1';
type PendingRestore = RestoreRequest & { backupId: string };
function pendingRestore(): PendingRestore | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null') as PendingRestore | null;
    return value && typeof value.requestId === 'string' && typeof value.token === 'string' && typeof value.backupId === 'string' && value.confirmation === RESTORE_CONFIRMATION ? value : null;
  } catch { return null; }
}
export function hasPendingRestore(): boolean { return pendingRestore() !== null; }
const TABLE_NAMES: Record<string, string> = { connector_states: '采集配置、基线与待核对候选', asset_chapters: '章节身份', asset_evidence: '成果来源证据', work_sessions: '计时记录', task_pins: '任务置顶', projects: '项目', app_settings: '工作节奏与共享预算', daily_logs: '每日记录及计划版本', tasks: '任务与验收结果', asset_events: '成果及更正历史', score_policies: '评分规则', scores: '评分版本', ai_settings: 'AI 服务设置（不含密钥）', reports: '经营报告', report_adoptions: '建议采纳记录', ai_calls: 'AI 调用记录', request_dedup: '保存防重复记录', restore_receipts: '恢复操作回执（继续保留）' };

export default function BackupSettings({ settingsUnsaved, onDirty, onRestored }: { settingsUnsaved: boolean; onDirty: (value: boolean) => void; onRestored: (receipt: RestoreReceipt) => void }) {
  const [view, setView] = useState<BackupList | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [pending, setPending] = useState<PendingRestore | null>(pendingRestore);
  const [checked, setChecked] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [restoreError, setRestoreError] = useState<unknown>(null);
  const [restoreNotice, setRestoreNotice] = useState('');
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [receiptMissing, setReceiptMissing] = useState(false);
  const key = useRef<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dirty = busy || restoreBusy || !!preview || !!pending;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, [dirty]);
  useEffect(() => { if ((preview || pending) && dialog.current && !dialog.current.open) dialog.current.showModal(); }, [preview, pending]);
  async function load() { setError(null); try { setView(await request<BackupList>('/api/backups')); } catch (failure) { setError(failure); } }
  useEffect(() => { void load(); }, []);
  async function create() {
    if (busy || restoreBusy || pending) return;
    setBusy(true); setError(null); key.current ??= crypto.randomUUID();
    try { await request<BackupManifest>('/api/backups', 'POST', { requestId: key.current }); key.current = null; setNotice('备份已创建，完整性与文件校验通过。'); await load(); } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  async function openPreview(backupId: string) {
    if (busy || settingsUnsaved || pending) return;
    setBusy(true); setError(null); setRestoreError(null); setRestoreNotice(''); setChecked(false); setConfirmation('');
    try { setPreview(await request<RestorePreview>('/api/restores/preview', 'POST', { backupId })); } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  function closePreview() {
    if (restoreBusy || pending) return;
    dialog.current?.close(); setPreview(null); setChecked(false); setConfirmation(''); setRestoreError(null); setRestoreNotice('');
  }
  function completed(receipt: RestoreReceipt) { sessionStorage.removeItem(PENDING_KEY); onRestored(receipt); }
  async function receiptFor(operation: PendingRestore): Promise<RestoreReceipt | null> {
    try { return await request<RestoreReceipt>(`/api/restores/${encodeURIComponent(operation.requestId)}`); }
    catch (failure) { if (failure instanceof ApiError && failure.status === 404) return null; throw failure; }
  }
  async function checkReceipt(operation: PendingRestore) {
    setRestoreBusy(true); setReceiptMissing(false); setRestoreNotice('');
    try { const receipt = await receiptFor(operation); if (receipt) completed(receipt); else { setReceiptMissing(true); setRestoreNotice('本地服务已确认没有这次恢复的成功回执。可以使用原请求重试，或取消这次未完成的恢复后重新核对。'); } }
    catch (failure) { setRestoreError(failure); }
    finally { setRestoreBusy(false); }
  }
  useEffect(() => { const operation = pendingRestore(); if (operation) void checkReceipt(operation); }, []);
  async function execute(operation: PendingRestore) {
    if (restoreBusy) return;
    setRestoreBusy(true); setReceiptMissing(false); setRestoreError(null); setRestoreNotice('');
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(operation)); }
    catch { setRestoreError(new Error('浏览器无法保留恢复请求编号，因此尚未提交恢复。请允许当前页面使用会话存储后重试。')); setRestoreBusy(false); return; }
    setPending(operation);
    try {
      const receipt = await request<RestoreReceipt>('/api/restores', 'POST', { requestId: operation.requestId, token: operation.token, confirmation: operation.confirmation });
      completed(receipt);
    } catch (failure) {
      try {
        const receipt = await receiptFor(operation);
        if (receipt) { completed(receipt); return; }
        setReceiptMissing(true);
        if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) {
          sessionStorage.removeItem(PENDING_KEY); setPending(null); setPreview(null); dialog.current?.close(); await load(); setError(failure);
        } else { setRestoreError(failure); setRestoreNotice('本地服务已确认没有这次恢复的成功回执。可以使用原请求重试，或取消这次未完成的恢复后重新核对。'); }
      } catch (lookupFailure) { setRestoreError(lookupFailure); setRestoreNotice('暂时无法确认恢复结果，请连接本地服务后查询回执。'); }
    } finally { setRestoreBusy(false); }
  }
  function cancelUnfinishedRestore() {
    if (!pending || restoreBusy || !receiptMissing) return;
    sessionStorage.removeItem(PENDING_KEY); dialog.current?.close();
    setPending(null); setPreview(null); setReceiptMissing(false); setChecked(false); setConfirmation('');
    setError(restoreError); setNotice('已取消这次未完成的恢复。原账本继续保留；需要恢复时请重新核对备份。');
    setRestoreNotice('');
  }
  function submitRestore(event: FormEvent) {
    event.preventDefault(); if (!preview || !checked || confirmation !== RESTORE_CONFIRMATION || settingsUnsaved || restoreBusy) return;
    void execute({ requestId: crypto.randomUUID(), token: preview.token, confirmation: RESTORE_CONFIRMATION, backupId: preview.backup.id });
  }
  const tables = preview ? [...new Set([...Object.keys(preview.currentCounts), ...Object.keys(preview.incomingCounts)])].filter(table => table !== 'restore_receipts') : [];
  return <section className="settings-section backup-settings"><h2>数据与备份</h2><p>手动保存本地账本的一致性副本，同时生成完整 JSON 导出。不会上传到云端；建议把整份备份文件夹复制到另一块磁盘。</p><div className="backup-actions"><button className="button-primary" disabled={busy || !!pending} onClick={() => void create()}>{busy ? '正在处理并校验…' : '创建本地备份'}</button><button className="button-secondary" disabled={busy || !!pending} onClick={() => void load()}>刷新与校验备份</button></div>{notice && <p role="status">{notice}</p>}{Boolean(error) && <p role="alert" className="inline-error">{errorMessage(error)}</p>}
    {view && <><p className="backup-path">保存位置：{view.directory}</p><p className="day-subtle">从其他磁盘找回备份时，把完整的备份编号文件夹复制到上面目录，再刷新与校验。保留数据库、JSON 和清单三个原始文件；单独的 JSON 不用于覆盖恢复。</p>{settingsUnsaved && <p className="restore-hint">基础设置或 AI 设置尚未保存，或正在处理。请先保存或放弃修改，再核对恢复。</p>}{view.unreadable > 0 && <p role="alert">另有 {view.unreadable} 份备份未通过校验，请保留原文件并创建新备份。</p>}{!view.backups.length && <p>尚无可用备份。点击上方按钮创建第一份。</p>}{view.backups.map((backup, index) => <details className="dashboard-details" key={backup.id} open={index === 0}><summary>{index === 0 ? '最近备份 · ' : ''}{new Date(backup.createdAt).toLocaleString('zh-CN')} · 校验通过</summary><p>应用 {backup.appVersion} · 数据版本 {backup.schemaVersion} · {Object.values(backup.rowCounts).reduce((sum, value) => sum + value, 0)} 条存储记录（含历史版本与调用记录）</p><div className="backup-actions">{(['database.sqlite', 'export.json', 'manifest.json'] as const).map((file, i) => <a className="button-secondary" download href={`/api/backups/${backup.id}/${file}`} key={file}>{['下载数据库', '下载 JSON 导出', '下载校验清单'][i]}</a>)}<button className="button-secondary" disabled={busy || settingsUnsaved || !!pending} onClick={() => void openPreview(backup.id)}>核对并恢复</button></div><p className="backup-path">备份编号：{backup.id}</p><details><summary>查看各表记录数</summary><ul>{Object.entries(backup.rowCounts).map(([table, count]) => <li key={table}>{TABLE_NAMES[table] ?? table}：{count}</li>)}</ul></details></details>)}</>}
    <p className="day-subtle">不包含 API 密钥、外部链接指向的稿件或附件。导出包含项目、计划、成果、评分、报告及版本历史；与该次备份是同一时点。密钥需在新机器重新配置。</p><p className="day-subtle">恢复会覆盖整份本地账本，执行前先保存当前账本的保全备份。已有备份文件、当前机器密钥和恢复操作回执继续保留。当前为手动备份，不会自动定时执行。</p><h3>启动与关闭</h3><p>Windows 版双击“人生驾驶舱.exe”打开。关闭窗口会收起到托盘；需要停止计时并退出时，在托盘菜单选择“暂停并退出”。程序更新与本地数据分开保存。</p>
    {(preview || pending) && <dialog className="restore-dialog" ref={dialog} aria-labelledby="restore-title" onCancel={event => { event.preventDefault(); closePreview(); }}><form onSubmit={submitRestore}><h2 id="restore-title">{pending ? '确认恢复结果' : '核对恢复范围'}</h2>{pending ? <><p>恢复请求已提交。结果明确之前，此页会保留原请求，暂停其他编辑。</p><p className="backup-path">来源备份：{pending.backupId}<br />请求编号：{pending.requestId}</p><div className="backup-actions"><button type="button" className="button-primary" disabled={restoreBusy} onClick={() => void checkReceipt(pending)}>{restoreBusy ? '正在恢复或核对…' : '查询恢复回执'}</button><button type="button" className="button-secondary" disabled={restoreBusy} onClick={() => void execute(pending)}>使用原请求重试</button>{receiptMissing && <button type="button" className="button-secondary" style={{ whiteSpace: 'normal' }} disabled={restoreBusy} onClick={cancelUnfinishedRestore}>取消这次未完成的恢复，重新核对</button>}</div></> : preview && <><p>将账本恢复到 <strong>{new Date(preview.backup.createdAt).toLocaleString('zh-CN')}</strong> 的备份时点。</p><p className="backup-path">备份编号：{preview.backup.id} · 应用 {preview.backup.appVersion} · 数据版本 {preview.backup.schemaVersion}</p><div className="restore-scope"><p><strong>覆盖全部项目、设置、每日计划与成果、评分、报告及其历史。</strong>备份后新增或修改的记录、备注将从当前账本消失；本次操作不合并数据。</p><p>执行前自动保全当前账本，成功后可通过该保全备份找回。API 密钥、外部稿件和已有备份文件保持原样；恢复操作回执继续保留。</p></div>{preview.warnings.length > 0 && <ul className="restore-warnings">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}<div className="restore-counts"><table><caption>存储记录对照（包含历史与运行记录，数量相同不代表内容相同）</caption><thead><tr><th scope="col">范围</th><th scope="col">当前</th><th scope="col">恢复后</th></tr></thead><tbody>{tables.map(table => <tr key={table}><th scope="row">{TABLE_NAMES[table] ?? table}</th><td>{preview.currentCounts[table] ?? 0}</td><td>{preview.incomingCounts[table] ?? 0}</td></tr>)}</tbody></table></div><p className="day-subtle">本次核对有效至 {new Date(preview.expiresAt).toLocaleTimeString('zh-CN')}。若账本或备份内容发生变化，必须重新核对。</p><label className="checkbox-label restore-check"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} disabled={restoreBusy} />我已核对备份时间与覆盖范围，接受用备份替换当前账本。</label><label className="field restore-phrase"><span>请输入“{RESTORE_CONFIRMATION}”确认</span><input autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={restoreBusy} /></label><div className="backup-actions"><button className="button-primary" type="submit" disabled={!checked || confirmation !== RESTORE_CONFIRMATION || settingsUnsaved || restoreBusy}>保全当前账本并恢复</button><button className="button-secondary" type="button" disabled={restoreBusy} onClick={closePreview}>取消，不恢复</button></div></>}{restoreNotice && <p role="status">{restoreNotice}</p>}{Boolean(restoreError) && <p role="alert" className="inline-error">{errorMessage(restoreError)}</p>}</form></dialog>}
  </section>;
}

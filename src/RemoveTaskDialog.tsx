import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Trash2, X } from 'lucide-react';
import { ApiError, errorMessage } from './api';
import './remove-task.css';

interface Props {
  date: string;
  title: string;
  project: string;
  confirmed: boolean;
  lastTask: boolean;
  onRemove: (reason: string) => Promise<void>;
  onRefresh: () => Promise<unknown>;
  onClose: () => void;
  onDirty: (value: boolean) => void;
}

export default function RemoveTaskDialog({ date, title, project, confirmed, lastTask, onRemove, onRefresh, onClose, onDirty }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('当天不再安排此任务');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const conflict = error instanceof ApiError && error.status === 409;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const modal = dialog.current;
    modal?.showModal();
    modal?.querySelector<HTMLButtonElement>('[data-cancel]')?.focus();
    return () => { modal?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { onDirty(busy); return () => onDirty(false); }, [busy, onDirty]);
  async function remove() {
    if (busy || !reason.trim() || conflict) return;
    setBusy(true); setError(null);
    try { await onRemove(reason.trim()); onClose(); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  async function refresh() {
    setBusy(true);
    try { await onRefresh(); onClose(); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="modal day-modal remove-task-dialog" aria-label="移除当天任务" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className="modal-header"><div><h2>从当天移除这项任务？</h2><p>{date} · {project}</p></div><button type="button" className="icon-button" aria-label="关闭移除窗口" disabled={busy} onClick={onClose}><X size={20} /></button></header>
    <form onSubmit={event => { event.preventDefault(); void remove(); }}>
      <div className="modal-content">
        <strong className="remove-task-title">{title}</strong>
        <p>{confirmed ? '这项任务及关联的时间安排会从当天计划中移除。项目档案、已记录成果和实际用时都会保留。' : '这项候选会移出当天草稿，项目仍可在以后安排。'}</p>
        {lastTask && <p>移除后当天暂时没有任务，之后可以重新添加。</p>}
        {confirmed && <><p className="field-hint">调整会留下计划版本，原承诺与评分仍可对照。</p><details className="remove-task-reason"><summary>调整原因</summary><label className="field"><span className="sr-only">移除原因</span><input aria-label="移除原因" value={reason} maxLength={1500} disabled={busy} onChange={event => setReason(event.target.value)} /></label></details></>}
        {!!error && <div className="inline-error" role="alert"><p>{errorMessage(error)}</p>{conflict && <button type="button" className="button-secondary" disabled={busy} onClick={() => void refresh()}>重新读取当天安排</button>}</div>}
      </div>
      <footer className="modal-footer"><button data-cancel type="button" className="button-secondary" disabled={busy} onClick={onClose}>保留任务</button><button type="submit" className="button-primary" disabled={busy || !reason.trim() || conflict}>{busy ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}确认移除</button></footer>
    </form>
  </dialog>;
}

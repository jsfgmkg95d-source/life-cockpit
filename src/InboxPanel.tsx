import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Archive, ArrowRight, Inbox, LoaderCircle, Plus, RotateCcw } from 'lucide-react';
import type { AppState } from '../shared/contracts';
import type { InboxItem, InboxView } from '../shared/inbox-contracts';
import { ApiError, errorMessage, request } from './api';

export type { InboxItem } from '../shared/inbox-contracts';
interface Props {
  app: AppState; date: string; onPromote: (item: InboxItem) => void;
  onDirty?: (dirty: boolean) => void; onDateChange?: (date: string) => void;
}

export default function InboxPanel({ app, date, onPromote, onDirty, onDateChange }: Props) {
  const [view, setView] = useState<InboxView | null>(null);
  const [title, setTitle] = useState(''), [projectId, setProjectId] = useState(''), [minutes, setMinutes] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null), [notice, setNotice] = useState('');
  const capturing = useRef(false), mounted = useRef(true), generation = useRef(0);
  const pending = useRef<{ signature: string; requestId: string } | null>(null);
  const archiveKeys = useRef(new Map<string, string>()), titleRef = useRef<HTMLInputElement>(null);
  const dirty = !!(title || projectId || minutes);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: app.settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const arrangeLabel = date === today ? '安排到今天' : `安排到 ${date}`;
  const load = useCallback(async () => {
    const token = ++generation.current;
    try {
      const next = await request<InboxView>('/api/inbox');
      if (mounted.current && token === generation.current) { setView(next); setError(null); }
    } catch (failure) { if (mounted.current && token === generation.current) setError(failure); }
    finally { if (mounted.current && token === generation.current) setLoading(false); }
  }, []);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; generation.current++; }; }, [load]);
  useEffect(() => { onDirty?.(dirty || busy); }, [dirty, busy, onDirty]);
  useEffect(() => () => onDirty?.(false), [onDirty]);
  async function capture(event: FormEvent) {
    event.preventDefault();
    if (capturing.current) return;
    const duration = minutes.trim() === '' ? null : Number(minutes);
    if (!title.trim()) { setError(new Error('先写下一件想做的事。')); titleRef.current?.focus(); return; }
    if (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 1440)) { setError(new Error('预计时长请填写 1 到 1440 的整分钟，或留空。')); return; }
    const body = { title: title.trim(), project_id: projectId || null, estimated_minutes: duration };
    const signature = JSON.stringify(body);
    if (pending.current?.signature !== signature) pending.current = { signature, requestId: crypto.randomUUID() };
    const requestId = pending.current.requestId;
    capturing.current = true; setBusy(true); setError(null); setNotice('');
    try {
      await request('/api/inbox/capture', 'POST', { ...body, requestId });
      if (mounted.current) {
        pending.current = null; setTitle(''); setProjectId(''); setMinutes('');
        setNotice('已记下，之后再决定何时安排。');
        await load(); titleRef.current?.focus();
      }
    } catch (failure) { if (mounted.current) setError(failure); }
    finally { capturing.current = false; if (mounted.current) setBusy(false); }
  }
  async function transition(item: InboxItem, action: 'archive' | 'restore') {
    if (capturing.current) return;
    const body = { revision: item.revision }, signature = JSON.stringify([action, item.id, body]);
    const requestId = archiveKeys.current.get(signature) ?? crypto.randomUUID(); archiveKeys.current.set(signature, requestId);
    capturing.current = true; setBusy(true); setError(null); setNotice('');
    try {
      const next = await request<InboxView>(`/api/inbox/${encodeURIComponent(item.id)}/${action}`, 'POST', { ...body, requestId });
      if (mounted.current) {
        setView(next);
        setNotice(action === 'restore' ? '已恢复到收件箱，原记录保留。' : '已归档，可以在已归档清单中恢复。'); await load();
      }
    } catch (failure) { if (mounted.current) setError(failure); }
    finally { capturing.current = false; if (mounted.current) setBusy(false); }
  }
  const items = (view?.items ?? []).filter(item => item.status === 'inbox');
  const archived = (view?.items ?? []).filter(item => item.status === 'archived');
  return <section className="inbox-panel" aria-label="待安排清单">
    <header className="planner-panel-head"><div><h2>先记下来</h2><p>想法和待办，整理后再安排到一天。</p></div>{view && <span className="inbox-count">{view.inboxCount} 项待安排</span>}</header>
    <div className="inbox-arrange-date"><p>准备安排到 {date === today ? `今天 · ${date}` : date}</p>{onDateChange && <label className="field"><span className="field-label">安排日期</span><input type="date" required disabled={busy} value={date} onChange={event => { if (event.target.value) onDateChange(event.target.value); }} /></label>}</div>
    <form className="inbox-capture" onSubmit={event => void capture(event)}><fieldset disabled={busy}><div className="inbox-capture-main"><label className="sr-only" htmlFor="inbox-capture-title">要记下的事</label><input id="inbox-capture-title" ref={titleRef} type="text" required maxLength={240} placeholder="先记下来，稍后再安排" value={title} onChange={event => setTitle(event.target.value)} /><button className="button-primary" disabled={busy || !title.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}记下</button></div><details className="inbox-capture-options"><summary>补充项目与预计用时</summary><div><label className="field"><span className="field-label">所属项目（选填）</span><select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">之后再决定</option>{app.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><label className="field"><span className="field-label">预计分钟（选填）</span><input type="number" min={1} max={1440} step={1} value={minutes} onChange={event => setMinutes(event.target.value)} placeholder="未确定可留空" /></label></div></details></fieldset></form>
    {!!error && <div className="planner-error" role="alert"><p>{errorMessage(error)}</p><button type="button" className="button-quiet" disabled={busy} onClick={() => void load()}>{error instanceof ApiError && error.status === 409 ? '读取最新清单' : '重新读取'}</button>{dirty && <small>填写内容仍保留，可以重试。</small>}</div>}
    {notice && <p className="planner-notice" role="status">{notice}</p>}
    {loading ? <div className="planner-empty"><LoaderCircle size={21} className="spin" /><p>正在读取待安排清单…</p></div> : view && (!items.length ? <div className="planner-empty"><Inbox size={25} strokeWidth={1.4} /><div><strong>脑海里的事，先放在这里</strong><p>只需写下一句话，项目和时间可以之后补充。</p></div></div> : <div className="inbox-list">{items.map(item => {
      const project = app.projects.find(row => row.id === item.project_id);
      return <article className="inbox-row" key={item.id}><div className="inbox-copy"><h3>{item.title}</h3><div className="inbox-meta">{item.project_id && <span>{project?.name ?? '原项目'}</span>}{item.estimated_minutes !== null && <span>预计 {item.estimated_minutes} 分钟</span>}</div></div><div className="inbox-actions"><button type="button" className="button-secondary" disabled={busy} onClick={() => onPromote(item)} aria-label={`${arrangeLabel}：${item.title}`} title={`准备加入 ${date}，确认后才成为当日任务`}>{arrangeLabel}<ArrowRight size={13} /></button><button type="button" className="icon-button" disabled={busy} onClick={() => void transition(item, 'archive')} aria-label={`归档：${item.title}`} title="归档"><Archive size={15} /></button></div></article>;
    })}</div>)}
    {!!archived.length && <details className="inbox-archived"><summary>已归档 · {archived.length}</summary><div className="inbox-list">{archived.map(item => <article className="inbox-row" key={item.id}><div className="inbox-copy"><h3>{item.title}</h3><div className="inbox-meta"><span>已归档</span>{item.planned_date && <span>原任务日期 {item.planned_date}</span>}</div></div><div className="inbox-actions">{item.planned_task_id === null && item.planned_date === null ? <button type="button" className="button-secondary" disabled={busy} onClick={() => void transition(item, 'restore')} aria-label={`恢复到收件箱：${item.title}`}><RotateCcw size={13} />恢复到收件箱</button> : <span className="inbox-meta">已安排的原任务继续保留</span>}</div></article>)}</div></details>}
  </section>;
}

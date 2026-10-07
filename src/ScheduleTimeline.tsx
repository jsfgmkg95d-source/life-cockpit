import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { CalendarDays, LoaderCircle, Pencil, Play, Plus, Trash2, X } from 'lucide-react';
import type { DailyTask, DayState } from '../shared/day-contracts';
import type { TimerView } from '../shared/timer-contracts';
import type { ScheduleBlock, ScheduleView } from '../shared/schedule-contracts';
import { clockTime, timerDuration } from '../shared/timer-time';
import { ApiError, errorMessage, request } from './api';

interface Draft {
  date: string; id: string | null; taskId: string; title: string;
  start: string; minutes: string; revision: number; nonce: string; changed: boolean;
}
interface PendingWrite { path: 'save' | 'delete'; date: string; body: object; requestId: string }
interface Props {
  date: string; day: DayState; onChanged: () => Promise<unknown>;
  onDirty?: (dirty: boolean) => void; onFocus?: (task: DailyTask) => void;
}
const atMinute = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
function minuteAt(value: string | number, timezone: string) {
  const [hours, minutes] = clockTime(value, timezone).split(':').map(Number);
  return hours * 60 + minutes;
}
function businessDate(now: number, timezone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export default function ScheduleTimeline({ date, day, onChanged, onDirty, onFocus }: Props) {
  const [view, setView] = useState<ScheduleView | null>(null);
  const [actual, setActual] = useState<TimerView | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null), [actualError, setActualError] = useState('');
  const [notice, setNotice] = useState(''), [draft, setDraft] = useState<Draft | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [now, setNow] = useState(Date.now());
  const dialogRef = useRef<HTMLDialogElement>(null), generation = useRef(0);
  const saving = useRef(false), keys = useRef(new Map<string, string>());
  const pendingWrite = useRef<PendingWrite | null>(null);
  const activeDate = useRef(date); activeDate.current = date;
  const plan = day.log?.plan_snapshots.find(item => item.plan_version === day.log?.current_plan_version);
  const planTasks = new Set(plan?.tasks.map(task => task.task_id) ?? []);
  const tasks = day.tasks.filter(task => task.eligible && planTasks.has(task.task_id) && task.status !== 'cancelled');
  const timezone = view?.timezone ?? day.timezone;
  const today = businessDate(now, timezone);
  const editing = draft?.id ? view?.blocks.find(block => block.id === draft.id) : null;

  const load = useCallback(async () => {
    const token = ++generation.current;
    const results = await Promise.allSettled([
      request<ScheduleView>(`/api/days/${date}/schedule`),
      request<TimerView>(`/api/days/${date}/timer`),
    ]);
    if (token !== generation.current || activeDate.current !== date) return null;
    const [scheduled, recorded] = results;
    if (scheduled.status === 'fulfilled') setView(scheduled.value);
    else { setView(null); setError(scheduled.reason); }
    if (recorded.status === 'fulfilled') { setActual(recorded.value); setActualError(''); }
    else { setActual(null); setActualError(errorMessage(recorded.reason)); }
    return scheduled.status === 'fulfilled' ? scheduled.value : null;
  }, [date]);
  useEffect(() => {
    let live = true; setLoading(true); setView(null); setActual(null); if (!pendingWrite.current) setError(null); setNotice('');
    void load().finally(() => { if (live) setLoading(false); });
    return () => { live = false; generation.current++; };
  }, [load, day.log?.revision]);
  useEffect(() => { const tick = window.setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(tick); }, []);
  useEffect(() => { onDirty?.(!!draft?.changed || busy || uncertain); }, [draft?.changed, busy, uncertain, onDirty]);
  useEffect(() => () => onDirty?.(false), [onDirty]);
  const hasDialog = !!draft;
  useEffect(() => {
    if (!hasDialog) return;
    const previous = document.activeElement as HTMLElement | null, modal = dialogRef.current;
    modal?.showModal(); modal?.querySelector<HTMLInputElement>('input[type=text]')?.focus();
    return () => { modal?.close(); previous?.focus(); };
  }, [hasDialog]);

  function open(task?: DailyTask, block?: ScheduleBlock) {
    if (busy || uncertain || !view) return;
    const start = block ? atMinute(block.start_minute) : '';
    setDraft({ date, id: block?.id ?? null, taskId: block?.task_id ?? task?.task_id ?? '',
      title: block?.title ?? task?.title ?? '', start,
      minutes: String(block?.duration_minutes ?? task?.estimated_minutes ?? 30),
      revision: view.revision, nonce: crypto.randomUUID(), changed: false });
    setError(null); setNotice('');
  }
  function patch(values: Partial<Draft>) { setDraft(current => current ? { ...current, ...values, changed: true } : null); }
  function close() {
    if (!busy && !uncertain && (!draft?.changed || window.confirm('还有未保存的安排，确定放弃吗？'))) { setDraft(null); setError(null); }
  }
  async function execute(attempt: PendingWrite) {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(null); setNotice('');
    try {
      const saved = await request<ScheduleView>(`/api/days/${attempt.date}/schedule/${attempt.path}`, 'POST', { ...attempt.body, requestId: attempt.requestId });
      if (activeDate.current === attempt.date) setView(saved);
      pendingWrite.current = null; setUncertain(false); setDraft(null);
      setNotice(attempt.path === 'delete' ? '这段安排已删除。' : '时间安排已保存。');
      try { await onChanged(); } catch { setNotice('变更已保存，当天信息暂未刷新，请重新读取。'); }
    } catch (failure) {
      const definitelyRejected = failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && failure.status !== 408 && failure.status !== 429;
      pendingWrite.current = definitelyRejected ? null : attempt;
      setUncertain(!definitelyRejected); setError(failure);
    } finally { saving.current = false; setBusy(false); }
  }
  async function refresh() {
    if (saving.current) return;
    if (pendingWrite.current) { await execute(pendingWrite.current); return; }
    setBusy(true);
    try {
      const latest = await load();
      if (latest) { setDraft(current => current ? { ...current, revision: latest.revision } : null); setError(null); }
    } finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || saving.current) return;
    if (pendingWrite.current) { await execute(pendingWrite.current); return; }
    const current = draft;
    const [hour, minute] = current.start.split(':').map(Number), start = hour * 60 + minute;
    const duration = Number(current.minutes);
    if (!current.title.trim()) { setError(new Error('请写下这段时间要做什么。')); return; }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(current.start) || !Number.isInteger(start) || start < 0 || start > 1439) { setError(new Error('请选择有效的开始时刻。')); return; }
    if (!Number.isInteger(duration) || duration < 1 || duration > 720 || start + duration > 1440) { setError(new Error('每段安排为 1 到 720 整分钟，且应在当天结束；跨日请分别安排。')); return; }
    const body = { revision: current.revision, id: current.id, task_id: current.taskId || null,
      title: current.title.trim(), start_minute: start, duration_minutes: duration };
    const signature = JSON.stringify([current.nonce, current.date, body]);
    const requestId = keys.current.get(signature) ?? crypto.randomUUID(); keys.current.set(signature, requestId);
    await execute({ path: 'save', date: current.date, body, requestId });
  }
  async function remove(block: ScheduleBlock) {
    if (saving.current || uncertain || !draft || !window.confirm(`删除「${block.title}」的这段时间安排？任务和实际投入会保留。`)) return;
    const current = draft, body = { id: block.id, revision: current.revision };
    const signature = JSON.stringify(['delete', current.nonce, current.date, body]);
    const requestId = keys.current.get(signature) ?? crypto.randomUUID(); keys.current.set(signature, requestId);
    await execute({ path: 'delete', date: current.date, body, requestId });
  }
  const recorded = (actual?.sessions ?? []).filter(session => session.stopped_at === null || (session.elapsed_seconds ?? 0) > 0).map(session => {
    const start = minuteAt(session.started_at, timezone);
    const end = session.stopped_at ? minuteAt(session.stopped_at, timezone) : date < today ? 1440 : minuteAt(now, timezone);
    const seconds = session.elapsed_seconds ?? Math.max(0, Math.floor((now - Date.parse(session.started_at)) / 1000));
    return { ...session, start, end: Math.max(start + 1, end), seconds };
  });
  const points = actual?.points ?? [];
  const nowMinute = minuteAt(now, timezone);
  const begins = [480, ...(date === today ? [nowMinute] : []), ...(view?.blocks.map(block => block.start_minute) ?? []), ...recorded.map(session => session.start), ...points.map(point => minuteAt(point.occurred_at, timezone))];
  const ends = [1200, ...(date === today ? [nowMinute + 1] : []), ...(view?.blocks.map(block => block.start_minute + block.duration_minutes) ?? []), ...recorded.map(session => session.end), ...points.map(point => minuteAt(point.occurred_at, timezone) + 1)];
  const firstHour = Math.max(0, Math.floor(Math.min(...begins) / 60)), lastHour = Math.min(24, Math.ceil(Math.max(...ends) / 60));
  const rangeStart = firstHour * 60, rangeMinutes = (lastHour - firstHour) * 60;
  const blockStyle = (start: number, duration: number) => ({ '--block-top': `${(start - rangeStart) / rangeMinutes * 100}%`, '--block-height': `${duration / rangeMinutes * 100}%` } as CSSProperties);
  const showNow = date === today && nowMinute >= rangeStart && nowMinute <= lastHour * 60;
  const errorNode = error ? <div className="planner-error" role="alert"><p>{errorMessage(error)}</p>{error instanceof ApiError && error.fields && <ul>{Object.entries(error.fields).map(([key, text]) => <li key={key}>{text}</li>)}</ul>}<button className="button-quiet" type="button" disabled={busy} onClick={() => void refresh()}>{uncertain ? '核对本次保存结果' : error instanceof ApiError && error.status === 409 ? '读取最新安排再重试' : '重新读取'}</button>{draft && <small>{uncertain ? '这次保存的结果尚未确认。请先核对，再修改安排。' : '当前填写的内容会保留。'}</small>}</div> : null;
  return <section className="schedule-panel" aria-label="每日时间安排">
    <header className="planner-panel-head"><div><h2>时间安排</h2><p>{view ? `${view.plannedMinutes} 分钟已安排` : '为今天留出明确的时间'}</p></div><button className="button-secondary" disabled={busy || !view} onClick={() => open()}><Plus size={15} />添加安排</button></header>
    {!draft && errorNode}{notice && <p className="planner-notice" role="status">{notice}</p>}
    {loading ? <div className="planner-empty"><LoaderCircle size={21} className="spin" /><p>正在读取时间安排…</p></div> : view && <>
      <div className="schedule-legend"><span><i className="planned" />计划</span><span><i className="actual" />实际投入</span><span><i className="point" />时间点</span></div>
      {!view.blocks.length && <div className="schedule-empty"><CalendarDays size={22} /><div><strong>这一天还没有时间安排</strong><p>从下方任务选择一项，或添加一段自由安排。</p></div></div>}
      {(view.blocks.length > 0 || recorded.length > 0 || points.length > 0) && <div className="schedule-timeline" style={{ '--timeline-height': `${(lastHour - firstHour) * 64}px` } as CSSProperties}>
        <div className="schedule-hours" aria-hidden="true">{Array.from({ length: lastHour - firstHour + 1 }, (_, index) => <div className="schedule-hour" key={index} style={{ '--hour-top': `${index / (lastHour - firstHour) * 100}%` } as CSSProperties}><span>{atMinute((firstHour + index) * 60)}</span></div>)}</div>
        <div className="schedule-lanes"><div className="schedule-lane"><span className="schedule-lane-label">计划</span>{view.blocks.map(block => {
          const task = tasks.find(item => item.task_id === block.task_id), end = block.start_minute + block.duration_minutes;
          return <article key={block.id} className={`schedule-block planned ${block.task_id && !block.task_eligible ? 'inactive' : ''} ${block.duration_minutes < 30 ? 'compact' : ''}`} style={blockStyle(block.start_minute, block.duration_minutes)}>
            <button type="button" className="schedule-block-edit" disabled={busy} onClick={() => open(undefined, block)} aria-label={`编辑安排：${block.title}，${atMinute(block.start_minute)} 至 ${atMinute(end)}`}><strong>{block.title}</strong><small>{atMinute(block.start_minute)}–{atMinute(end)} · {block.duration_minutes} 分钟</small>{block.task_id && !block.task_eligible && <small>原任务已调整</small>}</button>
            {task && onFocus && date === today && !['done', 'cancelled'].includes(task.status) && <button className="schedule-focus-button" type="button" aria-label={`专注：${block.title}`} disabled={busy} onClick={() => onFocus(task)}><Play size={12} /></button>}
          </article>;
        })}</div><div className="schedule-lane"><span className="schedule-lane-label">实际</span>{recorded.map(session => <div key={session.id} className={`schedule-block actual ${session.end - session.start < 30 ? 'compact' : ''}`} style={blockStyle(session.start, session.end - session.start)} title={`${session.block_title} · ${clockTime(session.started_at, timezone)} ${session.stopped_at ? `至 ${clockTime(session.stopped_at, timezone)}` : '开始，正在计时'} · ${timerDuration(session.seconds)}`}><strong>{session.block_title}</strong><small>{atMinute(session.start)}–{atMinute(session.end)} · {session.stopped_at ? timerDuration(session.seconds) : '正在计时'}</small></div>)}{points.map(point => <div key={point.id} className="schedule-point" style={{ '--block-top': `${(minuteAt(point.occurred_at, timezone) - rangeStart) / rangeMinutes * 100}%` } as CSSProperties} title={`${clockTime(point.occurred_at, timezone)} · ${point.label}`}><i /><span>{clockTime(point.occurred_at, timezone).slice(0, 5)} · {point.label}</span></div>)}</div></div>
        {showNow && <div className="schedule-now-line" style={{ '--block-top': `${(nowMinute - rangeStart) / rangeMinutes * 100}%` } as CSSProperties} aria-label={`现在 ${atMinute(nowMinute)}`}><span>现在</span></div>}
      </div>}
      {!!view.blocks.length && <details className="schedule-details"><summary>安排明细 · {view.blocks.length}</summary><div className="schedule-detail-list">{view.blocks.map(block => {
        const task = tasks.find(item => item.task_id === block.task_id), end = block.start_minute + block.duration_minutes;
        return <div className="schedule-detail-row" key={block.id}><div><strong>{block.title}</strong><span>{atMinute(block.start_minute)}–{atMinute(end)} · {block.duration_minutes} 分钟{block.task_id && !block.task_eligible ? ' · 原任务已调整' : ''}</span></div><div className="schedule-detail-actions"><button type="button" className="button-secondary" disabled={busy || uncertain} onClick={() => open(undefined, block)} aria-label={`编辑安排明细：${block.title}，${atMinute(block.start_minute)} 至 ${atMinute(end)}`}><Pencil size={13} />编辑安排</button>{task && onFocus && date === today && !['done', 'cancelled'].includes(task.status) && <button type="button" className="button-quiet" disabled={busy || uncertain} onClick={() => onFocus(task)} aria-label={`从安排明细专注：${block.title}`}><Play size={13} />专注</button>}</div></div>;
      })}</div></details>}
      {actualError && <p className="planner-error" role="alert">实际记录暂未读到：{actualError}</p>}
      <p className="schedule-footnote">计划用于安排时间；实际投入依据计时和已确认记录分别保存。</p>
      {tasks.length > 0 && <div className="schedule-unscheduled"><h3>从今日任务安排</h3>{tasks.map(task => {
        const count = view.blocks.filter(block => block.task_id === task.task_id).length;
        return <div className="schedule-task-row" key={task.task_id}><div><strong>{task.title}</strong><span>{task.project_name}{task.estimated_minutes !== null ? ` · 预计 ${task.estimated_minutes} 分钟` : ''}{count ? ` · 已安排 ${count} 段` : ''}</span></div><button className="button-quiet" disabled={busy} onClick={() => open(task)}><Plus size={13} />{count ? '再安排一段' : '安排时间'}</button></div>;
      })}</div>}
    </>}
    {draft && <dialog ref={dialogRef} className="modal planner-dialog" aria-label={draft.id ? '编辑时间安排' : '添加时间安排'} onCancel={event => { event.preventDefault(); close(); }}>
      <header className="modal-header"><div><h2>{draft.id ? '编辑时间安排' : '添加时间安排'}</h2><p>{draft.date} · {timezone === 'Asia/Shanghai' ? '北京时间' : timezone}</p></div><button type="button" className="icon-button" aria-label="关闭时间安排" disabled={busy || uncertain} onClick={close}><X size={18} /></button></header>
      <form onSubmit={event => void submit(event)}><div className="modal-content"><fieldset disabled={busy || uncertain}><label className="field"><span className="field-label">关联任务</span><select value={draft.taskId} onChange={event => { const task = tasks.find(item => item.task_id === event.target.value), prior = tasks.find(item => item.task_id === draft.taskId); patch({ taskId: event.target.value, ...(!draft.title.trim() || draft.title === prior?.title ? { title: task?.title ?? '' } : {}) }); }}><option value="">自由安排</option>{tasks.map(task => <option value={task.task_id} key={task.task_id}>{task.project_name} · {task.title}</option>)}{draft.taskId && !tasks.some(task => task.task_id === draft.taskId) && <option value={draft.taskId}>原任务已调整 · 可改为自由安排</option>}</select></label><label className="field"><span className="field-label">这段时间做什么</span><input type="text" required maxLength={240} value={draft.title} onChange={event => patch({ title: event.target.value })} placeholder="写作、阅读，或留给自己的时间" /></label><div className="planner-time-fields"><label className="field"><span className="field-label">开始时刻</span><input type="time" required step={60} value={draft.start} onChange={event => patch({ start: event.target.value })} /></label><label className="field"><span className="field-label">计划时长（分钟）</span><input type="number" required min={1} max={720} step={1} value={draft.minutes} onChange={event => patch({ minutes: event.target.value })} /></label></div><p className="quiet-note">可以把同一任务分成几段安排。保存安排不会增加实际用时，也不会确认任务完成。</p></fieldset>{errorNode}</div><footer className="modal-footer">{editing && <button type="button" className="button-quiet" disabled={busy} onClick={() => void remove(editing)}><Trash2 size={14} />删除安排</button>}<button className="button-primary" disabled={busy}>{busy ? <LoaderCircle size={14} className="spin" /> : <Pencil size={14} />}保存安排</button></footer></form>
    </dialog>}
  </section>;
}

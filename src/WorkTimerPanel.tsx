import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Clock3, Flag, LoaderCircle, Pause, Play, Plus, Trash2, X } from 'lucide-react';
import type { DailyTask, DayState, WorkBlock } from '../shared/day-contracts';
import type { TimerView } from '../shared/timer-contracts';
import { businessTimeToIso, clockTime, timerDuration } from '../shared/timer-time';
import { ApiError, errorMessage, request } from './api';
import './work-timer.css';

const minutesText = (minutes: number | null | undefined) => minutes == null ? '—' : minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}`;
function ClockFace({ now, timezone, active }: { now: number; timezone: string; active: boolean }) {
  const [hour, minute, second] = clockTime(now, timezone).split(':').map(Number);
  return <svg className="time-clock" viewBox="0 0 180 180" role="img" aria-label={`钟表 ${clockTime(now, timezone)}`}>
    <circle cx="90" cy="90" r="85" className="time-clock-rim" />
    {Array.from({ length: 60 }, (_, i) => <line key={i} x1="90" y1={i % 5 === 0 ? 15 : 18} x2="90" y2={i % 5 === 0 ? 23 : 21} transform={`rotate(${i * 6} 90 90)`} className={i % 5 === 0 ? 'time-clock-hour-tick' : 'time-clock-tick'} />)}
    <text x="90" y="40">12</text><text x="145" y="94">3</text><text x="90" y="150">6</text><text x="35" y="94">9</text>
    <line x1="90" y1="93" x2="90" y2="52" transform={`rotate(${(hour % 12) * 30 + minute / 2} 90 90)`} className="time-clock-hour" />
    <line x1="90" y1="97" x2="90" y2="33" transform={`rotate(${minute * 6 + second / 10} 90 90)`} className="time-clock-minute" />
    <line x1="90" y1="105" x2="90" y2="29" transform={`rotate(${second * 6} 90 90)`} className={`time-clock-second ${active ? 'running' : ''}`} /><circle cx="90" cy="90" r="4" className="time-clock-center" />
  </svg>;
}
interface Props {
  state: DayState; blocks: WorkBlock[]; tasks?: DailyTask[]; focusIntent?: { task: DailyTask; nonce: string } | null; onChanged: () => Promise<unknown>; activeOnly?: boolean;
  onDirty?: (dirty: boolean) => void; onAddTask?: () => void; onOpenResults?: () => void;
}
export default function WorkTimerPanel({ state, blocks, tasks = [], focusIntent, onChanged, activeOnly = false, onDirty, onAddTask, onOpenResults }: Props) {
  const [view, setView] = useState<TimerView | null>(null);
  const [selected, setSelected] = useState('');
  const [selectedTask, setSelectedTask] = useState('');
  const [targetMinutes, setTargetMinutes] = useState<number | null>(null);
  const consumedIntent = useRef('');
  const attempts = useRef(new Map<string, { revision: number; requestId: string }>());
  const eligibleTasks = tasks.filter(task => task.status === 'todo' || task.status === 'doing');
  const chosenTask = eligibleTasks.find(task => task.task_id === selectedTask) ?? eligibleTasks[0];
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false), [now, setNow] = useState(Date.now());
  const [readError, setReadError] = useState('');
  const [mode, setMode] = useState<'point' | 'period' | null>(null);
  const [label, setLabel] = useState(''), [at, setAt] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const date = state.business_date, timezone = state.timezone;
  const timezoneLabel = timezone === 'Asia/Shanghai' ? '北京时间' : new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, timeZoneName: 'long' }).formatToParts(now).find(part => part.type === 'timeZoneName')?.value ?? timezone;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const resolvedBlockId = chosenTask?.work_block_id ?? (blocks.some(block => block.id === selected) ? selected : blocks[0]?.id ?? '');
  const allBlocks = [...blocks, ...[...(state.log?.plan_snapshots ?? [])].reverse().flatMap(plan => plan.work_blocks)].filter((block, index, items) => items.findIndex(item => item.id === block.id) === index);
  const periodBlockId = allBlocks.some(block => block.id === selected) ? selected : allBlocks[0]?.id ?? '';
  const periodActual = state.log?.work_block_actuals.find(actual => actual.block_id === periodBlockId);

  useEffect(() => { let live = true, pending = false;
    const load = async () => { if (pending) return; pending = true; try { const value = await request<TimerView>(`/api/days/${date}/timer`); if (live) { setView(value); setReadError(''); } } catch (failure) { if (live) setReadError(errorMessage(failure)); } finally { pending = false; } };
    void load(); const timer = window.setInterval(() => void load(), 15000); return () => { live = false; clearInterval(timer); };
  }, [date, state.log?.revision]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { onDirty?.(!!mode || busy); }, [mode, busy, onDirty]);
  useEffect(() => () => onDirty?.(false), [onDirty]);
  useEffect(() => { if (!mode) return; const previous = document.activeElement as HTMLElement | null; const modal = dialogRef.current; modal?.showModal(); return () => { modal?.close(); previous?.focus(); }; }, [mode]);

  async function save(path: string, body: object, targetDate = date) {
    if (busy) return false;
    setBusy(true); setError(''); setConflict(false); setNotice('');
    try {
      const signature = JSON.stringify([targetDate, path, body]);
      let attempt = attempts.current.get(signature);
      if (!attempt) { const day = await request<DayState>(`/api/days/${targetDate}`); attempt = { revision: day.log?.revision ?? 0, requestId: crypto.randomUUID() }; attempts.current.set(signature, attempt); }
      await request(`/api/days/${targetDate}/timer/${path}`, 'POST', { ...body, ...attempt });
      attempts.current.delete(signature);
      window.dispatchEvent(new Event('pcos-timer-change'));
      setNotice(path === 'start' ? '正在计时。暂停时会保存这一段投入。' : path === 'stop' ? '这一段已结束，实际用时已保存。' : path === 'point' ? '时间点已留下。' : path === 'point-delete' ? '时间点已撤销。' : '时间段已保存并计入实际投入。');
      try { await onChanged(); setView(await request<TimerView>(`/api/days/${date}/timer`)); } catch { setNotice('记录已保存，最新状态暂未刷新，请重新读取。'); }
      return true;
    } catch (failure) { setError(errorMessage(failure)); setConflict(failure instanceof ApiError && failure.status === 409); return false; }
    finally { setBusy(false); }
  }
  async function refresh() { attempts.current.clear(); try { await onChanged(); setView(await request<TimerView>(`/api/days/${date}/timer`)); setError(''); setReadError(''); setConflict(false); } catch (failure) { setError(errorMessage(failure)); } }
  function openEntry(next: 'point' | 'period') { setLabel(''); setAt(date === today ? clockTime(Date.now(), timezone) : ''); setFrom(''); setTo(''); setAcknowledge(false); setError(''); setConflict(false); setMode(next); }
  function closeEntry() { if (!busy && (!(label || from || to) || window.confirm('还有未保存的记录，确定放弃吗？'))) setMode(null); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const saved = mode === 'point' ? await save('point', { label: label.trim(), occurred_at: businessTimeToIso(date, at, timezone) })
        : await save('period', { block_id: periodBlockId, started_at: businessTimeToIso(date, from, timezone), stopped_at: businessTimeToIso(date, to, timezone), acknowledgeUntrackedActual: acknowledge });
      if (saved) setMode(null);
    } catch (failure) { setError(errorMessage(failure)); }
  }
  useEffect(() => {
    if (!view) return;
    for (const [signature] of attempts.current) {
      const [attemptDate, path, body] = JSON.parse(signature);
      if (path === 'start' && view.active && attemptDate === view.active.business_date && body.block_id === view.active.block_id && (body.task_id ?? null) === view.active.task_id && (body.target_minutes ?? null) === view.active.target_minutes) attempts.current.delete(signature);
    }
  }, [view]);
  useEffect(() => { const listener = () => { void onChanged().then(() => request<TimerView>(`/api/days/${date}/timer`)).then(setView).catch(failure => setReadError(errorMessage(failure))); }; window.addEventListener('pcos-timer-change', listener); return () => window.removeEventListener('pcos-timer-change', listener); }, [date, onChanged]);
  useEffect(() => {
    if (!focusIntent || !view || busy || consumedIntent.current === focusIntent.nonce) return;
    consumedIntent.current = focusIntent.nonce;
    const task = eligibleTasks.find(item => item.task_id === focusIntent.task.task_id);
    if (!task || date !== today) { setError('这项任务当前不能启动计时，请读取最新任务。'); return; }
    setSelectedTask(task.task_id);
    void (async () => {
      if (view.active?.task_id === task.task_id && view.active.business_date === date) { await refresh(); return; }
      if (view.active && !(await save('stop', { discard: false, expected_session_id: view.active.id }, view.active.business_date))) return;
      await save('start', { block_id: task.work_block_id, task_id: task.task_id, target_minutes: targetMinutes });
    })();
  }, [focusIntent, view, busy, date, today]);
  const active = view?.active;
  const seconds = active ? Math.max(0, Math.floor((now - Date.parse(active.started_at)) / 1000)) : 0;
  const selectedSeconds = view?.sessions.filter(session => session.block_id === resolvedBlockId && session.stopped_at).reduce((total, session) => total + (session.elapsed_seconds ?? 0), 0) ?? 0;
  const summary = view?.summary;
  const timeline = [
    ...(view?.points ?? []).map(point => ({ id: point.id, at: point.occurred_at, title: point.label, detail: `${clockTime(point.occurred_at, timezone)} · 时间点`, point: true })),
    ...(view?.sessions ?? []).map(session => ({ id: session.id, at: session.started_at, title: session.task_title ?? session.block_title, detail: session.stopped_at ? `${clockTime(session.started_at, timezone)} — ${clockTime(session.stopped_at, timezone)} · ${session.elapsed_seconds ? timerDuration(session.elapsed_seconds) : '未计入投入'}` : `${clockTime(session.started_at, timezone)} 开始 · 正在计时`, point: false })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  if (activeOnly && !active && !error && !readError && !mode) return null;
  const errorNode = (error || readError) && <div className="time-error" role="alert"><p>{error || readError}</p><button type="button" className="button-quiet" disabled={busy} onClick={() => void refresh()}>{conflict ? '读取最新记录再重试' : '重新读取'}</button></div>;
  return <section className={`time-cockpit ${active ? 'is-running' : ''} ${activeOnly ? 'time-compact' : ''}`} aria-label="专注与时间">
    <header className="time-heading"><h2><Clock3 size={17} />专注与时间</h2><span className="time-state"><i />{active ? '正在投入' : '按自己的节奏'}</span></header>
    <div className="time-hero"><div className="time-dial"><ClockFace now={now} timezone={timezone} active={!!active} /><span>{timezoneLabel} · {clockTime(now, timezone)}</span></div><div className="time-controls">
      <span className="time-kicker">{active ? active.task_title ?? active.block_title : '当前时间'}</span><div className="time-readout" role="timer" aria-live="off">{active ? timerDuration(seconds) : clockTime(now, timezone).slice(0, 5)}</div>{active?.target_minutes != null && <p className="focus-target-hint">目标 {active.target_minutes} 分钟 · {seconds >= active.target_minutes * 60 ? '已达到目标，可暂停或继续' : `还剩 ${timerDuration(active.target_minutes * 60 - seconds)}`}</p>}
      {active ? <><p className="time-context">从 {clockTime(active.started_at, timezone)} 开始{active.business_date !== date ? ` · 属于 ${active.business_date}` : ''}</p><div className="time-actions"><button className="button-primary" disabled={busy} onClick={() => void save('stop', { discard: false, expected_session_id: active.id }, active.business_date)}>{busy ? <LoaderCircle size={15} className="spin" /> : <Pause size={15} />}暂停并记录</button><button className="button-secondary" disabled={busy || date > today} onClick={() => openEntry('point')}><Flag size={14} />记时间点</button></div><p className="time-hint">关闭页面会继续计时；暂停后的休息时间不计入。</p><details className="time-forgot"><summary>忘记暂停了</summary><p>弃计本段后可补记核对过的起止时间，跨日需分两天记录。</p><button className="button-quiet" disabled={busy} onClick={() => { if (window.confirm('弃计正在运行的这一段？之前已保存的投入会保留。')) void save('stop', { discard: true, expected_session_id: active.id }, active.business_date); }}>弃计本段</button></details></>
      : <><div className="time-block-choice"><label className="sr-only" htmlFor={`time-task-${date}`}>选择专注任务</label><select id={`time-task-${date}`} value={chosenTask?.task_id ?? ''} onChange={event => setSelectedTask(event.target.value)} disabled={busy || !eligibleTasks.length}><option value="" hidden>选择专注任务</option>{eligibleTasks.map(task => <option key={task.task_id} value={task.task_id}>{task.title}</option>)}</select></div><div className="focus-duration-options" role="group" aria-label="专注目标">{[null, 25, 50].map(minutes => <button type="button" key={minutes ?? 0} aria-pressed={targetMinutes === minutes} disabled={busy} onClick={() => setTargetMinutes(minutes)}>{minutes === null ? '自由计时' : `${minutes} 分钟`}</button>)}</div><div className="time-actions"><button className="button-primary" disabled={busy || !eligibleTasks.length || !view || date !== today} onClick={() => void save('start', { block_id: resolvedBlockId, task_id: chosenTask?.task_id ?? null, target_minutes: targetMinutes })}>{busy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}{selectedSeconds > 0 ? '继续计时' : '开始计时'}</button><button className="button-secondary" disabled={busy || !view || date > today} onClick={() => openEntry('point')}><Flag size={14} />记时间点</button><button className="button-quiet" disabled={busy || !view || !allBlocks.length || date > today} onClick={() => openEntry('period')}><Plus size={14} />补记时间段</button></div><p className="time-hint">{date > today ? '未来的实际时间不能提前记录。' : date < today ? '正在查看过去的一天，可以补记发生过的时间。' : !blocks.length ? '确认一项任务后即可计时，时间点可直接记录。' : selectedSeconds > 0 ? `此时段已留下 ${timerDuration(selectedSeconds)}；继续会新增一段。` : '选择任务开始；达到目标后由你决定暂停或继续。'}{!blocks.length && onAddTask && <button type="button" className="time-inline-link" onClick={onAddTask}>添加任务</button>}</p></>}
    </div></div>
    {!activeOnly && <><div className="time-accumulation"><div><span>{date === today ? '今天' : '这一天'}投入</span><strong>{minutesText(summary?.todayMinutes)}</strong></div><div><span>近 7 天</span><strong>{minutesText(summary?.weekMinutes)}</strong></div><div><span>累计投入</span><strong>{minutesText(summary?.totalMinutes)}</strong></div><div><span>投入天数</span><strong>{summary ? `${summary.timeDays} 天` : '—'}</strong></div></div>
      <div className="time-compound">{onOpenResults && <button type="button" className="time-inline-link" onClick={onOpenResults}>回看留下的成果<ArrowRight size={13} /></button>}</div>
      <details className="time-history"><summary>{date === today ? '今天的' : '这一天的'}时间轴{view ? ` · ${timeline.length} 条记录` : ''}<span>查看时间记录</span></summary><div className="time-history-body">{timeline.length === 0 ? <p className="time-empty">这一页还没有时间记录，从一个时间点或一段投入开始。</p> : <ol className="time-timeline">{timeline.map(entry => <li key={entry.id}><span className="time-entry-icon">{entry.point ? <Flag size={13} /> : <Clock3 size={13} />}</span><div><strong>{entry.title}</strong><span>{entry.detail}</span></div>{entry.point && <button className="icon-button" aria-label={`撤销时间点：${entry.title}`} disabled={busy} onClick={() => { if (window.confirm('撤销这个时间点？实际投入和成果不会改变。')) void save('point-delete', { point_id: entry.id }); }}><Trash2 size={14} /></button>}</li>)}</ol>}</div></details></>}
    {!mode && <>{notice && <p className="time-notice" role="status">{notice}</p>}{errorNode}</>}
    {mode && <dialog ref={dialogRef} className="modal day-modal time-entry-dialog" aria-label={mode === 'point' ? '记录时间点' : '补记时间段'} onCancel={event => { event.preventDefault(); closeEntry(); }}><header className="modal-header"><div><h2>{mode === 'point' ? '记录时间点' : '补记时间段'}</h2><p>{date} · {timezoneLabel}</p></div><button className="icon-button" type="button" aria-label="关闭时间记录" disabled={busy} onClick={closeEntry}><X size={19} /></button></header><form onSubmit={event => void submit(event)}><div className="modal-content"><fieldset disabled={busy}>{mode === 'point' ? <><label className="field"><span className="field-label">发生了什么</span><input required autoFocus maxLength={120} value={label} onChange={event => setLabel(event.target.value)} placeholder="一个念头、一次开始，或值得记住的此刻" /></label><label className="field"><span className="field-label">记录时刻</span><input type="time" required step="1" value={at} onChange={event => setAt(event.target.value)} /></label><p className="quiet-note">时间点只留下时刻和说明，不增加投入分钟。</p></> : <><label className="field"><span className="field-label">所属投入时段</span><select value={periodBlockId} onChange={event => { setSelected(event.target.value); setAcknowledge(false); }}>{allBlocks.map(block => <option value={block.id} key={block.id}>{block.title}</option>)}</select></label><div className="time-range-fields"><label className="field"><span className="field-label">开始时刻</span><input type="time" required step="1" value={from} onChange={event => setFrom(event.target.value)} /></label><label className="field"><span className="field-label">结束时刻</span><input type="time" required step="1" value={to} onChange={event => setTo(event.target.value)} /></label></div>{periodActual && <label className="time-existing-check"><input type="checkbox" checked={acknowledge} onChange={event => setAcknowledge(event.target.checked)} />此时段已有 {periodActual.minutes} 分钟，确认本段未包含在已有累计中</label>}<p className="quiet-note">只记录当天实际投入的时间，休息分开记录。与已有时间段重叠时不会重复入账；跨日请分别补记。</p></>}</fieldset>{errorNode}</div><footer className="modal-footer"><button className="button-primary" disabled={busy}>{busy && <LoaderCircle className="spin" size={14} />}{busy ? '保存中…' : mode === 'point' ? '保存时间点' : '保存时间段'}</button></footer></form></dialog>}
  </section>;
}

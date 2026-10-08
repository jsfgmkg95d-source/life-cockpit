import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, FilePenLine, History, Leaf, ListTodo, LoaderCircle, Plus, RefreshCw, X } from 'lucide-react';
import { METRICS, type AppState, type Project } from '../shared/contracts';
import { DIMENSIONS, DIMENSION_LABELS, EVENT_STAGES, EVENT_STAGE_LABELS, type ActualWrite, type AssetEvent, type CorrectionWrite, type DailyTask, type DayState, type DeltaMetric, type Dimension, type EventInput, type EventStage, type PlanCandidate, type PlanDraft, type PlanSnapshot, type ResultWrite, type WorkBlock } from '../shared/day-contracts';
import { ApiError, errorMessage, request } from './api';
import './day-styles.css';
import ScorePanel from './ScorePanel';
import Dashboard from './Dashboard';
import ReportPanel from './ReportPanel';
import { metricWarning, orderedMetrics } from '../shared/workflow';
import './workflow-styles.css';
import './growth-styles.css';
import WorkTimer from './WorkTimer';
import TaskBoard from './TaskBoard';
import CockpitProjects from './CockpitProjects';
import CockpitInsights from './CockpitInsights';
import HarvestCalendar from './HarvestCalendar';
import OdettePortrait from './OdettePortrait';
import { getOdetteMood } from '../shared/odette-mood';
import { taskBoardState } from '../shared/task-board';
import QuickTaskDialog from './QuickTaskDialog';
import RemoveTaskDialog from './RemoveTaskDialog';
import { removeUnconfirmedCandidate } from '../shared/remove-task';
import { normalizePlanScoring } from '../shared/plan-scoring';
import PlanDimensionSummary from './PlanDimensionSummary';
import ScheduleTimeline from './ScheduleTimeline';
import type { InboxItem, InboxView } from '../shared/inbox-contracts';
import { parseChapters, isChapterMetric, resultDisabled } from '../shared/chapters';
import './daily-focus.css';
import './daily-polish.css';

const DELTA_METRICS = METRICS.filter(metric => metric.key !== 'followers');
const n = (value: string) => value.trim() === '' ? null : Number(value);
const metricLabel = (key: string | null) => METRICS.find(metric => metric.key === key)?.label ?? '未设置指标';
const metricUnit = (key: string | null) => METRICS.find(metric => metric.key === key)?.unit ?? '';
const getRevision = (state: DayState) => state.log?.revision ?? 0;
const currentPlan = (state: DayState) => state.log?.plan_snapshots.find(snapshot => snapshot.plan_version === state.log?.current_plan_version) ?? null;
const projectName = (app: AppState, id: string) => app.projects.find(project => project.id === id)?.name ?? '未知项目';
type WriteDay = (path: string, body: object, revision: number, method?: 'POST' | 'PUT') => Promise<DayState>;
type DialogKind = { kind: 'remove'; task: PlanCandidate; revision: number; draft?: PlanDraft } | { kind: 'plan' } | { kind: 'add'; projectId: string | null; inbox?: InboxItem } | { kind: 'finish'; task: DailyTask } | { kind: 'event'; task?: DailyTask } | { kind: 'result'; task: DailyTask } | { kind: 'actual'; block: WorkBlock } | { kind: 'correct'; event: AssetEvent } | { kind: 'identify'; event: AssetEvent } | { kind: 'history' } | null;
interface TodayProps { initialDate?: string; initialView?: 'tasks' | 'schedule' | 'calendar'; pageTitle?: string; initialInboxItem?: InboxItem | null; initialSelectedTaskId?: string | null; app: AppState; filterProjectId: string | null; onFilter: (id: string | null) => void; onDateChange: (date: string) => void; onDirty: (dirty: boolean) => void; onNotice: (message: string) => void; onProjects: () => void; initialTaskProjectId?: string | null; onTaskEntryHandled: () => void; onProjectsChanged: () => Promise<AppState> }

function calendarDate(timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}-${parts.find(part => part.type === 'day')!.value}`;
}
function asDraft(snapshot: PlanSnapshot): PlanDraft {
  return { day_mode: snapshot.day_mode, available_minutes: snapshot.available_minutes, dimensions: structuredClone(snapshot.dimensions), tasks: snapshot.tasks.map(({ project_name: _name, ...task }) => ({ ...task })), work_blocks: structuredClone(snapshot.work_blocks), change_reason: '', notes: snapshot.notes };
}
function initialDraft(state: DayState) { return structuredClone(state.log?.draft_plan ?? (currentPlan(state) ? asDraft(currentPlan(state)!) : state.suggested_draft)); }
function withCompletionMarkers(draft: PlanDraft): PlanDraft { return { ...draft, tasks: draft.tasks.map(task => ({ ...task, acceptance: task.acceptance.trim() || '由我点击完成' })) }; }
function Field({ label, hint, children, wide = false }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) { return <label className={`field ${wide ? 'span-two' : ''}`}><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>; }
function DayError({ error, onRefresh, busy = false }: { error: unknown; onRefresh?: () => void; busy?: boolean }) {
  if (!error) return null;
  return <div className="inline-error" role="alert"><p>{errorMessage(error)}</p>{error instanceof ApiError && error.fields && <ul>{Object.entries(error.fields).map(([key, message]) => <li key={key}>{message}</li>)}</ul>}{error instanceof ApiError && error.status === 409 && <><p>当前表单仍保留。其他窗口可能更新了当天记录，读取最新内容不会替换你的草稿。</p>{onRefresh && <button className="button-secondary" type="button" onClick={onRefresh} disabled={busy}>读取最新内容作对照</button>}</>}</div>;
}
function DayDialog({ title, description, dirty, busy, onClose, onDirty, children, wide = false }: { title: string; description: string; dirty: boolean; busy: boolean; onClose: () => void; onDirty: (dirty: boolean) => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; const modal = ref.current; modal?.showModal(); return () => { modal?.close(); previous?.focus(); }; }, []);
  useEffect(() => { onDirty(dirty || busy); }, [dirty, busy, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const close = () => { if (busy) return; if (!dirty || window.confirm('还有未保存的内容，确定放弃并关闭吗？')) onClose(); };
  return <dialog ref={ref} className={`modal day-modal ${wide ? 'day-modal-wide' : ''}`} aria-label={title} onCancel={event => { event.preventDefault(); close(); }}><header className="modal-header"><div><h2>{title}</h2><p>{description}</p></div><button type="button" className="icon-button" aria-label="关闭表单" disabled={busy} onClick={close}><X size={19} /></button></header>{children}</dialog>;
}

export default function Today({ initialDate, initialView = 'tasks', pageTitle = '今天', initialInboxItem, initialSelectedTaskId, app, filterProjectId, onFilter, onDateChange, onDirty, onNotice, onProjects, initialTaskProjectId, onTaskEntryHandled, onProjectsChanged }: TodayProps) {
  const [date, setDate] = useState(() => initialDate ?? calendarDate(app.settings.timezone));
  const [state, setState] = useState<DayState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [reportDirty, setReportDirty] = useState(false);
  const [timerDirty, setTimerDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const [focusIntent, setFocusIntent] = useState<{ task: DailyTask; nonce: string } | null>(null);
  const taskBoardRef = useRef<HTMLElement>(null);
  const timerRef = useRef<HTMLDivElement>(null);
  const extraRef = useRef<HTMLDetailsElement>(null);
  const [view, setView] = useState<'tasks' | 'schedule' | 'calendar'>(initialView);
  useEffect(() => { if (initialInboxItem) { setDialog({ kind: 'add', projectId: initialInboxItem.project_id, inbox: initialInboxItem }); setView('tasks'); onTaskEntryHandled(); } }, [initialInboxItem, onTaskEntryHandled]);
  useEffect(() => { if (initialTaskProjectId) { setDialog({ kind: 'add', projectId: initialTaskProjectId }); setView('tasks'); onTaskEntryHandled(); } }, [initialTaskProjectId, onTaskEntryHandled]);
  const viewRoot = useRef<HTMLDivElement>(null);
  const previousView = useRef(view);
  useEffect(() => { if (previousView.current !== view) viewRoot.current?.scrollIntoView({ block: 'start' }); previousView.current = view; }, [view]);
  const [highlightedTaskId, setHighlightedTaskId] = useState<string | null>(null);
  useEffect(() => {
    if (!initialSelectedTaskId || !state || loading) return;
    setView('tasks');
    const timer = window.setTimeout(() => {
      const item = viewRoot.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(initialSelectedTaskId)}"]`);
      item?.closest<HTMLDetailsElement>('.task-list-closed')?.setAttribute('open', '');
      item?.scrollIntoView({ behavior: 'smooth', block: 'center' }); item?.focus({ preventScroll: true });
      setHighlightedTaskId(initialSelectedTaskId); onTaskEntryHandled();
    }, 0);
    return () => clearTimeout(timer);
  }, [initialSelectedTaskId, state, loading, onTaskEntryHandled]);
  useEffect(() => { if (!highlightedTaskId) return; const timer = window.setTimeout(() => setHighlightedTaskId(null), 4000); return () => clearTimeout(timer); }, [highlightedTaskId]);
  const [harvestTaskId, setHarvestTaskId] = useState<string | null>(null);
  const previousHarvestState = useRef<DayState | null>(null);
  const [previous, setPrevious] = useState<{ date: string; draft: PlanDraft } | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateError, setTemplateError] = useState('');
  const keys = useRef(new Map<string, string>());
  const mountedDate = useRef(date);
  mountedDate.current = date;
  const setDirty = useCallback((value: boolean) => setFormDirty(value), []);
  useEffect(() => { onDirty(formDirty || reportDirty || scheduleDirty || timerDirty || busy); }, [formDirty, reportDirty, scheduleDirty, timerDirty, busy, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (formDirty || reportDirty || scheduleDirty || timerDirty || busy) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, [formDirty, reportDirty, scheduleDirty, timerDirty, busy]);
  const load = useCallback(async () => { const data = await request<DayState>(`/api/days/${date}`); if (mountedDate.current === date) setState(data); return data; }, [date]);
  useEffect(() => { let cancelled = false; setLoading(true); setError(null); setState(null); void load().catch(failure => { if (!cancelled) setError(failure); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [load]);
  useEffect(() => {
    const before = previousHarvestState.current; previousHarvestState.current = state;
    if (!state || !before || before.business_date !== state.business_date || state.business_date > calendarDate(app.settings.timezone)) return;
    const harvested = state.tasks.find(task => {
      const prior = before.tasks.find(item => item.task_id === task.task_id);
      return prior && task.status === 'done' && prior.status !== 'done';
    });
    if (harvested) setHarvestTaskId(harvested.task_id);
  }, [state, app.settings.timezone]);
  useEffect(() => {
    let live = true; setPrevious(null); setTemplateError('');
    if (!state || currentPlan(state) || state.log?.draft_plan) { setTemplateLoading(false); return; }
    setTemplateLoading(true);
    void request<{ date: string; draft: PlanDraft } | null>(`/api/days/${date}/previous-plan`).then(value => { if (live) setPrevious(value); }).catch(() => { if (live) setTemplateError('最近安排暂时未读到，先显示当前项目候选。'); }).finally(() => { if (live) setTemplateLoading(false); });
    return () => { live = false; };
  }, [date, state?.log?.revision, Boolean(state)]);
  const write: WriteDay = async (path, body, revision, method = 'POST') => {
    setHarvestTaskId(null);
    const signature = JSON.stringify({ date, path, body, revision });
    const key = keys.current.get(signature) ?? crypto.randomUUID(); keys.current.set(signature, key);
    const response = await request<DayState>(`/api/days/${date}${path}`, method, { ...body, revision, requestId: key });
    try { return await load(); } catch { if (mountedDate.current === date) setState(response); onNotice('内容已保存，最新状态暂未刷新，请稍后重新读取。'); return response; }
  };
  const close = () => { setDialog(null); setFormDirty(false); };
  function changeDate(next: string) { if (!next || busy) return false; if (next === date) return true; if ((formDirty || reportDirty || scheduleDirty || timerDirty) && !window.confirm('切换日期会放弃未保存的表单内容，继续吗？')) return false; close(); setHarvestTaskId(null); setDate(next); onDateChange(next); return true; }
  useEffect(() => { if (initialDate && initialDate !== mountedDate.current && !changeDate(initialDate)) onDateChange(mountedDate.current); }, [initialDate]);
  function focusTask(task: DailyTask) { if (date !== calendarDate(app.settings.timezone)) { setError(new Error('只能为今天的任务启动计时。过去的投入可在专注区补记。')); return; } setFocusIntent({ task, nonce: crypto.randomUUID() }); timerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  function shiftDate(amount: number) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + amount); changeDate(value.toISOString().slice(0, 10)); }
  async function status(task: DailyTask, value: DailyTask['status']) { if (!state || busy) return; setBusy(true); setError(null); try { await write(`/tasks/${encodeURIComponent(task.task_id)}/status`, { status: value }, getRevision(state)); onNotice('任务状态已更新。'); } catch (failure) { setError(failure); } finally { setBusy(false); } }
  async function toggleCompletion(task: DailyTask) {
    if (!state || busy) return;
    const completed = task.status !== 'done';
    setBusy(true); setError(null);
    try {
      await write(`/tasks/${encodeURIComponent(task.task_id)}/completion`, { completed, source: '用户点击', ...(completed ? { marker: task.acceptance.trim() || '由我点击完成' } : {}) }, getRevision(state));
      onNotice(completed ? `已完成：${task.title}` : `已撤销完成：${task.title}`);
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  const plan = state ? currentPlan(state) : null;
  const harvestTask = state?.tasks.find(task => task.task_id === harvestTaskId);
  const harvestResult = harvestTask ? taskBoardState(harvestTask) : null;
  const previewDraft = state?.log?.draft_plan ?? previous?.draft ?? state?.suggested_draft;
  async function startDay() {
    if (!state || !previewDraft || plan || busy || templateLoading) return;
    setBusy(true); setError(null);
    try { await write('/confirm', { draft: withCompletionMarkers(previewDraft), acknowledgeOverCapacity: false }, getRevision(state)); onNotice('今天的任务已确认，可以直接开始工作。'); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  const currentTaskIds = new Set(plan?.tasks.map(task => task.task_id) ?? []);
  const tasks = state?.tasks.filter(task => currentTaskIds.has(task.task_id)) ?? [];
  const completedTasks = tasks.filter(task => task.status === 'done');
  const harvestMood = getOdetteMood({ mode: plan?.day_mode, plannedTasks: tasks.length, completedTasks: completedTasks.length, hasHarvest: (harvestResult?.actual ?? 0) > 0, future: date > calendarDate(app.settings.timezone), past: date < calendarDate(app.settings.timezone) });
  const filteredTasks = tasks.filter(task => !filterProjectId || task.project_id === filterProjectId);
  const blocks = plan?.work_blocks.filter(block => !filterProjectId || filteredTasks.some(task => task.work_block_id === block.id)) ?? [];
  const pinned = new Set(state?.pinned_task_ids ?? []);
  const budget = !plan || plan.work_blocks.some(block => block.budget_minutes === null) ? null : plan.work_blocks.reduce((sum, block) => sum + block.budget_minutes!, 0);
  const actuals = state?.log?.work_block_actuals ?? [];
  const recordedActuals = actuals;
  const historicalBlocks = [...(state?.log?.plan_snapshots ?? [])].reverse().flatMap(snapshot => snapshot.work_blocks);
  const previousBlocks = historicalBlocks.filter((block, index) => historicalBlocks.findIndex(item => item.id === block.id) === index && !plan?.work_blocks.some(item => item.id === block.id));
  const actualTotal = recordedActuals.reduce((sum, actual) => sum + actual.minutes, 0);
  const effective = state?.effective_events.filter(event => !filterProjectId || event.project_id === filterProjectId) ?? [];
  const sourceEvents = state?.events.filter(event => !filterProjectId || event.project_id === filterProjectId) ?? [];
  const superseded = new Set(sourceEvents.map(event => event.supersedes_event_id).filter(Boolean));
  const leaves = sourceEvents.filter(event => !superseded.has(event.id));
  const totals = DELTA_METRICS.map(metric => {
    const events = effective.filter(event => event.metric_key === metric.key);
    const chapters = new Set<string>();
    const unresolved = isChapterMetric(metric.key) && events.some(event => {
      if ((event.chapter_numbers?.length ?? 0) !== event.value) return true;
      return (event.chapter_numbers ?? []).some(chapter => { const key = `${event.project_id}:${chapter}`; if (chapters.has(key)) return true; chapters.add(key); return false; });
    });
    return { ...metric, value: events.reduce((sum, event) => sum + BigInt(event.value ?? 0), 0n).toString(), count: events.length, unresolved };
  }).filter(metric => metric.count > 0);
  return <div ref={viewRoot} className="today-page polished-day planner-day">
    <header className="planner-day-heading"><div><span className="eyebrow">{new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${date}T12:00:00Z`))}</span><h1>{pageTitle}</h1><p>{view === 'schedule' ? '为重要的事留出时间。计划与实际各自清楚。' : '把注意力交给一件事，让今天的投入留下成果。'}</p></div><div className="date-switch"><button className="icon-button" aria-label="前一天" disabled={busy} onClick={() => shiftDate(-1)}><ChevronLeft size={16} /></button><label><span className="sr-only">记录日期</span><input type="date" required value={date} onChange={event => changeDate(event.target.value)} /></label><button className="icon-button" aria-label="后一天" disabled={busy} onClick={() => shiftDate(1)}><ChevronRight size={16} /></button></div></header>
    <DayError error={error} onRefresh={() => void load().then(() => setError(null)).catch(setError)} busy={busy} />
    {state && !loading && <div className="planner-day-metrics" aria-label="今日时间概览"><div><span className="metric-icon metric-icon-plan" aria-hidden="true"><ListTodo size={18} /></span><span>预计投入</span><strong>{budget === null ? '—' : budget}<small>{budget === null ? '' : ' 分钟'}</small></strong></div><div><span className="metric-icon metric-icon-capacity" aria-hidden="true"><CalendarDays size={18} /></span><span>可用时间</span><strong>{plan?.available_minutes ?? '—'}<small>{plan?.available_minutes == null ? '' : ' 分钟'}</small></strong></div><div><span className="metric-icon metric-icon-actual" aria-hidden="true"><Clock3 size={18} /></span><span>已记录实际</span><strong>{recordedActuals.length ? actualTotal : '—'}<small>{recordedActuals.length ? ' 分钟' : ''}</small></strong></div><div><span className="metric-icon metric-icon-results" aria-hidden="true"><Check size={18} /></span><span>已完成任务</span><strong>{completedTasks.length}<small> / {tasks.length} 项</small></strong></div></div>}
    <div className="daily-command-bar planner-tabs"><div className="daily-view-switch" role="group" aria-label="切换每日视图"><button type="button" aria-label="每日任务" aria-pressed={view === 'tasks'} disabled={busy || scheduleDirty} onClick={() => setView('tasks')}><ListTodo size={15} />任务</button><button type="button" aria-label="每日时间轴" aria-pressed={view === 'schedule'} disabled={busy || scheduleDirty} onClick={() => setView('schedule')}><Clock3 size={15} />时间轴</button><button type="button" aria-label="成果日历" aria-pressed={view === 'calendar'} disabled={busy || scheduleDirty} onClick={() => setView('calendar')}><CalendarDays size={15} />成果日历</button></div>{state && !loading && <div className="daily-add-actions"><button className="button-primary" disabled={busy || !app.projects.length} onClick={() => setDialog({ kind: 'add', projectId: filterProjectId })}><Plus size={15} />添加任务</button><details className="daily-options"><summary>更多</summary><div><Field label="项目范围"><select aria-label="项目范围" value={filterProjectId ?? ''} onChange={event => onFilter(event.target.value || null)}><option value="">全部项目</option>{app.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field><button className="button-quiet" disabled={busy} onClick={() => setDialog({ kind: 'plan' })}><FilePenLine size={14} />{state.log?.draft_plan ? '继续未确认草稿' : '调整计划与容量'}</button></div></details></div>}</div>
    {loading ? <div className="empty-state"><LoaderCircle className="spin" size={25} /><p>正在读取这一天的记录…</p></div> : !state ? <div className="empty-state"><p>当天记录暂时无法读取。</p><button className="button-secondary" onClick={() => { setLoading(true); void load().catch(setError).finally(() => setLoading(false)); }}>重试</button></div> : <>
      <div className="planner-day-layout"><div className="planner-main-pane">
        {filterProjectId && <div className="daily-filter-chip"><button className="button-quiet" onClick={() => onFilter(null)}>{projectName(app, filterProjectId)} <X size={12} /></button></div>}
        {view === 'calendar' ? <HarvestCalendar date={date} revision={state.log?.revision ?? 0} onOpenDay={next => { if (changeDate(next)) { onFilter(null); setView('tasks'); } }} /> : view === 'schedule' ? <ScheduleTimeline key={date} date={date} day={state} onChanged={load} onDirty={setScheduleDirty} onFocus={focusTask} /> : <section ref={taskBoardRef} className="day-section board-section planner-task-surface" aria-label="每日任务">
          {harvestTask && harvestTask.status === 'done' && <div className="harvest-reward" role="status" data-mood={harvestMood.mood}><OdettePortrait mood={harvestMood.mood} label={harvestMood.label} size="medium" /><div className="harvest-reward-copy"><strong>已完成一项，为今天留下进展。</strong><p>{harvestMood.message}</p></div></div>}
          {plan && state.log?.draft_plan && <p className="daily-draft-notice">另有未确认草稿，当前已确认任务继续保留。</p>}
          {!plan ? <DraftDayPreview app={app} draft={previewDraft!} sourceDate={state.log?.draft_plan ? null : previous?.date ?? null} saved={Boolean(state.log?.draft_plan)} loading={templateLoading} error={templateError} busy={busy} onEdit={() => setDialog({ kind: 'plan' })} onRemove={task => setDialog({ kind: 'remove', task, revision: getRevision(state), draft: structuredClone(previewDraft!) })} onStart={() => void startDay()} onProjects={onProjects} /> : plan.day_mode === 'rest' ? <div className="day-empty"><Leaf size={25} strokeWidth={1.4} /><div><h3>今天安排休息。</h3><p>计划外成果仍可以记录。</p></div></div> : filteredTasks.length === 0 ? <div className="day-empty"><p>这里还没有今天的任务。添加一项具体行动，或从收件箱安排。</p></div> : <TaskBoard app={app} state={state} tasks={filteredTasks} allTasks={tasks} blocks={blocks} pinned={pinned} busy={busy} filtered={Boolean(filterProjectId)} onFocus={focusTask} onRemove={task => setDialog({ kind: 'remove', task, revision: getRevision(state) })} highlightedTaskId={highlightedTaskId} allowFocus={date === calendarDate(app.settings.timezone)} onStatus={(task, value) => void status(task, value)} onPin={task => { setBusy(true); setError(null); void write(`/tasks/${task.task_id}/pin`, { pinned: !pinned.has(task.task_id) }, getRevision(state)).catch(setError).finally(() => setBusy(false)); }} onFinish={task => void toggleCompletion(task)} onRecord={task => setDialog({ kind: 'finish', task })} onResult={task => setDialog({ kind: 'result', task })} onActual={block => setDialog({ kind: 'actual', block })} />}
        </section>}
        {view === 'tasks' && <CockpitInsights date={date} revision={getRevision(state)} app={app} dayState={state} />}
        {view === 'tasks' && <CockpitProjects app={app} onAdd={projectId => setDialog({ kind: 'add', projectId })} onProjects={onProjects} />}
      </div><aside className="planner-focus-pane" ref={timerRef}><WorkTimer key={`clock-${date}`} state={state} blocks={plan?.work_blocks ?? []} tasks={tasks} focusIntent={focusIntent} onChanged={load} onDirty={setTimerDirty} onAddTask={() => setDialog({ kind: 'add', projectId: filterProjectId })} onOpenResults={() => { if (extraRef.current) extraRef.current.open = true; extraRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} /></aside></div>
      <details ref={extraRef} className="daily-extra" key={`extra-${date}`}><summary>成果与历史记录</summary>
      <div className="day-summary"><div><span className="day-state-label">{!plan ? '尚未确认计划' : plan.day_mode === 'rest' ? '计划休息' : `已确认计划 · v${plan.plan_version}`}</span><p>{plan ? `${completedTasks.length} / ${tasks.length} 项已完成` : state.log?.draft_plan ? '已有草稿，确认后才形成当日承诺。' : '可先准备计划，也可以直接记录计划外成果。'}</p></div><div className="day-summary-number"><strong>{budget === null ? '—' : budget}<small>{budget === null ? '' : ' 分钟'}</small></strong><span>确认计划预算</span></div><div className="day-summary-number"><strong>{recordedActuals.length ? actualTotal : '—'}<small>{recordedActuals.length ? ' 分钟' : ''}</small></strong><span>{recordedActuals.length ? `已记录实际投入 · 共 ${recordedActuals.length} 段` : '实际投入未记录'}</span></div><div className="day-summary-actions"><button className="button-primary" disabled={busy} onClick={() => setDialog({ kind: 'plan' })}><FilePenLine size={15} />{plan ? '调整计划' : state.log?.draft_plan ? '继续编辑草稿' : '准备今日计划'}</button>{state.log?.plan_snapshots.length ? <button className="button-quiet" onClick={() => setDialog({ kind: 'history' })}><History size={13} />查看计划版本</button> : null}</div></div>
      <section className="day-section"><div className="day-section-heading"><div><span className="eyebrow">WHAT ACTUALLY HAPPENED</span><h2>{date} 的成果记录</h2></div><button className="button-secondary" onClick={() => setDialog({ kind: 'event' })}><Plus size={14} />记录成果</button></div><p className="day-subtle">来源是用户确认的记录。提交、审核与公开分别保存；更正保留原记录。</p>{totals.length > 0 && <div className="metric-totals">{totals.map(metric => <div key={metric.key}><span>{metric.label}</span><strong>{metric.unresolved ? '待核对' : metric.value} <small>{metric.unresolved ? `账面 ${metric.value}${metric.unit}，可能重叠` : metric.unit}</small></strong></div>)}</div>}{leaves.length === 0 ? <div className="day-empty"><FilePenLine size={24} strokeWidth={1.4} /><div><h3>这一天还没有成果记录。</h3><p>空白表示尚未记录，不能据此判断没有推进。</p></div></div> : <div className="events-list">{leaves.map(event => <article className={`event-item ${event.change_kind === 'void' ? 'event-void' : ''}`} key={event.id}><div className="event-topline"><span>{projectName(app, event.project_id)} · {EVENT_STAGE_LABELS[event.stage]}</span><span>{event.change_kind === 'void' ? '已撤销' : `${metricLabel(event.metric_key)} ${event.value} ${metricUnit(event.metric_key)}`}</span></div><h3>{event.summary}</h3><details className="event-history"><summary>来源与章节身份{isChapterMetric(event.metric_key) && !event.chapter_numbers?.length ? ' · 章号待核对' : ''}</summary><p className="day-subtle">成果标识：{event.artifact_key} · 来源：{event.source} · 用户确认</p>{!!event.chapter_numbers?.length && <p>章号：{event.chapter_numbers.join(', ')}</p>}{event.evidence_sources?.map((source,i) => <p key={i}>{source}</p>)}</details><div className="event-actions"><span>{event.task_id ? '关联计划任务' : '计划外成果'} · {event.occurred_on}（按日期记录）</span>{event.change_kind !== 'void' && isChapterMetric(event.metric_key) && !event.chapter_numbers?.length && !!event.value && <button className="button-quiet" onClick={() => setDialog({ kind: 'identify', event })}>核对章节</button>}<button className="button-quiet" onClick={() => setDialog({ kind: 'correct', event })}>{event.change_kind === 'void' ? '恢复这项记录' : '更正或撤销'}</button></div><details className="event-history"><summary><History size={12} />查看记录历史</summary>{sourceEvents.filter(item => item.root_event_id === event.root_event_id).map(item => <div key={item.id}><span>{item.change_kind === 'record' ? '原始记录' : item.change_kind === 'replace' ? '更正 / 恢复' : '撤销'}</span><p>{item.value === null ? '不参与当前汇总' : `${item.value} ${metricUnit(item.metric_key)}`} · {item.summary}</p><small>{item.correction_reason ? `原因：${item.correction_reason} · ` : ''}来源：{item.source} · 记录于 {new Date(item.created_at).toLocaleString('zh-CN', { timeZone: state.timezone })}</small></div>)}</details></article>)}</div>}</section>
      {previousBlocks.length > 0 && <section className="day-section"><div className="day-section-heading"><h2>原计划实际投入</h2></div><p className="day-subtle">这些时段已从当前计划移除，实际发生的时间仍属于当天。可以补录、查看或更正，不会重复累计。</p><div className="budget-list">{previousBlocks.map(block => { const actual = actuals.find(item => item.block_id === block.id); return <div key={block.id}><span>{block.title}<small>原计划投入</small></span><button className="button-quiet" onClick={() => setDialog({ kind: 'actual', block })}>{actual ? `${actual.minutes} 分钟 · 查看 / 更正` : '未记录 · 补记实际投入'}</button></div>; })}</div></section>}
      <details className="secondary-panel"><summary>经营概览与近七天趋势</summary><Dashboard date={date} revision={getRevision(state)} onDate={changeDate} /></details>
      <details className="secondary-panel"><summary>计划建议与履约评分</summary><ReportPanel key={`plan-${date}`} date={date} type="plan" revision={getRevision(state)} onDirty={setReportDirty} onChanged={() => void load().catch(setError)} onWork={targetDate => { if (targetDate === date) void load().then(() => setDialog({ kind: 'plan' })).catch(setError); else changeDate(targetDate); }} /><ScorePanel key={date} date={date} revision={getRevision(state)} onChanged={() => void load().catch(setError)} /><div className="quiet-note">计划履约分依据已确认结果计算；经营报告可在“复盘”中生成。</div></details>
      </details>
      {dialog?.kind === 'plan' && <PlanEditor state={state} app={app} write={write} refresh={load} onClose={close} onDirty={setDirty} onNotice={onNotice} />}
      {dialog?.kind === 'add' && <QuickTaskDialog state={state} app={app} initialProjectId={dialog.projectId} initialTitle={dialog.inbox?.title} initialMinutes={dialog.inbox?.estimated_minutes} onSave={(input, revision) => write(dialog.inbox ? '/inbox-promote' : '/quick-task', dialog.inbox ? { ...input, inbox_id: dialog.inbox.id, inbox_revision: dialog.inbox.revision } : input, revision)} onRefresh={async () => { const [nextApp, nextDay, inbox] = await Promise.all([onProjectsChanged(), load(), dialog.inbox ? request<InboxView>('/api/inbox') : Promise.resolve(null)]); const updated = inbox?.items.find(item => item.id === dialog.inbox?.id); if (updated) setDialog({ ...dialog, inbox: updated }); return { app: nextApp, state: nextDay }; }} onClose={close} onDirty={setDirty} onNotice={onNotice} onAdded={() => { onFilter(null); close(); void onProjectsChanged().catch(() => onNotice('任务已添加，项目列表暂未刷新，请重新打开应用读取。')); }} />}
      {dialog?.kind === 'remove' && <RemoveTaskDialog date={date} title={dialog.task.title} project={projectName(app, dialog.task.project_id)} confirmed={!dialog.draft} lastTask={(dialog.draft?.tasks.length ?? tasks.length) === 1} onDirty={setDirty} onClose={close} onRefresh={load} onRemove={async reason => { if (dialog.draft) await write('/draft', { draft: removeUnconfirmedCandidate(dialog.draft, dialog.task.candidate_id) }, dialog.revision, 'PUT'); else await write(`/tasks/${encodeURIComponent(dialog.task.task_id!)}/remove`, { reason }, dialog.revision); onNotice(dialog.draft ? '已从当天草稿移除。' : '已从当天移除，成果和实际用时已保留。'); }} />}
      {dialog?.kind === 'finish' && <FinishEditor state={state} app={app} task={dialog.task} write={write} refresh={load} onClose={close} onDirty={setDirty} onNotice={onNotice} />}
      {dialog?.kind === 'event' && <EventEditor state={state} app={app} task={dialog.task} initialProjectId={filterProjectId} write={write} refresh={load} onClose={close} onDirty={setDirty} onNotice={onNotice} />}
      {dialog?.kind === 'result' && <ResultEditor state={state} task={dialog.task} write={write} refresh={load} onClose={close} onDirty={setDirty} onNotice={onNotice} />}
      {dialog?.kind === 'actual' && <ActualEditor state={state} block={dialog.block} write={write} refresh={load} onClose={close} onDirty={setDirty} onNotice={onNotice} />}
      {dialog?.kind === 'correct' && <CorrectionEditor state={state} event={dialog.event} app={app} write={write} refresh={load} onClose={close} onDirty={setDirty} onNotice={onNotice} />}
      {dialog?.kind === 'identify' && <IdentifyEditor state={state} event={dialog.event} write={write} refresh={load} onClose={close} onDirty={setDirty} onNotice={onNotice} />}
      {dialog?.kind === 'history' && <DayDialog title="计划版本" description="过去的承诺与调整原因都会保留，不随当前计划被覆盖。" dirty={false} busy={false} onClose={close} onDirty={setDirty} wide><div className="modal-content"><PlanHistory snapshots={state.log?.plan_snapshots ?? []} /></div></DayDialog>}

    </>}
  </div>;
}

function DraftDayPreview({ app, draft, sourceDate, saved, loading, error, busy, onEdit, onRemove, onStart, onProjects }: { app: AppState; draft: PlanDraft; sourceDate: string | null; saved: boolean; loading: boolean; error: string; busy: boolean; onEdit: () => void; onRemove: (task: PlanCandidate) => void; onStart: () => void; onProjects: () => void }) {
  if (loading) return <div className="day-empty"><LoaderCircle size={20} className="spin" /><p>正在读取最近安排…</p></div>;
  if (draft.day_mode === 'work' && draft.tasks.length === 0) {
    const available = app.projects.some(project => project.status === 'active' || project.status === 'preparing');
    return <section className="day-prepare" aria-label="今日安排为空"><h2>从一件事开始</h2><p className="draft-source-note">{app.projects.length ? '添加一项你想做的事。' : '先建立一个项目。'}</p>{!available && app.projects.length > 0 && <p className="draft-source-note">项目已暂停或结束，添加任务时可恢复所选项目。</p>}<footer className="day-prepare-footer"><button className="button-quiet" disabled={busy} onClick={onEdit}>安排整天 / 休息</button>{!app.projects.length && <button className="button-primary" disabled={busy} onClick={onProjects}>建立项目</button>}</footer></section>;
  }
  const total = draft.work_blocks.reduce((sum, block) => sum + (block.budget_minutes ?? 0), 0);
  const ready = draft.day_mode === 'rest' || (draft.tasks.length > 0 && draft.available_minutes !== null && total <= draft.available_minutes && draft.work_blocks.every(block => block.budget_minutes !== null) && draft.tasks.every(task => task.title.trim() && (task.result_type === 'binary' || (task.metric_key && (task.target_value ?? 0) > 0))));
  const renderTask = (task: PlanDraft['tasks'][number], index: number) => {
    const block = draft.work_blocks.find(item => item.id === task.work_block_id);
    const shared = draft.tasks.filter(item => item.work_block_id === task.work_block_id).length > 1;
    return <article className="day-draft-card" key={task.candidate_id}>
      <span className="draft-task-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
      <div className="draft-task-copy"><span className="draft-project-name">{projectName(app, task.project_id)}</span><h3>{task.title || '行动待填'}</h3><p>{task.acceptance || '由我点击完成'}</p></div>
      <small>{shared ? '共享 ' : ''}{block?.budget_minutes ?? '待填'} 分钟{task.result_type === 'quant' && <span>{task.target_value ?? '待填'} {metricUnit(task.metric_key)}</span>}</small><button type="button" className="button-quiet draft-remove-action" disabled={busy} aria-label={`从当天草稿移除：${task.title}`} onClick={() => onRemove(task)}>移除</button>
    </article>;
  };
  return <section className="daily-template-choice day-prepare" aria-label="待确认的今日安排">
    <header className="draft-preview-heading"><div><span className="draft-preview-kicker">{saved ? '继续未确认草稿' : sourceDate ? `沿用 ${sourceDate.slice(5).replace('-', '/')} 的安排` : '从项目建议开始'}</span><h2>{draft.day_mode === 'rest' ? '给今天留一点休息' : '今天，从这些行动开始'}</h2></div><span className="draft-preview-badge">待确认{draft.day_mode === 'work' ? ` · ${draft.tasks.length} 项` : ''}</span></header>
    <p className="draft-source-note">{draft.day_mode === 'rest' ? '核对并确认后，今天会按休息日安排。' : '核对并确认后，才会加入当天任务。'}</p>
    {error && <p className="draft-source-note" role="status">{error}</p>}
    <div className="day-draft-grid">{draft.tasks.slice(0, 3).map(renderTask)}</div>
    {draft.tasks.length > 3 && <details className="draft-preview-more"><summary>查看另外 {draft.tasks.length - 3} 项行动</summary><div className="day-draft-grid">{draft.tasks.slice(3).map((task, index) => renderTask(task, index + 3))}</div></details>}
    <footer className="day-prepare-footer"><div>{draft.day_mode === 'rest' ? <p>休息日不计分。</p> : <p>{draft.work_blocks.some(block => block.budget_minutes === null) ? '预计时间待补全' : `预计 ${total} 分钟`}<span> · 可用 {draft.available_minutes ?? '待填'} 分钟</span></p>}{!ready && <p className="draft-missing">{draft.available_minutes !== null && total > draft.available_minutes ? '超出可用时间 ' + (total - draft.available_minutes) + ' 分钟，需调整或明确确认超额。' : '补全行动和时间后即可确认。'}</p>}</div><div><button className="button-secondary" disabled={busy} onClick={onEdit}>{ready ? '修改安排' : '补全安排'}</button>{ready && <button className="button-primary" disabled={busy} onClick={onStart}>{busy && <LoaderCircle size={14} className="spin" />}{draft.day_mode === 'rest' ? '确认休息' : '确认安排'}<ArrowRight size={14} /></button>}</div></footer>
  </section>;
}

interface EditorProps { state: DayState; write: WriteDay; refresh: () => Promise<DayState>; onClose: () => void; onDirty: (dirty: boolean) => void; onNotice: (message: string) => void }
function useEditor(base: DayState) {
  const [revision, setRevision] = useState(getRevision(base));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [latest, setLatest] = useState<DayState | null>(null);
  async function compare(refresh: () => Promise<DayState>) { setBusy(true); try { setLatest(await refresh()); } catch (failure) { setError(failure); } finally { setBusy(false); } }
  return { revision, setRevision, busy, setBusy, error, setError, latest, compare };
}
function LatestNotice({ latest }: { latest: DayState | null }) { return latest && <div className="latest-notice"><strong>已读取最新记录 · 版本 {getRevision(latest)}</strong><p>{latest.log?.current_plan_version ? `当前确认计划 v${latest.log.current_plan_version}` : '尚无确认计划'} · {latest.effective_events.length} 条有效成果。你的表单仍使用打开时的版本；请对照后关闭并重新打开，或明确选择重新载入。</p>{currentPlan(latest) && <PlanHistory snapshots={[currentPlan(latest)!]} />}</div>; }

function PlanHistory({ snapshots }: { snapshots: PlanSnapshot[] }) { return <div className="plan-history">{[...snapshots].reverse().map(snapshot => <details key={snapshot.plan_version} open={snapshots.length === 1}><summary>v{snapshot.plan_version} · {snapshot.day_mode === 'rest' ? '计划休息' : `${snapshot.tasks.length} 项承诺`}<span>{snapshot.confirmed_at.slice(0, 10)}</span></summary><p className="day-subtle">{snapshot.previous_plan_version ? `由 v${snapshot.previous_plan_version} 调整：${snapshot.change_reason}` : '首次确认'} · 可用 {snapshot.available_minutes ?? '未填写'} 分钟</p>{snapshot.work_blocks.map(block => <p className="history-block" key={block.id}>{block.title} · 预算 {block.budget_minutes ?? '未知'} 分钟</p>)}{snapshot.tasks.map(task => <div className="history-task" key={task.task_id}><strong>{task.project_name} · {task.title}</strong><p>{task.acceptance}</p><small>{task.result_type === 'binary' ? '由我点击完成' : `目标 ${task.target_value} ${metricUnit(task.metric_key)}`} · {DIMENSION_LABELS[task.scoring_dimension]}权重 {task.raw_points}</small></div>)}</details>)}</div>; }
function PlanChanges({ original, draft, app }: { original: PlanSnapshot | null; draft: PlanDraft; app: AppState }) {
  if (!original) return null;
  const changes: { label: string; before: string; after: string }[] = [];
  if (original.day_mode !== draft.day_mode) changes.push({ label: '日类型', before: original.day_mode === 'rest' ? '休息' : '工作', after: draft.day_mode === 'rest' ? '休息' : '工作' });
  if (original.available_minutes !== draft.available_minutes) changes.push({ label: '可用容量', before: `${original.available_minutes ?? '未知'} 分钟`, after: `${draft.available_minutes ?? '未知'} 分钟` });
  for (const dimension of DIMENSIONS) if (JSON.stringify(original.dimensions[dimension]) !== JSON.stringify(draft.dimensions[dimension])) changes.push({ label: DIMENSION_LABELS[dimension], before: original.dimensions[dimension].applicable ? '适用' : `不适用：${original.dimensions[dimension].reason}`, after: draft.dimensions[dimension].applicable ? '适用' : `不适用：${draft.dimensions[dimension].reason}` });
  const summarize = (task: PlanCandidate) => `${projectName(app, task.project_id)} · ${task.title || '未填行动'}；完成标志：${task.acceptance || '由我点击完成'}；${task.result_type === 'quant' ? '数量记录' : '由我点击完成'} / ${metricLabel(task.metric_key)}，目标 ${task.target_value ?? '未知'}，${DIMENSION_LABELS[task.scoring_dimension]}权重 ${task.raw_points}`;
  for (const previous of original.tasks) { const next = draft.tasks.find(task => task.candidate_id === previous.candidate_id); if (!next) changes.push({ label: '移除承诺', before: summarize(previous), after: '移出当前版本，历史保留' }); else if (summarize(previous) !== summarize(next) || previous.work_block_id !== next.work_block_id || previous.estimated_minutes !== next.estimated_minutes) changes.push({ label: '调整承诺', before: summarize(previous), after: summarize(next) }); }
  for (const task of draft.tasks.filter(task => !original.tasks.some(previous => previous.candidate_id === task.candidate_id))) changes.push({ label: '新增承诺', before: '无', after: summarize(task) });
  if (JSON.stringify(original.work_blocks) !== JSON.stringify(draft.work_blocks)) changes.push({ label: '投入时段', before: original.work_blocks.map(block => `${block.title} ${block.budget_minutes ?? '?'}分`).join('；'), after: draft.work_blocks.map(block => `${block.title} ${block.budget_minutes ?? '?'}分`).join('；') || '无' });
  if (original.notes !== draft.notes) changes.push({ label: '计划备注', before: original.notes || '空', after: draft.notes || '空' });
  return <section className="change-preview"><h3>相对 v{original.plan_version} 的变更预览</h3>{changes.length ? changes.map((change, index) => <div key={index}><strong>{change.label}</strong><p><del>{change.before}</del></p><p>{change.after}</p></div>) : <p>尚未改变任务、预算或适用维度。</p>}</section>;
}

function PlanEditor(props: EditorProps & { app: AppState }) {
  const { state, app, write, refresh, onClose, onDirty, onNotice } = props;
  const editor = useEditor(state);
  const [draft, setDraft] = useState(() => initialDraft(state));
  const [baseline, setBaseline] = useState(() => JSON.stringify(initialDraft(state)));
  const [ack, setAck] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [templateDate, setTemplateDate] = useState('');
  const previousWork = useRef<PlanDraft | null>(null);
  const original = currentPlan(state);
  const dirty = JSON.stringify(draft) !== baseline;
  const draftTouched = useRef(false); draftTouched.current = dirty;
  useEffect(() => {
    if (original || state.log?.draft_plan) return;
    let live = true;
    void request<{date: string; draft: PlanDraft} | null>(`/api/days/${state.business_date}/previous-plan`).then(previous => {
      if (live && previous && !draftTouched.current) { setDraft(previous.draft); setBaseline(JSON.stringify(previous.draft)); setTemplateDate(previous.date); }
    }).catch(() => { /* The current project draft remains usable when no template can be loaded. */ });
    return () => { live = false; };
  }, []);
  const budget = draft.work_blocks.reduce((sum, block) => sum + (block.budget_minutes ?? 0), 0);
  const over = draft.available_minutes !== null && budget > draft.available_minutes;
  const scoring = useMemo(() => {
    try { return { draft: normalizePlanScoring(draft), error: '' }; }
    catch (error) { return { draft: null, error: errorMessage(error) }; }
  }, [draft]);
  const patchTask = (id: string, patch: Partial<PlanCandidate>) => setDraft(current => ({ ...current, tasks: current.tasks.map(task => task.candidate_id === id ? { ...task, ...patch } : task) }));
  const patchBlock = (id: string, patch: Partial<WorkBlock>) => setDraft(current => ({ ...current, work_blocks: current.work_blocks.map(block => block.id === id ? { ...block, ...patch } : block) }));
  const removeTask = (id: string) => setDraft(current => removeUnconfirmedCandidate(current, id));
  function mode(value: 'work' | 'rest') {
    if (value === 'rest') { previousWork.current = structuredClone(draft); setDraft(current => ({ ...current, day_mode: 'rest', tasks: [], work_blocks: [], dimensions: Object.fromEntries(DIMENSIONS.map(dimension => [dimension, { applicable: false, reason: '计划休息' }])) as PlanDraft['dimensions'] })); }
    else { const restored = previousWork.current ?? state.suggested_draft; setDraft(current => ({ ...structuredClone(restored), day_mode: 'work', change_reason: current.change_reason })); }
  }
  function addTask() { const project = app.projects.find(item => item.status === 'active' || item.status === 'preparing'); if (!project) { editor.setError(new Error('没有可安排的活跃或准备中项目，请先在项目页创建或恢复项目。')); return; } const blockId = crypto.randomUUID(); const task: PlanCandidate = { candidate_id: crypto.randomUUID(), task_id: null, project_id: project.id, title: '', acceptance: '', result_type: 'binary', metric_key: null, target_value: 1, scoring_dimension: project.operating_role === 'cashflow' ? 'cashflow' : project.operating_role === 'maintenance' ? (project.primary_metric_key === 'learning_outputs' ? 'learning' : 'health') : 'asset', raw_points: 0, estimated_minutes: null, work_block_id: blockId }; setDraft(current => ({ ...current, tasks: [...current.tasks, task], work_blocks: [...current.work_blocks, { id: blockId, title: `${project.name}投入`, budget_minutes: null }] })); }
  async function save(confirm: boolean) { if (editor.busy) return; editor.setBusy(true); editor.setError(null); try { const data = await write(confirm ? '/confirm' : '/draft', confirm ? { draft: withCompletionMarkers(normalizePlanScoring(draft)), acknowledgeOverCapacity: ack } : { draft }, editor.revision, confirm ? 'POST' : 'PUT'); editor.setRevision(getRevision(data)); setBaseline(JSON.stringify(draft)); onNotice(confirm ? '计划已确认，原计划版本已保留。' : '计划草稿已保存，还未形成当天承诺。'); onClose(); } catch (failure) { setAdvanced(true); editor.setError(failure); } finally { editor.setBusy(false); } }
  async function reusePlan() {
    if (dirty && !window.confirm('替换当前未保存草稿，沿用最近一次工作安排吗？')) return;
    editor.setBusy(true); editor.setError(null);
    try {
      const previous = await request<{ date: string; draft: PlanDraft } | null>(`/api/days/${state.business_date}/previous-plan`);
      if (!previous) { editor.setError(new Error('还没有更早的工作计划。首次填写后，后续日期即可沿用。')); return; }
      setDraft(previous.draft); setTemplateDate(previous.date); setAck(false);
    } catch (failure) { editor.setError(failure); } finally { editor.setBusy(false); }
  }
  function adoptLatest() { if (!editor.latest || !window.confirm('使用最新计划会替换当前未保存草稿，继续吗？')) return; const next = initialDraft(editor.latest); setDraft(next); setBaseline(JSON.stringify(next)); editor.setRevision(getRevision(editor.latest)); editor.setError(null); setAck(false); }
  return <DayDialog title={original ? `调整 ${state.business_date} 的计划` : `准备 ${state.business_date} 的计划`} description="安排今天要做的事，完成标志由你决定。预算不代表实际投入。" dirty={dirty} busy={editor.busy} onClose={onClose} onDirty={onDirty} wide><form onSubmit={event => { event.preventDefault(); void save(true); }}><div className="modal-content"><DayError error={editor.error} onRefresh={() => void editor.compare(refresh)} busy={editor.busy} /><LatestNotice latest={editor.latest} />{editor.latest && <button type="button" className="button-secondary" onClick={adoptLatest}>放弃当前草稿，使用最新计划</button>}<fieldset disabled={editor.busy}>{!original && <div className="reuse-plan"><button type="button" className="button-secondary" onClick={() => void reusePlan()}>沿用最近工作安排</button><p className="field-hint">{templateDate ? `已带入 ${templateDate} 的安排。请更新今天的稿件批次、目标与容量，再确认。` : '只带入安排与预算，不复制成果、完成状态或实际耗时。'}</p></div>}<div className="form-grid"><Field label="日类型" hint="切换仅调整草稿，确认后才生效；切回工作可恢复本次草稿。"><select value={draft.day_mode} onChange={event => mode(event.target.value as 'work' | 'rest')}><option value="work">工作日</option><option value="rest">计划休息</option></select></Field><Field label="可用容量（分钟）" hint="未知可以保存草稿；工作日确认前必须填写。"><input type="number" min="0" step="1" value={draft.available_minutes ?? ''} onChange={event => { setDraft(current => ({ ...current, available_minutes: n(event.target.value) })); setAck(false); }} /></Field></div>{draft.day_mode === 'work' && <><button type="button" className="button-quiet" onClick={() => setAdvanced(value => !value)}>{advanced ? '收起评分与时段高级设置' : '评分与时段高级设置'}</button><p className="field-hint">评分维度随当天任务自动调整，无需手动凑分。</p>{scoring.error && <p className="inline-error" role="alert">{scoring.error}</p>}{advanced && scoring.draft && <PlanDimensionSummary draft={scoring.draft} />}<details className="plan-time-budget" open={advanced}><summary>投入时段 · 总预算 {budget} 分钟 · 按需调整</summary><p className="field-hint">共享时间只累计一次。</p><div className="plan-block-editor">{draft.work_blocks.map(block => <div key={block.id}><Field label="时段名称"><input value={block.title} onChange={event => patchBlock(block.id, { title: event.target.value })} /></Field><Field label="预算（分钟）"><input type="number" min="0" step="1" value={block.budget_minutes ?? ''} onChange={event => { patchBlock(block.id, { budget_minutes: n(event.target.value) }); setAck(false); }} /></Field><span>{draft.tasks.filter(task => task.work_block_id === block.id).length} 项任务</span>{!draft.tasks.some(task => task.work_block_id === block.id) && <button type="button" className="button-quiet" onClick={() => setDraft(current => ({ ...current, work_blocks: current.work_blocks.filter(item => item.id !== block.id) }))}>移除空时段</button>}</div>)}</div></details><h3 className="form-section-title">任务与完成标志</h3>{draft.tasks.map((task, index) => <details className="plan-task-editor" key={task.candidate_id} open={advanced || index === 0}><summary><strong>{String(index + 1).padStart(2, '0')} · {projectName(app, task.project_id)}</strong><span className="plan-task-preview">{task.acceptance ? `${task.title} · ${task.result_type === 'quant' ? `${task.target_value ?? '?'} ${metricUnit(task.metric_key)}` : '达成 / 未达成'}` : '验收待填写'}</span></summary><button type="button" className="button-quiet" onClick={() => removeTask(task.candidate_id)}>移出草稿</button><div className="form-grid">{advanced && <><Field label="所属项目"><select value={task.project_id} onChange={event => patchTask(task.candidate_id, { project_id: event.target.value })}>{app.projects.filter(project => ['preparing', 'active'].includes(project.status) || project.id === task.project_id).map(project => <option key={project.id} value={project.id}>{project.name}{['preparing', 'active'].includes(project.status) ? '' : '（当前不可新增安排）'}</option>)}</select></Field><Field label="投入时段"><select value={task.work_block_id} onChange={event => patchTask(task.candidate_id, { work_block_id: event.target.value })}>{draft.work_blocks.map(block => <option key={block.id} value={block.id}>{block.title || '未命名时段'}</option>)}</select></Field></>}<Field label="具体行动" wide><input value={task.title} maxLength={240} placeholder="今天准备推进的具体动作" onChange={event => patchTask(task.candidate_id, { title: event.target.value })} /></Field><Field label="完成标志（选填）" wide hint="留空就由你点击完成。"><textarea value={task.acceptance} maxLength={2000} placeholder="例如我写完这一章，或我的脚本返回成功" onChange={event => patchTask(task.candidate_id, { acceptance: event.target.value })} /></Field><Field label="数量记录"><select value={task.result_type} onChange={event => patchTask(task.candidate_id, { result_type: event.target.value as 'quant' | 'binary', target_value: event.target.value === 'binary' ? 1 : null })}><option value="binary">不记录数量</option><option value="quant">设置目标数量</option></select></Field><Field label="成果指标"><select value={task.metric_key ?? ''} onChange={event => patchTask(task.candidate_id, { metric_key: (event.target.value || null) as DeltaMetric | null })}><option value="">暂未选择</option>{orderedMetrics(app.projects.find(project => project.id === task.project_id)).map(metric => <option key={metric.key} value={metric.key}>{metric.label} · {metric.unit}</option>)}</select></Field>{task.result_type === 'quant' ? <Field label={`目标量（${metricUnit(task.metric_key) || '请先选择指标'}）`}><input type="number" min="1" step="1" value={task.target_value ?? ''} onChange={event => patchTask(task.candidate_id, { target_value: n(event.target.value) })} /></Field> : <p className="field-hint binary-hint">无需记录数量，做完后点击完成。</p>}{advanced && <><Field label="评分维度"><select value={task.scoring_dimension} onChange={event => patchTask(task.candidate_id, { scoring_dimension: event.target.value as Dimension })}>{DIMENSIONS.map(dimension => <option key={dimension} value={dimension}>{DIMENSION_LABELS[dimension]}</option>)}</select></Field><Field label="相对权重（选填）" hint="留空自动分配；填写后按同维度比例分配，无需凑满固定分数。"><input type="number" min="0" max="100" step="1" value={task.raw_points || ''} onChange={event => patchTask(task.candidate_id, { raw_points: Number(event.target.value) })} /></Field><Field label="单项估时（选填）" hint="共享时段未拆分时留空，不把组预算复制给每项任务。"><input type="number" min="0" step="1" value={task.estimated_minutes ?? ''} onChange={event => patchTask(task.candidate_id, { estimated_minutes: n(event.target.value) })} /></Field></>}{metricWarning(app.projects.find(project => project.id === task.project_id), task.metric_key, task.acceptance) && <p className="metric-warning span-two">{metricWarning(app.projects.find(project => project.id === task.project_id), task.metric_key, task.acceptance)}</p>}</div></details>)}<button type="button" className="button-secondary" onClick={addTask}><Plus size={14} />添加任务与时段</button><p className="plan-budget-summary">总预算 {budget} 分钟 · {draft.available_minutes === null ? '可用容量待填写' : over ? `超出可用容量 ${budget - draft.available_minutes} 分钟` : `剩余 ${draft.available_minutes - budget} 分钟`}</p>{over && <label className="checkbox-label capacity-ack"><input type="checkbox" checked={ack} onChange={event => setAck(event.target.checked)} />我已看到超出容量，仍决定保留这份安排。</label>}</>}<Field label="计划备注（选填)" wide><textarea value={draft.notes} onChange={event => setDraft(current => ({ ...current, notes: event.target.value }))} /></Field>{original && <><PlanChanges original={original} draft={scoring.draft ?? draft} app={app} /><Field label="调整原因" hint="目标、完成标志、任务、适用维度或日类型变化都需要留下原因。"><textarea value={draft.change_reason} onChange={event => setDraft(current => ({ ...current, change_reason: event.target.value }))} /></Field></>}</fieldset></div><footer className="modal-footer"><span className="save-note">确认后按此计划计算履约分</span><button type="button" className="button-secondary" disabled={editor.busy} onClick={() => void save(false)}>保存草稿</button><button className="button-primary" disabled={editor.busy || (over && !ack)}>{editor.busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}确认{original ? '调整' : '计划'}</button></footer></form></DayDialog>;
}

function defaultStage(metric: DeltaMetric): EventStage { return metric.startsWith('published_') ? 'published' : metric === 'submission_batches' ? 'submitted' : metric.startsWith('accepted_') ? 'finalized' : 'completed'; }
function EventEditor({ state, app, task, initialProjectId, write, refresh, onClose, onDirty, onNotice }: EditorProps & { app: AppState; task?: DailyTask; initialProjectId: string | null }) {
  const editor = useEditor(state);
  const [event, setEvent] = useState<EventInput>(() => { const metric = task?.metric_key ?? orderedMetrics(app.projects.find(project => project.id === (initialProjectId ?? app.projects[0]?.id)))[0].key as DeltaMetric; return { project_id: task?.project_id ?? initialProjectId ?? app.projects[0]?.id ?? '', task_id: task?.task_id ?? null, artifact_key: '', metric_key: metric, value: 1, stage: defaultStage(metric), summary: '', source: '用户自报' }; });
  const [chapterText, setChapterText] = useState('');
  const [initial] = useState(() => JSON.stringify(event));
  const dirty = JSON.stringify(event) !== initial || !!chapterText;
  const patch = (change: Partial<EventInput>) => { setEvent(current => ({ ...current, ...change })); };
  const eligibleTasks = state.tasks.filter(item => item.project_id === event.project_id && currentPlan(state)?.tasks.some(snapshot => snapshot.task_id === item.task_id));
  async function submit(form: FormEvent) { form.preventDefault(); if (editor.busy) return; editor.setBusy(true); editor.setError(null); try { await write('/events', { event: { ...event, chapter_numbers: isChapterMetric(event.metric_key) ? parseChapters(chapterText) : [] } }, editor.revision); onNotice('成果已记录。'); onClose(); } catch (failure) { editor.setError(failure); } finally { editor.setBusy(false); } }
  return <DayDialog title="记录一项实际成果" description={`${state.business_date} · 发生日期按天记录，不推定具体时间。`} dirty={dirty} busy={editor.busy} onClose={onClose} onDirty={onDirty}><form onSubmit={form => void submit(form)}><div className="modal-content"><DayError error={editor.error} onRefresh={() => void editor.compare(refresh)} /><LatestNotice latest={editor.latest} /><fieldset disabled={editor.busy}><div className="form-grid"><Field label="所属项目"><select required value={event.project_id} onChange={change => { const metric = orderedMetrics(app.projects.find(project => project.id === change.target.value))[0].key as DeltaMetric; patch({ project_id: change.target.value, task_id: null, metric_key: metric, stage: defaultStage(metric) }); }}>{app.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></Field><Field label="关联任务"><select value={event.task_id ?? ''} onChange={change => { const linked = eligibleTasks.find(item => item.task_id === change.target.value); patch({ task_id: linked?.task_id ?? null, ...(linked?.metric_key ? { metric_key: linked.metric_key, stage: defaultStage(linked.metric_key) } : {}) }); }}><option value="">计划外成果（不增加承诺）</option>{eligibleTasks.map(item => <option key={item.task_id} value={item.task_id}>{item.title}</option>)}</select></Field><ChapterField metric={event.metric_key} value={chapterText} onChange={setChapterText} /><Field label="稳定成果标识" wide hint="同一章节、文章或批次始终用同一个标识；再次记录不会再次累计。"><input required maxLength={300} placeholder="例如作品/真实章节号、文章标识或提交批次" value={event.artifact_key} onChange={change => patch({ artifact_key: change.target.value })} /></Field><Field label="指标"><select value={event.metric_key} onChange={change => { const metric = change.target.value as DeltaMetric; patch({ metric_key: metric, stage: defaultStage(metric) }); }}>{DELTA_METRICS.map(metric => <option value={metric.key} key={metric.key}>{metric.label} · {metric.unit}</option>)}</select></Field><Field label={`数量（${metricUnit(event.metric_key)}）`}><input required type="number" min="0" step="1" value={event.value} onChange={change => patch({ value: Number(change.target.value) })} /></Field><Field label="已知业务阶段"><select value={event.stage} onChange={change => patch({ stage: change.target.value as EventStage })}>{EVENT_STAGES.map(stage => <option key={stage} value={stage}>{EVENT_STAGE_LABELS[stage]}</option>)}</select></Field><Field label="来源说明"><input required maxLength={1000} value={event.source} onChange={change => patch({ source: change.target.value })} placeholder="用户自报、文档路径或回执来源" /></Field><Field label="成果说明" wide><textarea required maxLength={2000} value={event.summary} onChange={change => patch({ summary: change.target.value })} placeholder="具体完成了什么，达到了哪个阶段。" /></Field></div><p className="field-hint">保存当前日期的数量与说明，之后也可以更正。</p><p className="field-hint">数量与说明独立保存，不影响任务的完成状态。</p></fieldset></div><footer className="modal-footer"><button className="button-primary" disabled={editor.busy}>{editor.busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}保存成果</button></footer></form></DayDialog>;
}

function ChapterField({ metric, value, onChange }: { metric: string; value: string; onChange: (text: string) => void }) {
  if (!isChapterMetric(metric)) return null;
  return <label className="field chapter-input"><span className="field-label">真实章号（选填）</span><input value={value} placeholder="例如 193-200 或 193,195" onChange={e => onChange(e.target.value)} /><small className="field-hint">章号数须与数量一致；未知可以留空，之后再核对。</small></label>;
}

function IdentifyEditor({ state, event, write, refresh, onClose, onDirty, onNotice }: EditorProps & { event: AssetEvent }) {
  const editor = useEditor(state); const [text, setText] = useState(''); const [merge, setMerge] = useState(false);
  async function save(form: FormEvent) {
    form.preventDefault(); if (editor.busy) return; editor.setBusy(true); editor.setError(null);
    try { await write(`/events/${event.id}/chapters`, { chapters: parseChapters(text), merge }, editor.revision); onNotice('章节身份已核对。来源与历史保留，同批成果只计量一次。'); onClose(); }
    catch (failure) { editor.setError(failure); } finally { editor.setBusy(false); }
  }
  return <DayDialog title="核对这批成果的章号" description={`${event.occurred_on} · ${event.summary} · ${event.value}章`} dirty={!!text || merge} busy={editor.busy} onClose={onClose} onDirty={onDirty}><form onSubmit={form => void save(form)}><div className="modal-content"><DayError error={editor.error} onRefresh={() => void editor.compare(refresh)} /><LatestNotice latest={editor.latest} /><fieldset disabled={editor.busy}><ChapterField metric={event.metric_key} value={text} onChange={setText} /><p>章号数量必须等于当前 {event.value} 章。无法确定时关闭即可，不需要猜测。</p><label className="checkbox-label"><input type="checkbox" checked={merge} onChange={e => setMerge(e.target.checked)} />若这些章号已有当天记录，我确认是同一批，合并重复数量并保留来源</label><p className="field-hint">只合并完全包含于本批次、且同一天的记录；部分重叠或跨日期会提示核对。受影响的其他任务需重新核对结果。</p></fieldset></div><footer className="modal-footer"><button className="button-primary" disabled={editor.busy || !text.trim()}>保存章节核对</button></footer></form></DayDialog>;
}

function FinishEditor({ state, app, task, write, refresh, onClose, onDirty, onNotice }: EditorProps & { app: AppState; task: DailyTask }) {
  const editor = useEditor(state);
  const project = app.projects.find(item => item.id === task.project_id);
  const [addEvent, setAddEvent] = useState(false);
  const [chapterText, setChapterText] = useState('');
  const [event, setEvent] = useState<EventInput>(() => { const metric = task.metric_key ?? orderedMetrics(project)[0].key as DeltaMetric; return { project_id: task.project_id, task_id: task.task_id, artifact_key: '', metric_key: metric, value: 1, stage: defaultStage(metric), summary: '', source: '用户自报' }; });
  const [minutes, setMinutes] = useState('');
  const [dirty, setDirty] = useState(false);
  const evidence = state.effective_events.filter(item => item.task_id === task.task_id && (!task.metric_key || item.metric_key === task.metric_key));
  const total = evidence.reduce((sum, item) => sum + (item.value ?? 0), 0) + (addEvent ? event.value : 0);
  const block = currentPlan(state)?.work_blocks.find(item => item.id === task.work_block_id);
  const actual = state.log?.work_block_actuals.find(item => item.block_id === task.work_block_id);
  const patch = (change: Partial<EventInput>) => setEvent(current => ({ ...current, ...change }));
  async function save(form: FormEvent) {
    form.preventDefault(); if (editor.busy || (!addEvent && minutes === '')) return;
    editor.setBusy(true); editor.setError(null);
    try {
      await write(`/tasks/${encodeURIComponent(task.task_id)}/finish`, {
        event: addEvent ? { ...event, chapter_numbers: isChapterMetric(event.metric_key) ? parseChapters(chapterText) : [] } : null, github_chapters: [], result: null,
        actual: minutes === '' ? null : { minutes: Number(minutes), source: '用户自报' }, mark_done: false,
      }, editor.revision);
      onNotice('补充记录已保存。'); onClose();
    } catch (failure) { editor.setError(failure); } finally { editor.setBusy(false); }
  }
  return <DayDialog title="补充记录（选填）" description={`${project?.name ?? ''} · ${state.business_date}`} dirty={dirty} busy={editor.busy} onClose={onClose} onDirty={onDirty}>
    <form onSubmit={form => void save(form)}><div className="modal-content"><DayError error={editor.error} onRefresh={() => void editor.compare(refresh)} /><LatestNotice latest={editor.latest} />
      <div className="finish-task"><h3>{task.title}</h3><p>{task.acceptance}</p></div>
      <fieldset disabled={editor.busy} onChange={() => { setDirty(true); }}>
        {task.result_type === 'quant' && <section className="finish-result" aria-label="数量记录"><strong>{total}<span> {metricUnit(task.metric_key)}</span></strong><p>目标 {task.target_value} {metricUnit(task.metric_key)} · 数量记录独立保存</p></section>}
        <section className="finish-section finish-entry">
          <label className="checkbox-label"><input type="checkbox" checked={addEvent} onChange={change => setAddEvent(change.target.checked)} />补记成果</label>
          {addEvent && <div className="form-grid">
            <ChapterField metric={event.metric_key} value={chapterText} onChange={setChapterText} /><Field label="成果标识" wide hint="同一章节始终使用同一标识。已经记录的章节请勿重复记。"><input required value={event.artifact_key} maxLength={300} onChange={change => patch({ artifact_key: change.target.value })} /></Field>
            <Field label="成果指标"><select disabled={!!task.metric_key} value={event.metric_key} onChange={change => { const metric = change.target.value as DeltaMetric; patch({ metric_key: metric, stage: defaultStage(metric) }); }}>{orderedMetrics(project).map(metric => <option key={metric.key} value={metric.key}>{metric.label}</option>)}</select></Field>
            <Field label={`数量（${metricUnit(event.metric_key)}）`}><input type="number" required min={0} step={1} value={event.value} onChange={change => patch({ value: Number(change.target.value) })} /></Field>
            <Field label="已知阶段"><select value={event.stage} onChange={change => patch({ stage: change.target.value as EventStage })}>{EVENT_STAGES.map(stage => <option key={stage} value={stage}>{EVENT_STAGE_LABELS[stage]}</option>)}</select></Field>
            <Field label="来源"><input required maxLength={1000} value={event.source} onChange={change => patch({ source: change.target.value })} /></Field>
            <Field label="成果说明" wide><textarea required maxLength={2000} value={event.summary} onChange={change => patch({ summary: change.target.value })} /></Field>
          </div>}
          {metricWarning(project, task.metric_key, task.acceptance) && <p className="metric-warning">{metricWarning(project, task.metric_key, task.acceptance)}</p>}
        </section>
        <details className="finish-optional"><summary>用时与来源</summary>
          {evidence.length > 0 && <div className="finish-evidence">{evidence.map(item => <p key={item.id}>{item.summary} · {item.value} {metricUnit(item.metric_key)}<small className="evidence-source">{item.source}</small></p>)}</div>}
          <Field label={`${block?.title ?? '当前时段'} · 今日累计分钟`} hint={`当前${actual ? `已记录 ${actual.minutes} 分钟` : '未记录'}。留空保持原记录，填 0 表示确实未投入；共享时段填写合计，不是本次增量。`}><input type="number" min={0} max={1440} step={1} value={minutes} placeholder="选填，不用预算代替实际用时" onChange={change => setMinutes(change.target.value)} /></Field>
        </details>
      </fieldset>
    </div><footer className="modal-footer finish-actions"><button className="button-primary" disabled={editor.busy || (!addEvent && minutes === '')}>{editor.busy && <LoaderCircle className="spin" size={14} />}保存记录</button></footer></form>
  </DayDialog>;
}

function ResultEditor({ state, task, write, refresh, onClose, onDirty, onNotice }: EditorProps & { task: DailyTask }) {
  const editor = useEditor(state);
  const [value, setValue] = useState<string>(task.result_state === 'confirmed' && task.result_type === 'binary' ? String(task.confirmed_result?.actual_value) : '');
  const [explanation, setExplanation] = useState(task.confirmed_result?.explanation ?? '');
  const evidence = state.effective_events.filter(event => event.task_id === task.task_id && event.metric_key === task.metric_key);
  const total = evidence.reduce((sum, event) => sum + (event.value ?? 0), 0);
  const dirty = explanation !== (task.confirmed_result?.explanation ?? '') || value !== (task.result_state === 'confirmed' && task.result_type === 'binary' ? String(task.confirmed_result?.actual_value) : '');
  async function submit(clear: boolean) { if (editor.busy) return; editor.setBusy(true); editor.setError(null); try { const body: Omit<ResultWrite, 'revision' | 'requestId'> = { clear, binary_value: !clear && task.result_type === 'binary' ? Number(value) : null, explanation }; await write(`/tasks/${encodeURIComponent(task.task_id)}/result`, body, editor.revision); onNotice(clear ? '结果已恢复为未知，已有成果仍保留。' : '任务结果已确认，履约分预览已更新。'); onClose(); } catch (failure) { editor.setError(failure); } finally { editor.setBusy(false); } }
  return <DayDialog title="编辑旧结果" description={task.title} dirty={dirty} busy={editor.busy} onClose={onClose} onDirty={onDirty}><form onSubmit={event => { event.preventDefault(); void submit(false); }}><div className="modal-content"><DayError error={editor.error} onRefresh={() => void editor.compare(refresh)} /><LatestNotice latest={editor.latest} /><p className="acceptance-quote">{task.acceptance}</p><fieldset disabled={editor.busy}>{task.result_type === 'binary' ? <Field label="原有结果记录"><select required value={value} onChange={event => { setValue(event.target.value); }}><option value="">尚未决定，保持未知</option><option value="1">已达到约定验收条件</option><option value="0">明确未达到约定验收条件</option></select></Field> : <div className="result-evidence"><strong>当前有效成果：{total} {metricUnit(task.metric_key)}</strong><p>目标 {task.target_value} {metricUnit(task.metric_key)}。最终数量由服务端按有效成果汇总，不能直接改写。</p>{evidence.map(event => <div key={event.id}>{event.artifact_key} · {event.value} {metricUnit(event.metric_key)}</div>)}{evidence.length === 0 && <p>尚无绑定本任务的有效成果。确认意味着明确“本日没有达成计量成果”；不确定时请关闭并保持未知。</p>}</div>}<Field label="结果说明（选填）"><textarea value={explanation} maxLength={2000} onChange={event => { setExplanation(event.target.value); }} /></Field><p className="field-hint">点击下方确认按钮即确认当前日期、成果和验收内容；不确定时可关闭继续补记。</p></fieldset></div><footer className="modal-footer">{task.result_state === 'confirmed' && <button type="button" className="button-secondary" disabled={editor.busy} onClick={() => void submit(true)}>恢复为未知</button>}<button className="button-primary" disabled={resultDisabled(editor.busy, task.result_type, value)}>{editor.busy && <LoaderCircle size={14} className="spin" />}确认结果</button></footer></form></DayDialog>;
}

function ActualEditor({ state, block, write, refresh, onClose, onDirty, onNotice }: EditorProps & { block: WorkBlock }) {
  const editor = useEditor(state);
  const initial = state.log?.work_block_actuals.find(actual => actual.block_id === block.id);
  const [minutes, setMinutes] = useState(initial ? String(initial.minutes) : '');
  const [source, setSource] = useState(initial?.source ?? '用户自报');
  const dirty = minutes !== (initial ? String(initial.minutes) : '') || source !== (initial?.source ?? '用户自报');
  async function submit(event: FormEvent) { event.preventDefault(); if (editor.busy) return; editor.setBusy(true); editor.setError(null); try { const body: Omit<ActualWrite, 'revision' | 'requestId'> = { block_id: block.id, minutes: n(minutes), source }; await write('/actuals', body, editor.revision, 'PUT'); onNotice(minutes === '' ? '实际投入已恢复为未记录。' : '该时段实际投入已保存，只累计一次。'); onClose(); } catch (failure) { editor.setError(failure); } finally { editor.setBusy(false); } }
  return <DayDialog title="记录实际投入" description={`${block.title} · 预算 ${block.budget_minutes ?? '未填写'} 分钟`} dirty={dirty} busy={editor.busy} onClose={onClose} onDirty={onDirty}><form onSubmit={event => void submit(event)}><div className="modal-content"><DayError error={editor.error} onRefresh={() => void editor.compare(refresh)} /><LatestNotice latest={editor.latest} /><fieldset disabled={editor.busy}><Field label="本时段实际分钟数" hint="只填实际发生的投入。未知留空；填 0 表示已确认没有投入。"><input type="number" min="0" step="1" value={minutes} onChange={event => setMinutes(event.target.value)} /></Field><Field label="来源说明"><input required value={source} onChange={event => setSource(event.target.value)} /></Field><p className="quiet-note">填写本时段截至现在的累计实际分钟，不是本次增量。保存时会先暂停本时段正在进行的计时，再以这里的累计值为准；其他时段不受影响。共享时段只记录一次。清空分钟数会恢复为未知。</p></fieldset></div><footer className="modal-footer"><button className="button-primary" disabled={editor.busy}>{editor.busy && <LoaderCircle size={14} className="spin" />}保存实际投入</button></footer></form></DayDialog>;
}

function CorrectionEditor({ state, event, app, write, refresh, onClose, onDirty, onNotice }: EditorProps & { event: AssetEvent; app: AppState }) {
  const editor = useEditor(state);
  const [kind, setKind] = useState<'replace' | 'void'>('replace');
  const initialChapters = event.chapter_numbers?.join(', ') ?? '';
  const [chapterText, setChapterText] = useState(initialChapters);
  const [value, setValue] = useState(event.value === null ? '' : String(event.value));
  const [stage, setStage] = useState(event.stage);
  const [summary, setSummary] = useState(event.summary);
  const [source, setSource] = useState(event.source);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const dirty = reason !== '' || confirmed || kind !== 'replace' || chapterText !== initialChapters || value !== (event.value === null ? '' : String(event.value)) || stage !== event.stage || summary !== event.summary || source !== event.source;
  async function submit(form: FormEvent) { form.preventDefault(); if (editor.busy || !confirmed) return; editor.setBusy(true); editor.setError(null); try { const body: Omit<CorrectionWrite, 'revision' | 'requestId'> = { kind, value: kind === 'void' ? null : n(value), stage, summary, source, reason, ...(kind === 'replace' && initialChapters ? { chapter_numbers: parseChapters(chapterText) } : {}) }; await write(`/events/${encodeURIComponent(event.id)}/correct`, body, editor.revision); onNotice(kind === 'void' ? '成果已撤销，原记录保留；关联结果需重新确认。' : '更正已保存，原记录保留；关联结果需重新确认。'); onClose(); } catch (failure) { editor.setError(failure); } finally { editor.setBusy(false); } }
  return <DayDialog title={event.change_kind === 'void' ? '恢复已撤销的成果' : '更正或撤销成果'} description={`${projectName(app, event.project_id)} · ${event.occurred_on} · ${event.artifact_key.startsWith('pcos-internal:') ? '已更正的成果批次' : event.artifact_key}`} dirty={dirty} busy={editor.busy} onClose={onClose} onDirty={onDirty}><form onSubmit={form => void submit(form)}><div className="modal-content"><DayError error={editor.error} onRefresh={() => void editor.compare(refresh)} /><LatestNotice latest={editor.latest} /><p className="acceptance-quote">可更正数量、说明、来源和业务阶段。手填章号有误时，请同时填写正确章号与完整数量。旧批次保留在历史中，今后按新章号统计；相关任务结果需要重新核对。</p><fieldset disabled={editor.busy}>{event.change_kind !== 'void' && <Field label="处理方式"><select value={kind} onChange={change => { setKind(change.target.value as 'replace' | 'void'); setConfirmed(false); }}><option value="replace">更正数量或说明</option><option value="void">撤销这项成果</option></select></Field>}{kind === 'replace' && <div className="form-grid"><Field label={`更正后的完整数量（${metricUnit(event.metric_key)}）`} hint="填写正确总量，不是差额。"><input required type="number" min="0" step="1" value={value} onChange={change => { setValue(change.target.value); setConfirmed(false); }} /></Field><Field label="业务阶段"><select value={stage} onChange={change => { setStage(change.target.value as EventStage); setConfirmed(false); }}>{EVENT_STAGES.map(item => <option key={item} value={item}>{EVENT_STAGE_LABELS[item]}</option>)}</select></Field></div>}{kind === 'replace' && initialChapters && <Field label="更正后的章号" hint={event.artifact_key.startsWith('github:') ? '远端采集的章号由文件确定；如有问题可撤销记录后核对原仓库。' : '例如 193-199，填写章数须与完整数量一致。旧来源保留，修改后的批次以本次核对为准。'}><input required disabled={event.change_kind === 'void' || event.artifact_key.startsWith('github:')} value={chapterText} onChange={change => { setChapterText(change.target.value); setConfirmed(false); }} /></Field>}<Field label="成果说明"><textarea required value={summary} onChange={change => { setSummary(change.target.value); setConfirmed(false); }} /></Field><Field label="来源说明"><input required value={source} onChange={change => { setSource(change.target.value); setConfirmed(false); }} /></Field><Field label={event.change_kind === 'void' ? '恢复原因' : '更正 / 撤销原因'}><textarea required value={reason} onChange={change => { setReason(change.target.value); setConfirmed(false); }} /></Field><label className="checkbox-label confirmation-check"><input required type="checkbox" checked={confirmed} onChange={change => setConfirmed(change.target.checked)} />我已核对这次修改，确认保留旧记录并重新确认受影响的任务结果。</label></fieldset></div><footer className="modal-footer"><button className="button-primary" disabled={editor.busy || !confirmed}>{editor.busy && <LoaderCircle size={14} className="spin" />}{kind === 'void' ? '确认撤销' : event.change_kind === 'void' ? '确认恢复' : '保存更正'}</button></footer></form></DayDialog>;
}

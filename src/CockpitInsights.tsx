import { useEffect, useId, useState } from 'react';
import { BookOpen, Check, CircleDashed, Clock3, FileText, Flag, Footprints, Heart, LoaderCircle, NotebookPen, Sprout } from 'lucide-react';
import { METRICS, type AppState } from '../shared/contracts';
import { EVENT_STAGE_LABELS, type AssetEvent, type DayState } from '../shared/day-contracts';
import type { DashboardDay, DashboardView } from '../shared/dashboard-contracts';
import type { CalendarDay, CalendarMonth } from '../shared/calendar-contracts';
import { isChapterMetric } from '../shared/chapters';
import { getOdetteMood, type OdetteMoodView } from '../shared/odette-mood';
import { errorMessage, request } from './api';
import OdettePortrait from './OdettePortrait';

interface Props { date: string; revision: number; app: AppState; dayState?: DayState }
interface LoadedView { date: string; revision: number; attempt: number; view: DashboardView | null; calendarDays: CalendarDay[]; today: string | null; error: unknown }
interface TaskPreview { id: string; title: string; project: string; completed: boolean }
interface DayProgress { mode: DashboardDay['mode']; planned: number; completed: number; actualMinutes: number | null; budgetMinutes: number | null; missingBudgets: number; tasks: TaskPreview[] }

const shortDate = (date: string) => date.slice(5).replace('-', '/');
const eventCount = (day: DashboardDay) => day.totals.reduce((sum, total) => sum + total.records, 0);
function currentDate(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}-${parts.find(part => part.type === 'day')!.value}`;
}

function currentProgress(day: DashboardDay, state?: DayState): DayProgress {
  // Score records contain measured results, not completion flags, so they cannot supply task previews.
  if (!state) return { mode: day.mode, planned: day.plannedTasks, completed: day.completedTasks, actualMinutes: day.actualMinutes, budgetMinutes: day.budgetMinutes, missingBudgets: day.missingBudgets, tasks: [] };
  const plan = state.log?.plan_snapshots.find(snapshot => snapshot.plan_version === state.log?.current_plan_version);
  const tasks = (plan?.tasks ?? []).flatMap(snapshot => { const task = state.tasks.find(item => item.task_id === snapshot.task_id); return task ? [task] : []; });
  const actuals = state.log?.work_block_actuals ?? [];
  return {
    mode: plan?.day_mode ?? null, planned: tasks.length, completed: tasks.filter(task => task.status === 'done').length,
    actualMinutes: actuals.length ? actuals.reduce((sum, actual) => sum + actual.minutes, 0) : null,
    budgetMinutes: plan?.work_blocks.some(block => block.budget_minutes !== null) ? plan.work_blocks.reduce((sum, block) => sum + (block.budget_minutes ?? 0), 0) : null,
    missingBudgets: plan?.work_blocks.filter(block => block.budget_minutes === null).length ?? 0,
    tasks: tasks.map(task => ({ id: task.task_id, title: task.title, project: task.project_name, completed: task.status === 'done' })),
  };
}

function arcPath(start: number, end: number): string {
  const point = (portion: number) => { const angle = portion * Math.PI * 2 - Math.PI / 2; return `${90 + 67 * Math.cos(angle)} ${90 + 67 * Math.sin(angle)}`; };
  return `M ${point(start)} A 67 67 0 ${end - start > .5 ? 1 : 0} 1 ${point(end)}`;
}

function CompletionRing({ progress, mood, future }: { progress: DayProgress; mood: OdetteMoodView; future: boolean }) {
  const titleId = useId();
  const remaining = Math.max(0, progress.planned - progress.completed);
  const circumference = 2 * Math.PI * 67;
  const completedLength = progress.planned ? progress.completed / progress.planned * circumference : 0;
  const description = progress.mode === 'rest' ? '休息日，不计算任务完成比例。' : future ? '这一天还未开始。' : progress.planned ? `${progress.planned} 项任务，${progress.completed} 项已完成，${remaining} 项未完成。` : '当天未安排任务。';

  return <div className="vital-progress-character" title={mood.message}>
    <div className={`vital-ring-wrap ${progress.mode === 'rest' ? 'is-rest' : ''}`}>
    <svg className="vital-ring" viewBox="0 0 180 180" role="img" aria-labelledby={titleId}>
      <title id={titleId}>{description}</title>
      <circle className="vital-ring-track" cx="90" cy="90" r="67" />
      {!future && progress.mode !== 'rest' && <>
        {completedLength > 0 && <circle className="vital-ring-achieved" cx="90" cy="90" r="67" strokeDasharray={`${completedLength} ${circumference - completedLength}`} transform="rotate(-90 90 90)" />}
        {remaining > 0 && (remaining === progress.planned ? <circle className="vital-ring-pending" cx="90" cy="90" r="67" /> : <path className="vital-ring-pending" d={arcPath(progress.completed / progress.planned, 1)} />)}
      </>}
    </svg>
    <div className="vital-ring-portrait"><OdettePortrait mood={mood.mood} label={mood.label} size="hero" /></div>
    </div>
    <div className="vital-ring-caption">
      {progress.mode === 'rest' ? <><strong className="vital-ring-word">{future ? '休息安排' : '休息'}</strong><small>安心休息</small></> : future ? <><strong className="vital-ring-word">待开始</strong><small>已提前安排</small></> : !progress.planned ? <><strong className="vital-ring-word">待安排</strong><small>先安排一件事</small></> : <><strong>{progress.completed}<span> / {progress.planned}</span></strong><small>任务已完成</small></>}
    </div>
  </div>;
}

function DailyProgress({ day, state, today, hasHarvest }: { day: DashboardDay; state?: DayState; today: string; hasHarvest: boolean }) {
  const progress = currentProgress(day, state);
  const future = day.date > today;
  const mood = getOdetteMood({ mode: progress.mode ?? undefined, plannedTasks: progress.planned, completedTasks: progress.completed, hasHarvest, future, past: day.date < today });
  const remaining = Math.max(0, progress.planned - progress.completed);
  const headline = progress.mode === 'rest' ? future ? '这一天已安排休息。' : '今天安心休息。' : future ? '给这一天留一点期待。' : mood.mood === 'ecstatic' ? '今天的任务已全部完成。' : mood.mood === 'happy' ? '今天已有新的收获。' : mood.mood === 'sad' ? '回顾一下，调整下一步。' : mood.mood === 'encouraging' ? '正在稳步推进。' : progress.planned > 0 ? '重要的事，已经准备好了。' : '从一件小事开始。';
  const nextTasks = progress.tasks.toSorted((a, b) => Number(a.completed) - Number(b.completed)).slice(0, 3);
  return <article className="vital-daily-progress">
    <div className="vital-progress-main"><CompletionRing progress={progress} mood={mood} future={future} /><div className="vital-progress-copy"><span className="vital-kicker">{shortDate(day.date)} · 当日推进 <span className="vital-odette-label">进度 · {mood.label}</span></span><h3>{headline}</h3><p>{progress.mode === 'rest' ? future ? '已提前安排休息。' : '休息日不计算完成比例，实际成果仍可记录。' : future ? '可以提前安排，完成后点一下就好。' : progress.planned > 0 ? `${progress.completed} / ${progress.planned} 项已完成${remaining ? `，${remaining} 项未完成。` : '。'}` : hasHarvest ? '已有计划外收获，按自己的节奏继续。' : '安排一件事，完成后在这里看见进展。'}</p>
      {progress.tasks.length > 0 && <ul className="vital-task-preview" aria-label="当日计划任务预览">{nextTasks.map(task => <li className={task.completed ? 'is-achieved' : 'is-pending'} key={task.id}><span className="vital-task-mark" aria-hidden="true">{task.completed ? <Check size={14} /> : <CircleDashed size={14} />}</span><div><strong>{task.title}</strong><small>{task.project} · {task.completed ? '已完成' : '未完成'}</small></div></li>)}</ul>}
      {!progress.planned && <div className="vital-progress-prompt"><Clock3 size={15} aria-hidden="true" /><span>{progress.mode === 'rest' ? '暂停一下，也是一种安排。' : '添加任务 → 开始行动 → 点完成'}</span></div>}
    </div></div>
    {progress.planned > 0 && progress.mode !== 'rest' && !future && <div className="vital-result-legend" aria-label="当日任务完成情况"><span className="is-achieved"><i />{progress.completed} 项已完成</span><span className="is-pending"><i />{remaining} 项未完成</span></div>}
    <div className="vital-time-caption"><Clock3 size={13} aria-hidden="true" /><span>{progress.actualMinutes === null ? '实际投入未记录' : `已记录投入 ${progress.actualMinutes.toLocaleString('zh-CN')} 分钟`}</span><span>{progress.mode === 'rest' ? '休息日未安排预算' : progress.missingBudgets > 0 ? '计划预算待补全' : progress.budgetMinutes === null ? '计划预算未确认' : `计划预算 ${progress.budgetMinutes.toLocaleString('zh-CN')} 分钟`}</span></div>
  </article>;
}

function footprintDescription(day: DashboardDay, future: boolean): string {
  const records = eventCount(day);
  const taskStatus = day.mode === 'rest' ? '休息日' : future ? '未来日期，尚未开始' : day.plannedTasks > 0 ? `${day.completedTasks} 项已完成，${Math.max(0, day.plannedTasks - day.completedTasks)} 项未完成` : '当天未安排任务';
  return `${day.date}，${taskStatus}，${records ? `${records} 条有效成果记录` : '尚无有效成果记录'}；${day.actualMinutes === null ? '实际投入未记录' : `已记录实际投入 ${day.actualMinutes} 分钟`}`;
}

function footprintSummary(day: DashboardDay, future: boolean): string {
  const remaining = Math.max(0, day.plannedTasks - day.completedTasks);
  const taskStatus = day.mode === 'rest' ? '休息日' : future ? '待开始' : day.plannedTasks === 0 ? '未安排任务' : `${day.completedTasks} 项已完成${remaining ? `，${remaining} 项未完成` : ''}`;
  const records = eventCount(day);
  return `${shortDate(day.date)} · ${taskStatus} · ${records ? `${records} 条成果记录` : '暂无有效成果记录'} · ${day.actualMinutes === null ? '投入未记录' : `已记 ${day.actualMinutes} 分钟`}`;
}

function ResultFootprints({ view, date, today, calendarDays }: { view: DashboardView; date: string; today: string; calendarDays: CalendarDay[] }) {
  const [selected, setSelected] = useState(date);
  useEffect(() => setSelected(date), [date]);
  const selectedDay = view.days.find(day => day.date === selected) ?? view.days.find(day => day.date === date) ?? view.days.at(-1)!;
  const completed = view.days.filter(day => day.date <= today).reduce((sum, day) => sum + day.completedTasks, 0);
  const recordsInWindow = view.days.reduce((sum, day) => sum + eventCount(day), 0);
  return <article className="vital-footprints">
    <header><div><h3><Footprints size={16} aria-hidden="true" />七天行动足迹</h3></div><span>{completed > 0 ? `${completed} 项已完成` : recordsInWindow > 0 ? `${recordsInWindow} 条成果记录` : '从一件事开始'}</span></header>
    <div className="vital-footprint-days" aria-label="近七天行动足迹">{view.days.map(day => {
      const records = eventCount(day);
      const future = day.date > today;
      const mood = getOdetteMood({ mode: day.mode ?? undefined, plannedTasks: day.plannedTasks, completedTasks: day.completedTasks, hasHarvest: calendarDays.find(item => item.date === day.date)?.hasHarvest === true, future, past: day.date < today });
      const status = future ? 'future' : day.mode === 'rest' ? 'rest' : day.completedTasks > 0 ? 'achieved' : day.plannedTasks > 0 ? 'pending' : records > 0 ? 'recorded' : day.actualMinutes !== null ? 'timed' : day.recorded ? 'unplanned' : 'unknown';
      const label = status === 'future' ? day.mode === 'rest' ? '待休息' : '待开始' : status === 'achieved' ? `${day.completedTasks} 完成` : status === 'recorded' ? `${records} 记录` : status === 'rest' ? '休息' : status === 'pending' ? '未完成' : status === 'timed' ? '有投入' : status === 'unplanned' ? '待安排' : '未记录';
      return <button type="button" className={`vital-footprint is-${status}`} data-mood={mood.mood} key={day.date} aria-pressed={selectedDay.date === day.date} aria-label={`${footprintDescription(day, future)}；进度${mood.label}`} onClick={() => setSelected(day.date)}><span>{shortDate(day.date)}</span><span className="vital-footprint-symbol"><OdettePortrait mood={mood.mood} decorative /></span><small>{label}</small></button>;
    })}</div>
    <p className="vital-footprint-detail" aria-live="polite">{footprintSummary(selectedDay, selectedDay.date > today)}</p>
  </article>;
}

function RecentResults({ state, app }: { state?: DayState; app: AppState }) {
  const events = state?.effective_events.toSorted((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 2) ?? [];
  if (!events.length) return null;
  const iconFor = (event: AssetEvent) => event.metric_key.includes('chapter') || event.metric_key === 'accepted_words' ? BookOpen : event.metric_key.includes('article') ? FileText : event.metric_key === 'learning_outputs' ? NotebookPen : event.metric_key === 'health_sessions' ? Heart : Flag;
  return <div className="vital-results" aria-label="当日已确认成果记录">{events.map(event => { const Icon = iconFor(event); const metric = METRICS.find(item => item.key === event.metric_key); const unresolved = isChapterMetric(event.metric_key) && (event.chapter_numbers?.length ?? 0) !== event.value; return <article className="vital-result" key={event.id}><span className="vital-result-emblem" aria-hidden="true"><Icon size={17} /></span><div><span>{app.projects.find(project => project.id === event.project_id)?.name ?? '项目'} · 用户确认</span><h4>{event.summary}</h4><small>账面 {event.value ?? '未知'} {metric?.unit ?? ''} · {EVENT_STAGE_LABELS[event.stage]}{unresolved && ' · 章号待核对'}</small></div></article>; })}</div>;
}

export default function CockpitInsights({ date, revision, app, dayState }: Props) {
  const [loaded, setLoaded] = useState<LoadedView | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const start = new Date(`${date}T12:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 6);
    const months = [...new Set([start.toISOString().slice(0, 7), date.slice(0, 7)])];
    // Reuse the calendar's checked harvest facts, including chapter identity checks.
    void Promise.all([
      request<DashboardView>(`/api/dashboard/${date}`),
      Promise.all(months.map(month => request<CalendarMonth>(`/api/calendar/${month}`))),
    ])
      .then(([view, calendars]) => { if (active) setLoaded({ date, revision, attempt, view, calendarDays: calendars.flatMap(calendar => calendar.days), today: calendars[0]?.today ?? null, error: null }); })
      .catch(error => { if (active) setLoaded({ date, revision, attempt, view: null, calendarDays: [], today: null, error }); });
    return () => { active = false; };
  }, [date, revision, attempt]);
  const current = loaded?.date === date && loaded.revision === revision && loaded.attempt === attempt ? loaded : null;
  const state = dayState?.business_date === date && (dayState.log?.revision ?? 0) === revision ? dayState : undefined;
  const day = current?.view?.days.find(item => item.date === date);
  const today = current?.today ?? currentDate(app.settings.timezone);

  return <section className="cockpit-insights vital-insights" aria-label="每日推进与成果足迹" aria-busy={!current}>
    <header className="vital-insights-heading"><div><span className="vital-kicker"><Sprout size={14} aria-hidden="true" />一点投入，一点收获</span><h2>把今天，留在这里。</h2></div><span className="vital-confirmation-label"><Check size={12} aria-hidden="true" />完成一件，记下一件</span></header>
    {current?.error ? <div className="insights-error" role="alert"><p>{errorMessage(current.error)}</p><button type="button" className="button-secondary" onClick={() => setAttempt(value => value + 1)}>重新读取成果</button></div> : !current?.view || !day ? <div className="insights-loading" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" />正在读取真实的推进记录…</div> : <><DailyProgress day={day} state={state} today={today} hasHarvest={current.calendarDays.find(item => item.date === date)?.hasHarvest === true} /><ResultFootprints view={current.view} date={date} today={today} calendarDays={current.calendarDays} /><RecentResults state={state} app={app} /></>}
  </section>;
}

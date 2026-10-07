import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Circle, Pin, PinOff, RefreshCw, X } from 'lucide-react';
import type { AppState } from '../shared/contracts';
import type { DayState } from '../shared/day-contracts';
import type { TimerView } from '../shared/timer-contracts';
import { widgetSummary } from '../shared/widget-summary';
import { taskBoardState } from '../shared/task-board';
import { timerDuration } from '../shared/timer-time';
import { refreshTheme } from './theme';

type Snapshot = { app: AppState; day: DayState; timer: TimerView; updatedAt: number };
const minutes = (value: number | null) => value === null ? '—' : String(value);
const dateAt = (timezone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('暂时无法读取驾驶舱');
  return response.json() as Promise<T>;
}

export default function DesktopWidget() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [pinned, setPinned] = useState(true);
  const [pinBusy, setPinBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const bridge = window.lifeCockpitDesktop;

  const refresh = useCallback(async () => {
    refreshTheme();
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    setLoading(true);
    try {
      const app = await read<AppState>('/api/state', controller.signal);
      const date = dateAt(app.settings.timezone);
      const [day, timer] = await Promise.all([
        read<DayState>(`/api/days/${date}`, controller.signal),
        read<TimerView>(`/api/days/${date}/timer`, controller.signal),
      ]);
      if (!controller.signal.aborted) {
        setSnapshot({ app, day, timer, updatedAt: Date.now() });
        setError('');
      }
    } catch {
      if (pending.current === controller) setError('连接中断，正在重试');
    } finally {
      clearTimeout(timeout);
      if (pending.current === controller) { pending.current = null; setLoading(false); }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => void refresh(), 5000);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const focus = () => { void refresh(); void bridge?.getWidgetState().then(state => setPinned(state.alwaysOnTop)).catch(() => {}); };
    focus();
    window.addEventListener('focus', focus);
    return () => { clearInterval(poll); clearInterval(clock); pending.current?.abort(); pending.current = null; window.removeEventListener('focus', focus); };
  }, [refresh, bridge]);

  async function openMain() {
    try { if (bridge) await bridge.openMain(); else window.location.assign('/'); }
    catch { setActionError('驾驶舱未能打开，请从托盘重试'); }
  }
  async function togglePin() {
    if (!bridge || pinBusy) return;
    setPinBusy(true);
    try { const next = await bridge.setWidgetAlwaysOnTop(!pinned); setPinned(next.alwaysOnTop); setActionError(''); }
    catch { setActionError('置顶未能切换，请重试'); }
    finally { setPinBusy(false); }
  }
  const summary = snapshot ? widgetSummary(snapshot.day, snapshot.timer.active?.task_id) : null;
  const active = snapshot?.timer.active;
  const timezone = snapshot?.app.settings.timezone ?? 'Asia/Shanghai';
  const stale = !!error || !!snapshot && (now - snapshot.updatedAt > 15000 || snapshot.day.business_date !== dateAt(timezone));
  const displayNow = stale && snapshot ? snapshot.updatedAt : now;
  const elapsed = active ? Math.max(0, (displayNow - Date.parse(active.started_at)) / 1000) : 0;
  const dateLabel = new Intl.DateTimeFormat('zh-CN', { timeZone: snapshot ? 'UTC' : timezone, month: 'long', day: 'numeric', weekday: 'short' }).format(snapshot ? new Date(snapshot.day.business_date + 'T12:00:00Z') : now);

  return <main className="desktop-widget" aria-label="人生驾驶舱桌面小组件">
    <header className="widget-titlebar"><span className="widget-brand"><img className="widget-brand-icon" src="/life-cockpit.svg" alt="" />人生驾驶舱</span><div className="widget-window-actions">
      {bridge && <><button type="button" onClick={() => void togglePin()} disabled={pinBusy} aria-label={pinned ? '取消置顶' : '置顶小组件'} aria-pressed={pinned} title={pinned ? '取消置顶' : '置顶小组件'}>{pinned ? <Pin size={16} /> : <PinOff size={16} />}</button><button type="button" aria-label="隐藏小组件" title="隐藏到托盘" onClick={() => void bridge.hideWidget().catch(() => setActionError('暂时无法隐藏小组件'))}><X size={18} /></button></>}
    </div></header>
    <div className="widget-scroll">
      <div className="widget-day"><span>{dateLabel}</span><button type="button" aria-label="刷新进展" title="每 5 秒自动刷新" disabled={loading} onClick={() => void refresh()}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button></div>
      {actionError && <p className="widget-error" role="alert">{actionError}</p>}
      {stale && <p className="widget-error" role="status">{error || '数据暂未更新'} · 显示上次记录</p>}
      {!snapshot ? <div className="widget-empty" role="status">{error || '正在同步今天的进展…'}</div> : !snapshot.app.setupCompleted ? <div className="widget-empty"><h1>从今天开始</h1><p>在驾驶舱建立项目后，进展就会显示在这里。</p></div> : <>
        <section className="widget-progress" aria-label="今日任务进展">
          <div className="widget-ring"><svg viewBox="0 0 100 100" aria-hidden="true"><circle className="widget-ring-track" cx="50" cy="50" r="43" /><circle className="widget-ring-value" cx="50" cy="50" r="43" pathLength="100" strokeDasharray={`${(summary!.progress ?? 0) * 100} 100`} /></svg><div><strong>{summary!.total ? summary!.completed : '—'}<small>{summary!.total ? `/${summary!.total}` : ''}</small></strong><span>已完成</span></div></div>
          <div className="widget-progress-copy"><h1>{summary!.plan?.day_mode === 'rest' ? '今天，安心休息' : summary!.total ? summary!.completed === summary!.total ? '今天的任务已完成' : '一步一步，往前走' : '给今天一个方向'}</h1><p>{summary!.total ? `${summary!.completed} 项已完成` : summary!.plan?.day_mode === 'rest' ? '休息也有它的位置' : snapshot.day.log?.draft_plan ? '计划草稿尚未确认' : '今天还没有安排任务'}</p>{summary!.remaining > 0 && <span>{summary!.remaining} 项未完成</span>}</div>
        </section>
        <section className={`widget-focus ${active ? 'is-active' : ''}`} aria-label="当前专注">
          <div className="widget-section-label"><span className="widget-live-dot" />{active ? stale ? '上次专注记录' : '正在专注 · 暂停后入账' : '此刻'}</div>
          <strong className="widget-clock">{active ? timerDuration(elapsed) : new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)}</strong>
          <p title={active?.task_title ?? active?.block_title ?? ''}>{active ? active.task_title ?? active.block_title : '还没有运行中的计时'}</p>
          {active && active.business_date !== snapshot.day.business_date && <small>跨日专注，请回驾驶舱核对</small>}
        </section>
        <section className="widget-time-stats" aria-label="已记录投入"><div><span>今日投入</span><strong>{minutes(snapshot.timer.summary.todayMinutes)}<small>{snapshot.timer.summary.todayMinutes === null ? '未记录' : '分钟'}</small></strong></div><div><span>近七天积累</span><strong>{minutes(snapshot.timer.summary.weekMinutes)}<small>{snapshot.timer.summary.weekMinutes === null ? '未记录' : '分钟'}</small></strong></div></section>
        {summary!.tasks.length > 0 && <section className="widget-tasks" aria-label="今日任务"><div className="widget-task-heading"><h2>今天的行动</h2><span>{summary!.total} 项</span></div>{summary!.tasks.slice(0, 3).map(task => {
          const state = taskBoardState(task);
          const doing = active?.task_id === task.task_id || task.status === 'doing';
          const label = state.completed ? '已完成' : task.status === 'cancelled' ? '已取消' : doing ? '进行中' : '未完成';
          return <button type="button" key={task.task_id} className="widget-task" onClick={() => void openMain()}><span className={state.completed ? 'widget-task-icon is-done' : 'widget-task-icon'}>{state.completed ? <Check size={15} /> : <Circle size={14} />}</span><span className="widget-task-copy"><strong>{task.title}</strong><small>{snapshot.app.projects.find(project => project.id === task.project_id)?.name ?? task.project_name}</small></span><span className="widget-task-state">{label}</span></button>;
        })}{summary!.total > 3 && <p className="widget-more">另有 {summary!.total - 3} 项，可在驾驶舱查看</p>}</section>}
      </>}
    </div>
    <footer className="widget-footer"><span title="与驾驶舱共用同一份本机账本">{snapshot ? stale ? '等待重新连接' : '已同步 · ' + new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(snapshot.updatedAt) : '本机账本'}</span><button type="button" onClick={() => void openMain()}>打开驾驶舱<ArrowUpRight size={15} /></button></footer>
  </main>;
}

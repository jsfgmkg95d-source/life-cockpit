import { useEffect, useState } from 'react';
import { METRICS } from '../shared/contracts';
import type { DayState } from '../shared/day-contracts';
import { projectProgress } from '../shared/project-progress';
import { taskBoardState } from '../shared/task-board';
import { errorMessage, request } from './api';

export function useProjectDay(enabled: boolean, timezone: string) {
  const [day, setDay] = useState<DayState | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) { setDay(null); return; }
    let live = true; let latest = 0;
    const refresh = async () => {
      const generation = ++latest;
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
      const date = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
      try {
        const value = await request<DayState>(`/api/days/${date}`);
        if (live && latest === generation) { setDay(value); setError(''); }
      } catch (failure) { if (live && latest === generation) { setDay(null); setError(errorMessage(failure)); } }
    };
    const visibleRefresh = () => { if (document.visibilityState === 'visible') void refresh(); };
    setDay(null); setError(''); void refresh();
    window.addEventListener('focus', visibleRefresh);
    document.addEventListener('visibilitychange', visibleRefresh);
    const timer = window.setInterval(visibleRefresh, 30000);
    return () => { live = false; window.clearInterval(timer); window.removeEventListener('focus', visibleRefresh); document.removeEventListener('visibilitychange', visibleRefresh); };
  }, [enabled, timezone]);
  return { day, error };
}

export function ProjectProgressDetail({ day, projectId, error }: { day: DayState | null; projectId: string; error: string }) {
  if (!day) return <section className="detail-section"><h3>今日进展</h3><p className="detail-caption" role={error ? 'alert' : undefined}>{error ? `同步失败：${error}。请切回页面重试。` : '正在同步今日进展…'}</p></section>;
  const progress = projectProgress(day, projectId);
  return <section className="detail-section project-day-detail"><h3>今日进展 · {day.business_date}</h3><strong>{progress.label}</strong>
    {progress.tasks.map(task => { const state = taskBoardState(task); const metric = METRICS.find(item => item.key === task.metric_key); return <div className="project-day-task" key={task.task_id}><span>{task.title}</span><p>{state.completed ? '已完成' : task.status === 'cancelled' ? '已取消' : task.status === 'doing' ? '进行中 · 未完成' : '未完成'}</p>{task.result_type === 'quant' && state.actual !== null && <small>已记录数量：{state.actual} {metric?.unit ?? ''}</small>}</div>; })}
    <p className="detail-caption">{progress.events.length} 条有效成果 · 与“今天”读取同一份记录。今日任务完成不代表整个项目完结。</p>
  </section>;
}

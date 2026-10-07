import { useEffect, useState, type CSSProperties } from 'react';
import { Clock3, RefreshCw } from 'lucide-react';
import type { TimerView } from '../shared/timer-contracts';
import { errorMessage, request } from './api';

const duration = (minutes: number | null | undefined) => minutes == null ? '未记录' : minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}`;
export default function TimeReview({ date }: { date: string }) {
  const [view, setView] = useState<TimerView | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true; setView(null); setError('');
    void request<TimerView>(`/api/days/${date}/timer`).then(value => { if (live) setView(value); }).catch(failure => { if (live) setError(errorMessage(failure)); });
    return () => { live = false; };
  }, [date, refresh]);
  useEffect(() => { const changed = () => setRefresh(value => value + 1); window.addEventListener('pcos-timer-change', changed); return () => window.removeEventListener('pcos-timer-change', changed); }, []);
  const summary = view?.summary, max = Math.max(1, ...(summary?.week.map(day => day.minutes ?? 0) ?? []));
  return <section className="time-review" aria-label="实际投入回顾"><div className="time-review-heading"><div><Clock3 size={18} /><h2>时间的积累</h2></div><button className="button-quiet" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={13} />读取最新</button></div>
    {error && <p className="planner-error" role="alert">{error}</p>}{!view && !error && <p className="planner-empty">正在读取实际投入…</p>}
    {summary && <><div className="time-review-metrics"><div><span>这一天</span><strong>{duration(summary.todayMinutes)}</strong></div><div><span>近 7 天</span><strong>{duration(summary.weekMinutes)}</strong></div><div><span>截至这天累计</span><strong>{duration(summary.totalMinutes)}</strong></div><div><span>记录投入的日子</span><strong>{summary.timeDays} 天</strong></div></div><div className="time-review-chart" aria-label="近七天已记录实际投入">{summary.week.map(day => <div className="time-review-day" key={day.date}><strong>{day.minutes === null ? '—' : `${day.minutes}分`}</strong><div className={`time-review-bar ${day.minutes === null ? 'unknown' : ''}`} style={{ '--time-height': `${Math.max(2, (day.minutes ?? 0) / max * 100)}%` } as CSSProperties}><i /></div><span>{day.date.slice(5).replace('-', '/')}</span></div>)}</div><p className="time-review-note">按已保存的实际分钟统计，共享投入只计一次。空白表示未记录；正在计时的片段暂停后入账。连续投入和已确认成果分别积累。</p></>}
  </section>;
}

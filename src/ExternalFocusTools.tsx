import { useEffect, useState } from 'react';
import type { AppState } from '../shared/contracts';
import type { DayState } from '../shared/day-contracts';
import { errorMessage, request } from './api';
import FocusBridge from './FocusBridge';

export default function ExternalFocusTools({ app }: { app: AppState }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(() => new Intl.DateTimeFormat('en-CA', {timeZone:app.settings.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
  const [day, setDay] = useState<DayState | null>(null), [error, setError] = useState('');
  const load = async () => { const data = await request<DayState>(`/api/days/${date}`); setDay(data); return data; };
  useEffect(() => { if (!open) return; let live = true; setDay(null); setError(''); void request<DayState>(`/api/days/${date}`).then(value => { if (live) setDay(value); }).catch(failure => { if (live) setError(errorMessage(failure)); }); return () => { live = false; }; }, [date, open]);
  const plan = day?.log?.plan_snapshots.find(item => item.plan_version === day.log?.current_plan_version);
  return <details className="settings-section external-focus-tools" onToggle={event => setOpen(event.currentTarget.open)}><summary>高级：外部计时工具数据</summary><p>驾驶舱已经内置计时，不需要另装软件。若以前使用过“一刻”桌面版或浏览器扩展，可以在这里手动交换任务并核对导入的用时。</p><label className="field"><span className="field-label">核对日期</span><input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>{error && <p role="alert" className="planner-error">{error}</p>}{open && day && plan?.day_mode === 'work' ? <FocusBridge key={date} app={app} state={day} plan={plan} onChanged={load} /> : open && day ? <p className="planner-empty">此日期没有可交换的已确认工作任务，可继续使用内置时间记录。</p> : null}</details>;
}

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, LoaderCircle, RefreshCw } from 'lucide-react';
import { METRICS } from '../shared/contracts';
import { EVENT_STAGE_LABELS } from '../shared/day-contracts';
import type { CalendarDay, CalendarMonth } from '../shared/calendar-contracts';
import { getOdetteMood, type OdetteMood } from '../shared/odette-mood';
import { request, errorMessage } from './api';
import OdettePortrait from './OdettePortrait';
import './harvest-calendar.css';

type Tone = 'bloom' | 'harvest' | 'rest' | 'recorded' | 'empty' | 'future';
function tone(day: CalendarDay, today: string): Tone {
  if (day.date > today) return 'future';
  if (day.mode === 'rest') return 'rest';
  if (day.plannedTasks > 0 && day.completedTasks === day.plannedTasks) return 'bloom';
  if (day.completedTasks > 0) return 'harvest';
  if (day.hasHarvest) return 'harvest';
  return day.recorded ? 'recorded' : 'empty';
}
function label(day: CalendarDay, today: string) {
  const state = tone(day, today);
  return state === 'future' ? day.mode ? '已安排' : day.recorded ? '有记录' : '待安排' : state === 'bloom' ? '任务全完成' : state === 'harvest' ? '有收获' : state === 'rest' ? '休息日' : state === 'recorded' ? '已记录' : '未记录';
}
function moodFor(day: CalendarDay, today: string) {
  return getOdetteMood({ mode: day.mode ?? undefined, plannedTasks: day.plannedTasks, completedTasks: day.completedTasks, hasHarvest: day.hasHarvest, future: day.date > today, past: day.date < today });
}
function resultDescription(day: CalendarDay, today: string): string {
  if (day.mode === 'rest') return day.date > today ? '已提前安排休息，不计算完成比例' : day.hasHarvest ? '计划休息，另有已确认的收获' : '计划休息，不计算任务完成比例';
  if (day.date > today) return '这一天还未开始';
  if (day.plannedTasks === 0) return day.hasHarvest ? '无计划任务，已有确认的收获' : '当天未安排任务';
  const remaining = Math.max(0, day.plannedTasks - day.completedTasks);
  return `${day.completedTasks} / ${day.plannedTasks} 项已完成${remaining ? `，${remaining} 项未完成` : ''}`;
}
function dateCaption(day: CalendarDay, today: string): string {
  if (day.mode === 'rest') return day.date > today ? '休息安排' : '休息';
  if (day.date > today) return '待开始';
  if (day.plannedTasks > 0) return `${day.completedTasks}/${day.plannedTasks} 完成`;
  return day.hasHarvest ? '有收获' : day.recorded ? '已记录' : '未记录';
}
const MOOD_HEADLINES: Record<OdetteMood, string> = {
  expectant: '留一点期待，从一件事开始。', encouraging: '正在稳步推进。', happy: '今天已有新的收获。', ecstatic: '今天的任务已全部完成。', sad: '回顾一下，调整下一步。', resting: '安心休息，按自己的节奏继续。',
};
const MOOD_LEGEND: [OdetteMood, string][] = [['expectant', '待开始'], ['encouraging', '推进中'], ['happy', '有收获'], ['ecstatic', '已完成'], ['sad', '待调整'], ['resting', '休息']];
function moveMonth(month: string, amount: number) {
  const value = new Date(`${month}-15T12:00:00Z`); value.setUTCMonth(value.getUTCMonth() + amount); return value.toISOString().slice(0, 7);
}
const prettyDate = (date: string) => `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8))} 日`;

export default function HarvestCalendar({ date, revision, onOpenDay }: { date: string; revision: number; onOpenDay: (date: string) => void }) {
  const [month, setMonth] = useState(date.slice(0, 7));
  const [selected, setSelected] = useState(date);
  const [view, setView] = useState<CalendarMonth | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [refresh, setRefresh] = useState(0);
  const detail = useRef<HTMLElement>(null);
  function selectDay(value: string) { setSelected(value); if (window.matchMedia('(max-width: 900px)').matches) requestAnimationFrame(() => detail.current?.scrollIntoView({ block: 'nearest' })); }
  useEffect(() => { setMonth(date.slice(0, 7)); setSelected(date); }, [date]);
  useEffect(() => {
    let live = true; setView(null); setError(null);
    void request<CalendarMonth>(`/api/calendar/${month}`).then(data => { if (live) setView(data); }).catch(failure => { if (live) setError(failure); });
    return () => { live = false; };
  }, [month, revision, refresh]);
  const day = view?.days.find(item => item.date === selected);
  const observed = view?.days.filter(item => item.date <= view.today) ?? [];
  const harvestDays = observed.filter(item => item.completedTasks > 0 || item.hasHarvest).length;
  const completed = observed.reduce((sum, item) => sum + item.completedTasks, 0);
  const restDays = observed.filter(item => item.mode === 'rest').length;
  const offset = (new Date(`${month}-01T12:00:00Z`).getUTCDay() + 6) % 7;
  function navigateMonth(amount: number) { const next = moveMonth(month, amount); setMonth(next); setSelected(`${next}-01`); }
  const selectedTone = day && view ? tone(day, view.today) : 'empty';
  const selectedMood = day && view ? moodFor(day, view.today) : null;

  return <section className="harvest-calendar" aria-label="收获日历">
    <div className="harvest-month-heading"><div><span>收获日历 · 每一份收获，都留下痕迹</span><h1>{month.slice(0, 4)} <small>年</small> {Number(month.slice(5))} <small>月</small></h1></div><div className="harvest-month-controls"><button className="icon-button" aria-label="上个月" disabled={month === '0000-01'} onClick={() => navigateMonth(-1)}><ChevronLeft size={17} /></button><button className="button-secondary" disabled={!view} onClick={() => { if (view) { setMonth(view.today.slice(0, 7)); setSelected(view.today); } }}>回到今天</button><button className="icon-button" aria-label="下个月" disabled={month === '9999-12'} onClick={() => navigateMonth(1)}><ChevronRight size={17} /></button></div></div>
    {error ? <div className="harvest-load-error" role="alert"><p>{errorMessage(error)}</p><button className="button-secondary" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} />重试日历</button></div> : !view ? <div className="harvest-loading" role="status"><LoaderCircle className="spin" size={20} />正在读取这个月的收获…</div> : <>
      <div className="harvest-month-stats"><div><strong>{harvestDays}<small>天</small></strong><span>留下收获</span></div><div><strong>{completed}<small>项</small></strong><span>任务完成</span></div><div><strong>{restDays}<small>天</small></strong><span>安排休息</span></div><p>全部项目 · 截至今天的记录</p></div>
      <div className="harvest-layout"><div className="harvest-month-panel"><div className="harvest-weekdays" aria-hidden="true">{['一', '二', '三', '四', '五', '六', '日'].map(value => <span key={value}>{value}</span>)}</div><div className="harvest-month-grid" role="group" aria-label={`${month}的日期`}>
        {Array.from({ length: offset }, (_, i) => <span className="harvest-calendar-blank" key={`blank-${i}`} aria-hidden="true" />)}
        {view.days.map(item => { const state = tone(item, view.today); const mood = moodFor(item, view.today); return <button key={item.date} type="button" className={`harvest-date tone-${state} ${selected === item.date ? 'is-selected' : ''} ${item.date === view.today ? 'is-today' : ''}`} data-mood={mood.mood} aria-pressed={selected === item.date} aria-current={item.date === view.today ? 'date' : undefined} aria-label={`${item.date}，${resultDescription(item, view.today)}；进度${mood.label}`} onClick={() => selectDay(item.date)}><span className="harvest-date-number">{Number(item.date.slice(8))}{item.date === view.today && <i aria-hidden="true" />}</span><span className="harvest-date-mark"><OdettePortrait mood={mood.mood} decorative /></span><span className="harvest-date-caption">{dateCaption(item, view.today)}</span></button>; })}
      </div><div className="harvest-legend" aria-label="六种进度状态">{MOOD_LEGEND.map(([mood, name]) => <span key={mood}><OdettePortrait mood={mood} size="tiny" decorative />{name}</span>)}</div></div>
      <aside ref={detail} className={`harvest-detail tone-${selectedTone}`} data-mood={selectedMood?.mood} aria-label="所选日期的收获"><div className="harvest-detail-date">{prettyDate(selected)}<span>{day ? label(day, view.today) : ''}</span></div><div className="harvest-detail-art">{selectedMood && <OdettePortrait mood={selectedMood.mood} label={selectedMood.label} size="hero" />}</div><h3>{day && day.date > view.today ? day.mode === 'rest' ? '这一天已安排休息。' : '给这一天留一点期待。' : selectedMood ? MOOD_HEADLINES[selectedMood.mood] : '留一点期待。'}</h3>
        {day && <><p className="harvest-detail-message">{selectedMood?.message}</p>
          {day.plannedTasks > 0 && day.mode !== 'rest' && day.date <= view.today && <div className="harvest-detail-progress"><span>已完成 <strong>{day.completedTasks} / {day.plannedTasks}</strong></span><div role="progressbar" aria-label="所选日期已完成的任务数量" aria-valuemin={0} aria-valuemax={day.plannedTasks} aria-valuenow={day.completedTasks} aria-valuetext={resultDescription(day, view.today)}><i style={{ width: `${day.completedTasks / day.plannedTasks * 100}%` }} /></div><small>{day.plannedTasks - day.completedTasks} 项未完成</small></div>}
          {day.totals.length > 0 && <ul className="harvest-detail-totals">{day.totals.map(total => { const metric = METRICS.find(item => item.key === total.metric)!; return <li key={`${total.metric}-${total.stage}`}><strong>{BigInt(total.value).toLocaleString('zh-CN')} <small>{metric.unit}</small></strong><span>{metric.label}<small>{EVENT_STAGE_LABELS[total.stage]}</small></span></li>; })}</ul>}
          {day.mode === 'rest' && day.hasHarvest && <p className="harvest-detail-note">这天安排休息，另外留下的成果也已保留。</p>}
          {day.unresolvedEvents > 0 && <p className="harvest-detail-note">有 {day.unresolvedEvents} 条章节记录待核对，暂未计入确定数量。</p>}
        </>}
        <button className="button-primary harvest-open-day" onClick={() => onOpenDay(selected)}>{selected > view.today ? '安排这一天' : '查看当天任务与成果'}<ArrowRight size={15} /></button>
      </aside></div>
      <p className="harvest-footnote">进度状态随任务完成情况变化。点完成就计入进展；数量、成果和实际投入按已有记录分别保留。</p>
    </>}
  </section>;
}

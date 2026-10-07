import { useEffect, useState } from 'react';
import { request, errorMessage } from './api';
import { METRICS } from '../shared/contracts';
import { DIMENSION_LABELS, EVENT_STAGE_LABELS } from '../shared/day-contracts';
import type { DashboardDay, DashboardView, MetricTotal } from '../shared/dashboard-contracts';
import './dashboard-styles.css';

function completionLabel(day: DashboardDay) {
  if (day.mode === 'rest') return '休息';
  if (!day.plannedTasks) return '未安排任务';
  return `${day.completedTasks}/${day.plannedTasks} 已完成`;
}

function completionDetail(day: DashboardDay) {
  if (day.mode === 'rest') return '休息日不计算完成比例';
  if (!day.plannedTasks) return '安排一件事，完成后点一下';
  return `${Math.round(day.completedTasks / day.plannedTasks * 100)}% 已完成 · ${day.plannedTasks - day.completedTasks} 项未完成`;
}

function scoreLabel(day: DashboardDay) {
  if (!day.recorded) return '未记录';
  if (day.mode === 'rest') return '休息 · 不计分';
  if (!day.mode) return '未确认计划';
  if (day.score.status === 'not_applicable') return '无计分任务';
  if (day.score.status === 'finalized') return `${day.score.display.final} 分`;
  if (day.score.tasks.every(task => task.actual === null)) return '验收结果未知';
  return `${day.score.display.lower}–${day.score.display.upper} · ${day.score.missing_task_ids.length ? '待补充' : '待结算'}`;
}
function Totals({ items }: { items: MetricTotal[] }) {
  return items.length ? <ul className="metric-totals">{items.map(item => { const metric = METRICS.find(m => m.key === item.metric)!; return <li key={`${item.metric}:${item.stage}`}><strong>{item.value} {metric.unit}</strong><span>{metric.label} · {EVENT_STAGE_LABELS[item.stage]} · 账面记录</span></li>; })}</ul> : <p className="day-subtle">暂无有效成果记录，不能据此判断没有产出。</p>;
}
export default function Dashboard({ date, revision, onDate }: { date: string; revision: number; onDate: (date: string) => void }) {
  const [view, setView] = useState<DashboardView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { let active = true; setView(null); setError(null); void request<DashboardView>(`/api/dashboard/${date}`).then(data => { if (active) setView(data); }).catch(failure => { if (active) setError(failure); }); return () => { active = false; }; }, [date, revision, refresh]);
  if (error) return <section className="dashboard"><p role="alert">{errorMessage(error)}</p><button className="button-secondary" onClick={() => setRefresh(n => n + 1)}>重试经营概览</button></section>;
  if (!view) return <section className="dashboard" aria-busy="true">正在汇总经营记录…</section>;
  const today = view.days[6]; const yesterday = view.days[5];
  return <section className="dashboard" aria-label="经营概览"><div className="day-section-heading"><div><span className="eyebrow">YOUR COMPANY AT A GLANCE</span><h2>经营概览</h2></div><button className="button-quiet" onClick={() => setRefresh(n => n + 1)}>刷新概览</button></div>
    <p className="day-subtle">全部项目 · 截至所选日期 {date} · 采用各日保存的业务日期与时区</p>
    <div className="cockpit-cards"><div><span>本日任务完成</span><strong>{completionLabel(today)}</strong><small>{completionDetail(today)}</small></div><div><span>本日已记录投入</span><strong>{today.actualMinutes === null ? '未记录' : `${today.actualMinutes} 分钟`}</strong><small>{today.recordedBlocks} 个时段已记录</small></div><div><span>前一日 · {yesterday.date.slice(5)}</span><strong>{completionLabel(yesterday)}</strong><small>{completionDetail(yesterday)}</small><button className="button-quiet" onClick={() => onDate(yesterday.date)}>查看前一日记录 →</button></div></div>
    <details className="dashboard-details"><summary>近七天趋势 · {view.start} 至 {view.end}</summary><p className="day-subtle">完成 {view.days.reduce((sum, day) => sum + day.completedTasks, 0)} 项任务；{view.recordedTimeDays}/7 天有投入记录，合计 {view.actualMinutes === null ? '未知' : `${view.actualMinutes} 分钟（已记录部分）`}。</p>
      <div className="trend-grid">{view.days.map(day => <button key={day.date} className={`trend-day ${day.date === date ? 'selected' : ''}`} onClick={() => onDate(day.date)}><span>{day.date.slice(5)}</span><strong>{completionLabel(day)}</strong><small>{day.actualMinutes === null ? '投入未记录' : `已记 ${day.actualMinutes} 分钟`}</small><span className="trend-track" aria-hidden="true">{day.mode !== 'rest' && day.plannedTasks > 0 && <span style={{ width: `${day.completedTasks / day.plannedTasks * 100}%` }} />}</span><small>{completionDetail(day)}</small></button>)}</div>
      <h3>窗口内账面记录</h3><Totals items={view.totals} /><p className="day-subtle">按指标和交付阶段分别累计，采用最新有效更正；不同单位不相加。历史章号不全的批次可能重叠，已辨认数量请看项目页“长期积累”。这些不是项目存量或收入。</p>
      <details><summary>高级：履约评分与维度覆盖</summary><p className="day-subtle">按原有指标口径保留的分析，独立于任务完成标志，不影响日常完成统计。</p><ul>{view.dimensions.map(item => <li key={item.dimension}>{DIMENSION_LABELS[item.dimension]}：{item.applicableDays}/{item.workDays} 个已确认工作日适用</li>)}</ul>{view.days.filter(day => day.mode).map(day => <p key={day.date} className="day-subtle">{day.date} · {scoreLabel(day)} · {day.timezone} · 计划 v{day.planVersion} · {day.policy} · {day.dimensions.map(d => DIMENSION_LABELS[d]).join(' / ') || '无适用维度'} · 原始权重 {day.score.denominator}</p>)}</details>
    </details>
    <details className="dashboard-details"><summary>项目进展与待核对事项 · {view.projects.length} 个项目</summary><p className="day-subtle">项目状态取当前档案；计划和成果统计取上述七天窗口。未见记录不等于未推进；下方是账面数量，历史未核对章节可能重叠。</p><div className="project-pulses">{view.projects.map(project => <article key={project.id}><h3>{project.name} <small>{{ preparing: '准备中', active: '进行中', paused: '暂停', completed: '完成', archived: '归档' }[project.status]}</small></h3><p>安排 {project.plannedDays} 天 · 有成果记录 {project.eventDays} 天</p><Totals items={project.totals} />{project.attention.map(text => <p className="attention-note" key={text}>{text}</p>)}</article>)}</div></details>
  </section>;
}

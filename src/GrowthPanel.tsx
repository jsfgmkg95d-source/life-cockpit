import { useEffect, useState } from 'react';
import type { GrowthView } from '../shared/growth-contracts';
import { errorMessage, request } from './api';
import './growth-styles.css';

export default function GrowthPanel({ date, projectId, revision = 0 }: { date: string; projectId?: string; revision?: number | string }) {
  const [view, setView] = useState<GrowthView | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true; let generation = 0;
    const load = async () => { const current = ++generation; try { const next = await request<GrowthView>(`/api/growth/${date}`); if (live && current === generation) { setView(next); setError(''); } } catch (failure) { if (live && current === generation) { setView(null); setError(errorMessage(failure)); } } };
    void load(); const focused = () => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener('focus', focused); const timer = window.setInterval(focused, 30000);
    return () => { live = false; clearInterval(timer); window.removeEventListener('focus', focused); };
  }, [date, projectId, revision]);
  return <section className={`growth-panel ${projectId ? 'growth-compact' : ''}`} aria-label={projectId ? '项目长期积累' : '近七日经营复盘'}>
    <div className="growth-heading"><div><h3>{projectId ? '长期积累' : '这一周，留下了什么'}</h3></div><small>截至 {date}</small></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!view && !error && <p className="day-subtle">正在读取资产记录…</p>}
    {view && <>
      {!projectId && <p className="growth-coverage">近7日有记录 <strong>{view.recordedDays7}/7 天</strong> · 已记录投入 <strong>{view.actualMinutes7 ?? '未知'}{view.actualMinutes7 === null ? '' : '分钟'}</strong>（{view.timeDays7}天）<br /><small>前7日有记录 {view.recordedDaysPrevious}/7 天。缺少记录的日期保持未知，有记录也不代表全天完整。</small></p>}
      <div className="growth-projects">{view.projects.filter(p => projectId ? p.id === projectId : p.metrics.length > 0).map(p => <article className="growth-project" key={p.id}>
        {!projectId && <h4>{p.name}</h4>}
        {p.stock !== null && <p className="growth-stock">按基线推算 <strong>{p.stock}</strong>{p.unit}{p.remaining !== null && <small>距目标还差 {p.remaining}{p.unit}</small>}</p>}
        {!p.metrics.length && <p className="day-subtle">尚无成果记录，实际积累未知。</p>}
        {p.metrics.map(m => <div key={m.metric} className="growth-metric"><strong>{m.label}</strong><div className="growth-values"><span><b>{m.recent7}</b>{m.unit}<small>近7日已记录</small></span><span><b>{m.recent30}</b>{m.unit}<small>近30日已记录</small></span><span><b>{m.identified}</b>{m.unit}<small>累计已辨认</small></span></div>
          {!!m.unresolved && <p className="metric-warning">{m.unresolved} 批章号待核对，未纳入上述已辨认数量。原始账面共 {m.recorded}{m.unit}，可能重叠。</p>}
          <details><summary>比较与数据依据</summary><p>前7日已辨认 {m.previous7}{m.unit}。{m.recentUnresolved || m.previousUnresolved ? '比较窗口包含未核对批次，暂不判断增减趋势。' : '记录覆盖不同，不直接解释为效率变化。'}</p><p className="day-subtle">{m.source_ids.length} 条有效成果，可在对应业务日查看来源和更正历史。</p></details>
        </div>)}
        <p className="day-subtle">{p.stockNote}</p>
      </article>)}</div>
      {!projectId && view.projects.some(p => !p.metrics.length) && <p className="day-subtle">尚无资产记录：{view.projects.filter(p => !p.metrics.length).map(p => p.name).join('、')}。实际积累未知。</p>}
      {!projectId && <details className="growth-followup"><summary>上次采纳的建议，执行得怎样 · {view.adoptions.length} 项</summary>{view.adoptions.length ? view.adoptions.map((item, i) => <div key={`${item.reportId}-${i}`}><strong>{item.action}</strong><p>{item.targetDate} · {item.state}</p><p>{item.observed}</p></div>) : <p>近30日还没有可回看的建议采纳记录。</p>}<p className="day-subtle">这里只回看执行与验收，不把结果变化归因为某一条建议。</p></details>}
    </>}
  </section>;
}

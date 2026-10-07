import GrowthPanel from './GrowthPanel';
import { useEffect, useRef, useState } from 'react';
import { Check, RefreshCw, Sparkles } from 'lucide-react';
import type { DayState, Dimension } from '../shared/day-contracts';
import { DIMENSIONS, DIMENSION_LABELS } from '../shared/day-contracts';
import type { Adoption, Report, ReportType, ReportView, Suggestion } from '../shared/report-contracts';
import { errorMessage, request } from './api';
import './report-styles.css';

const REASONS: Record<string, string> = { LOCAL_MODE: '当前使用本地模式，未调用在线 AI。', KEY_NOT_CONFIGURED: '尚未配置密钥。', MODEL_NOT_CONFIGURED: '尚未配置模型。', AUTH_FAILED: '密钥或访问权限未通过验证。', TIMEOUT: '在线服务超时。', NETWORK_ERROR: '网络连接失败。', INVALID_OUTPUT: 'AI 输出格式未通过校验。', INVALID_REFERENCES: 'AI 引用了不存在的依据。', INVALID_PROJECT: 'AI 建议涉及不适用项目。', CANCELLED: '生成已取消。', DAILY_LIMIT: '已达到今天的调用次数上限。', INTERRUPTED: '上次生成被中断。', INPUT_TOO_LARGE: '当前资料过长，暂用本地摘要。', REFUSAL: '服务未能提供本次分析。', INCOMPLETE_OUTPUT: 'AI 输出未完整返回。' };
function reason(code: string | null) { return code ? REASONS[code] ?? '在线生成未成功，本地事实仍可查看。' : ''; }
function References({ ids, report }: { ids: string[]; report: Report }) {
  return <details className="report-refs"><summary>查看依据（{ids.length}）</summary>{ids.map(id => <p key={id}>{report.input_snapshot.facts.find(fact => fact.id === id)?.text ?? id}</p>)}</details>;
}
function AdoptForm({ report, suggestion, index, onDone, onClose, onDirty }: { report: Report; suggestion: Suggestion; index: number; onDone: (date: string) => void; onClose: () => void; onDirty: (dirty: boolean) => void }) {
  const next = new Date(`${report.input_snapshot.date}T12:00:00Z`); if (report.report_type === 'review') next.setUTCDate(next.getUTCDate() + 1);
  const [date, setDate] = useState(next.toISOString().slice(0, 10)); const [day, setDay] = useState<DayState | null>(null);
  const [action, setAction] = useState(suggestion.action); const [acceptance, setAcceptance] = useState(suggestion.acceptance); const [minutes, setMinutes] = useState(suggestion.estimated_minutes === null ? '' : String(suggestion.estimated_minutes));
  const [dimension, setDimension] = useState<Dimension | ''>(''); const [changeReason, setChangeReason] = useState(''); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [checked, setChecked] = useState(false);
  const keys = useRef(new Map<string, string>());
  useEffect(() => { onDirty(true); return () => onDirty(false); }, [onDirty]);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, []);
  useEffect(() => { let active = true; setDay(null); setChecked(false); void request<DayState>(`/api/days/${date}`).then(data => { if (active) setDay(data); }).catch(failure => { if (active) setError(failure); }); return () => { active = false; }; }, [date]);
  async function reload() { try { setDay(await request<DayState>(`/api/days/${date}`)); setChecked(false); setError(null); } catch (failure) { setError(failure); } }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!day || busy || !checked) return; setBusy(true); setError(null);
    const body = { target_date: date, target_revision: day.log?.revision ?? 0, suggestion_index: index, action, acceptance, estimated_minutes: minutes.trim() ? Number(minutes) : null, dimension, change_reason: changeReason };
    const signature = JSON.stringify(body); const key = keys.current.get(signature) ?? crypto.randomUUID(); keys.current.set(signature, key);
    try { await request(`/api/reports/${report.id}/adopt`, 'POST', { ...body, requestId: key }); onDirty(false); onDone(date); } catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  return <form className="adoption-form" onSubmit={event => void save(event)}><h3>把建议落到计划草稿</h3><p>项目：{report.input_snapshot.projects.find(project => project.id === suggestion.project_id)?.name}。保存后还需在目标日分配权重、核对容量并确认计划。</p>{!!error && <div role="alert" className="inline-error">{errorMessage(error)}<button type="button" disabled={busy} className="button-quiet" onClick={() => void reload()}>读取目标日最新草稿</button></div>}<fieldset disabled={busy}><div className="form-grid"><label className="field"><span>目标日期</span><input type="date" required value={date} onChange={event => { if (event.target.value) setDate(event.target.value); }} /></label><label className="field"><span>计分维度</span><select required value={dimension} onChange={event => setDimension(event.target.value as Dimension)}><option value="" disabled>请选择本次行动的维度</option>{DIMENSIONS.map(item => <option key={item} value={item}>{DIMENSION_LABELS[item]}</option>)}</select></label><label className="field span-two"><span>具体行动</span><input required maxLength={240} value={action} onChange={event => setAction(event.target.value)} /></label><label className="field span-two"><span>验收条件与具体对象</span><textarea required maxLength={2000} value={acceptance} placeholder="补充真实稿件、批次或交付对象，以及怎样才算达成。" onChange={event => setAcceptance(event.target.value)} /></label><label className="field"><span>预计分钟（未知可留空）</span><input type="number" min={0} max={1440} value={minutes} onChange={event => setMinutes(event.target.value)} /></label>{!!day?.log?.current_plan_version && <label className="field"><span>调整草稿的原因</span><textarea required value={changeReason} maxLength={2000} onChange={event => setChangeReason(event.target.value)} /></label>}</div></fieldset><p className="day-subtle">{day ? `目标日已有 ${day.log?.draft_plan?.tasks.length ?? day.log?.plan_snapshots.at(-1)?.tasks.length ?? 0} 项草稿或确认任务；本次追加一项，不覆盖已有安排。共享投入块会沿用，预算不会重复增加。新任务权重暂为 0，确认计划前需重新分配。` : '正在读取目标日安排…'}</p><label className="checkbox-label"><input type="checkbox" checked={checked} disabled={busy || !day} onChange={event => setChecked(event.target.checked)} />我已核对具体行动、验收与目标日安排，仅加入草稿。</label><div className="score-actions"><button className="button-primary" disabled={busy || !day || !checked}><Check size={14} />加入计划草稿</button><button type="button" className="button-secondary" disabled={busy} onClick={onClose}>放弃采纳</button></div></form>;
}
export default function ReportPanel({ date, type, revision = 0, onWork, onDirty, onChanged }: { date: string; type: ReportType; revision?: number; onWork: (date: string) => void; onDirty: (dirty: boolean) => void; onChanged?: () => void }) {
  const [view, setView] = useState<ReportView | null>(null); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [adopting, setAdopting] = useState<{ report: Report; index: number } | null>(null); const [savedDate, setSavedDate] = useState<string | null>(null);
  const generation = useRef(0); const keys = useRef(new Map<string, string>());
  useEffect(() => { const token = ++generation.current; let timer: ReturnType<typeof setTimeout> | undefined;
    async function tick() { try { const data = await request<ReportView>(`/api/days/${date}/reports/${type}`); if (token === generation.current) setView(data); } catch (failure) { if (token === generation.current) setError(failure); } finally {  } }
    setView(null); setError(null); void tick(); return () => { generation.current++; clearTimeout(timer); };
  }, [date, type, revision]);
  async function refresh() { try { setView(await request<ReportView>(`/api/days/${date}/reports/${type}`)); setError(null); } catch (failure) { setError(failure); } }
  async function generate(force: boolean) {
    if (!view || busy) return; setBusy(true); setError(null); const token = generation.current;
    const body = { revision: view.revision, input_hash: view.input_hash, force }; const signature = JSON.stringify({ date, type, ...body }); const key = keys.current.get(signature) ?? crypto.randomUUID(); keys.current.set(signature, key);
    try { const data = await request<ReportView>(`/api/days/${date}/reports/${type}`, 'POST', { ...body, requestId: key }); if (token === generation.current) { setView(data); keys.current.delete(signature); } } catch (failure) { if (token === generation.current) setError(failure); } finally { setBusy(false); }
  }
  async function cancel(id: string) { try { await request(`/api/reports/${id}/cancel`, 'POST', {}); await refresh(); } catch (failure) { setError(failure); } }
  const running = view?.reports.some(report => report.status === 'running');
  useEffect(() => {
    if (!running) return;
    let active = true; let pending = false;
    const timer = setInterval(async () => { if (pending) return; pending = true; try { const data = await request<ReportView>(`/api/days/${date}/reports/${type}`); if (active) setView(data); } catch (failure) { if (active) setError(failure); } finally { pending = false; } }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [date, type, running]);
  function card(report: Report) {
    return <article className="report-card" key={report.id}><div className="report-card-heading"><h3>{report.status === 'succeeded' ? 'AI 经营建议' : report.status === 'running' ? '正在生成…' : report.status === 'failed' ? '生成未完成' : '本地规则摘要'} · v{report.report_version}</h3><small>{report.stale ? '依据已变化 · 历史版本' : '依据当前记录'}</small></div>
      {report.stale && <p className="score-warning">报告所用项目或日记录已变化。请重新生成后采纳；历史内容保留供对照。</p>}
      {report.status === 'running' ? <><p>生成期间可以继续记录，完成后会检查依据是否仍有效。</p><button className="button-secondary" onClick={() => void cancel(report.id)}>取消生成</button></> : <>
        {report.run_meta.fallback_reason && <p className="day-subtle">{reason(report.run_meta.fallback_reason)}{report.status === 'degraded' ? ' 以下内容由本地规则整理，不是 AI 分析。' : ''}</p>}
        <details className="report-refs"><summary>已记录事实 · {report.input_snapshot.facts.length} 条</summary>{report.input_snapshot.facts.map(fact => <p key={fact.id}>{fact.text}</p>)}</details>
        {report.content && <><div className="report-digest"><p><strong>当前判断：</strong>{report.content.interpretations[0]?.text ?? '本地摘要整理事实，尚无 AI 经营判断。'}</p><p><strong>需要留意：</strong>{report.content.gaps[0]?.text ?? '当前摘要未列出信息缺口。'}</p><p><strong>下一步建议：</strong>{report.content.suggestions[0]?.action ?? '暂无可采纳建议。'}</p></div><details className="report-refs"><summary>展开完整分析、依据与可采纳建议</summary><h4>判断与不确定性</h4>{report.status === 'succeeded' && <p className="day-subtle">引用校验只确认来源存在，AI 的解释仍需你核对。</p>}{report.content.interpretations.length ? report.content.interpretations.map((item, i) => <div className="report-item" key={i}><p>{item.text}</p><p className="day-subtle">不确定性：{item.uncertainty}</p><References ids={item.source_ids} report={report} /></div>) : <p className="day-subtle">本地摘要不代替 AI 做经营判断。</p>}<h4>信息缺口</h4>{report.content.gaps.map((item, i) => <div className="report-item" key={i}><p>{item.text}</p><References ids={item.source_ids} report={report} /></div>)}<h4>{type === 'plan' ? '候选安排' : '后续建议'}</h4>{!report.content.suggestions.length && <p className="day-subtle">当前没有可采纳的项目建议。</p>}{report.content.suggestions.map((item, index) => { const adopted = view?.adoptions.find(row => row.report_id === report.id && row.suggestion_index === index); return <div className="report-suggestion" key={index}><strong>{report.input_snapshot.projects.find(project => project.id === item.project_id)?.name}</strong><p>{item.action}</p><p className="day-subtle">预计用时：{item.estimated_minutes === null ? '待核对' : `${item.estimated_minutes} 分钟`} · 取舍：{item.displaces}</p>{item.acceptance && <p>建议验收：{item.acceptance}</p>}<References ids={item.source_ids} report={report} />{adopted ? <button className="button-quiet" onClick={() => onWork(adopted.target_date)}>已加入 {adopted.target_date} 草稿 · 查看</button> : <button className="button-secondary" disabled={report.stale || !!adopting || busy || running} onClick={() => setAdopting({ report, index })}>核对并采纳</button>}</div>; })}</details></>}
        <details className="report-refs"><summary>运行信息</summary><p>服务：{report.run_meta.provider} · 模型：{report.run_meta.model ?? '未调用'} · 尝试 {report.run_meta.attempts.length} 次</p><p>输入 / 输出 token：{report.run_meta.input_tokens ?? '未知'} / {report.run_meta.output_tokens ?? '未知'}。费用未估算。</p><p>生成于 {new Date(report.created_at).toLocaleString('zh-CN', { timeZone: report.input_snapshot.timezone })} · 计划 v{report.plan_version}{report.score_id ? ' · 已关联固定评分版本' : ''}</p></details>
      </>}</article>;
  }
  return <section className="report-panel" aria-label={type === 'plan' ? '计划建议' : '经营报告'}>{type === 'review' && <GrowthPanel date={date} revision={revision} />}<div className="score-heading"><div><h2>{type === 'plan' ? '为今天准备候选安排' : '近七日经营复盘'}</h2></div><Sparkles size={19} /></div><p className="day-subtle">{view?.settings.mode === 'openai' ? !view.settings.has_key ? '在线模式尚未配置密钥，本次只生成本地摘要。可在设置中补充密钥。' : `点击生成会将下方事实摘要发送到 OpenAI（${view.settings.model}）；建议经你核对后才进入草稿。` : '当前为本地模式。可以整理事实、发现缺口并准备候选安排；在线 AI 可在设置中配置。'}</p>
    {!!error && <div className="inline-error" role="alert">{errorMessage(error)}<button className="button-quiet" onClick={() => void refresh()}>读取最新依据</button></div>}
    <div className="score-actions"><button className="button-primary" disabled={!view || busy || running || !!adopting} onClick={() => void generate(false)}><Sparkles size={14} />{running ? '正在生成' : type === 'plan' ? '生成计划建议' : '生成近七日复盘'}</button>{!!view?.reports.length && <button className="button-secondary" disabled={busy || running || !!adopting} onClick={() => void generate(true)}>重新生成并保留旧版</button>}<button className="button-quiet" disabled={busy || !!adopting} onClick={() => void refresh()}><RefreshCw size={13} />刷新</button></div>
    {view && <details className="report-refs"><summary>查看本次提供的事实摘要（{view.facts.length} 条）</summary>{view.facts.map(fact => <p key={fact.id}>{fact.text}</p>)}</details>}
    {savedDate && <p className="report-saved" role="status">已加入 {savedDate} 草稿，尚未确认生效。<button className="button-quiet" onClick={() => onWork(savedDate)}>前往核对计划</button></p>}
    {adopting && <AdoptForm key={`${adopting.report.id}:${adopting.index}`} report={adopting.report} suggestion={adopting.report.content!.suggestions[adopting.index]} index={adopting.index} onDirty={onDirty} onClose={() => setAdopting(null)} onDone={targetDate => { setAdopting(null); setSavedDate(targetDate); onChanged?.(); void refresh(); }} />}
    {view?.reports[0] && card(view.reports[0])}{view && view.reports.length > 1 && <details className="report-refs"><summary>历史报告 · {view.reports.length - 1} 份</summary>{view.reports.slice(1).map(card)}</details>}
    {!view?.reports.length && <p className="day-subtle">尚未生成报告。空白不会被解释为零收入或没有推进。</p>}
  </section>;
}

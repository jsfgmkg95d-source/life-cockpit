import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { DIMENSIONS, DIMENSION_LABELS, DIMENSION_WEIGHTS } from '../shared/day-contracts';
import type { SavedScore, ScoreCalculation, ScoreView } from '../shared/score-contracts';
import { errorMessage, request } from './api';
import './score-styles.css';
import ReportPanel from './ReportPanel';
import TimeReview from './TimeReview';
import GrowthPanel from './GrowthPanel';

function value(score: ScoreCalculation) {
  if (score.status === 'not_applicable') return '—';
  if (score.status === 'finalized') return score.display.final;
  return score.missing_task_ids.length ? `${score.display.lower}—${score.display.upper}` : score.display.lower;
}
function label(score: ScoreCalculation) {
  return score.reason === 'rest' ? '休息日 · 不评分' : score.reason === 'unplanned' ? '尚未确认计划' : score.reason === 'no_eligible_tasks' ? '没有适用任务' : score.status === 'finalized' ? '已结算' : score.missing_task_ids.length ? '结果待补充' : '待结算';
}
function Breakdown({ score }: { score: ScoreCalculation }) {
  return <div className="score-table-wrap"><table className="score-table"><caption>按已确认计划计算 · 适用原始权重合计 {score.denominator}</caption><thead><tr><th>项目 / 验收任务</th><th>维度 · 权重</th><th>确认量 / 目标</th><th>履约比例</th><th>贡献分</th></tr></thead><tbody>{score.tasks.map(task => <tr key={task.task_id}><td><strong>{task.project_name}</strong><span>{task.title}</span></td><td>{DIMENSION_LABELS[task.dimension]} · {task.weight}</td><td>{task.actual === null ? '未知' : task.actual} / {task.target}</td><td>{task.completion}</td><td>{task.contribution}</td></tr>)}</tbody></table><p className="day-subtle">贡献分单独显示时会舍入；总分由精确比例相加后计算。超额完成封顶为 100%。</p></div>;
}
function HistoryItem({ item, current }: { item: SavedScore; current: boolean }) {
  return <details className="score-history-item"><summary>评分 v{item.score_version} · 计划 v{item.plan_version} · {value(item)}{item.status !== 'not_applicable' ? ' 分' : ''} · {current ? '当前有效' : '历史记录'}<small>{label(item)} · {new Date(item.created_at).toLocaleString('zh-CN', { timeZone: item.input_snapshot.timezone })}</small></summary><p className="day-subtle">固定口径 {item.policy_id} · {current ? '与当前输入一致' : '保留当时事实；不代表当前结果'}</p>{item.tasks.length > 0 && <Breakdown score={item} />}<details><summary>查看当时的验收与事实依据</summary>{item.input_snapshot.results.map(result => <article className="score-evidence" key={result.task_id}><strong>{item.tasks.find(task => task.task_id === result.task_id)?.title}</strong><p>{result.result ? `用户确认 ${result.result.actual_value} · ${result.result.explanation || '未填写补充说明'}` : '验收结果未知'}</p>{result.result?.evidence_event_ids.map(id => { const event = item.input_snapshot.effective_events.find(event => event.id === id); return <p key={id}>{event ? `${event.artifact_key} · ${event.value} · ${event.summary} · 来源：${event.source}` : `证据标识：${id}`}</p>; })}</article>)}{!item.input_snapshot.results.length && <p>没有计分任务。</p>}</details></details>;
}
export default function ScorePanel({ date, revision = 0, onChanged, onWork }: { date: string; revision?: number; onChanged?: () => void; onWork?: () => void }) {
  const [view, setView] = useState<ScoreView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const keys = useRef(new Map<string, string>());
  useEffect(() => {
    const current = ++generation.current;
    setView(null); setError(null); setNotice('');
    void request<ScoreView>(`/api/days/${date}/scores`).then(data => { if (generation.current === current) setView(data); }).catch(failure => { if (generation.current === current) setError(failure); });
    return () => { generation.current++; };
  }, [date, revision]);
  async function refresh() {
    const current = generation.current;
    try { const data = await request<ScoreView>(`/api/days/${date}/scores`); if (current === generation.current) { setView(data); setError(null); } }
    catch (failure) { if (current === generation.current) setError(failure); }
  }
  async function save(settle: boolean) {
    if (!view || busy) return;
    const current = generation.current;
    setBusy(true); setError(null);
    const signature = `${date}:${view.revision}:${settle}`;
    const key = keys.current.get(signature) ?? crypto.randomUUID(); keys.current.set(signature, key);
    try {
      const data = await request<ScoreView>(`/api/days/${date}/${settle ? 'settle' : 'scores'}`, 'POST', { requestId: key, revision: view.revision });
      if (generation.current === current) { setView(data); setNotice(settle ? '本日已结算，事实与评分版本已保留。' : '评分版本已保存；相同输入复用已有版本。'); onChanged?.(); }
    } catch (failure) { if (generation.current === current) setError(failure); }
    finally { setBusy(false); }
  }
  const score = view?.preview;
  return <section className="score-panel" aria-label="今日计划履约分"><div className="score-heading"><div><div className="eyebrow">DAILY COMMITMENT</div><h2>今日计划履约分</h2></div><button className="button-quiet" disabled={busy} onClick={() => void refresh()}><RefreshCw size={13} />读取最新</button></div>
    {!!error && <div className="inline-error" role="alert"><p>{errorMessage(error)}</p><p>已有记录保留。读取最新内容，核对后再操作。</p></div>}
    {!score ? <p className="day-subtle">{error ? '评分暂不可用。' : '正在读取评分依据…'}</p> : <>
      <div className="score-overview"><div><div className="score-value">{value(score)}{score.status !== 'not_applicable' && <small>/ 100</small>}</div><span className="score-status">{label(score)} · 计划 v{view!.plan_version}</span></div><div className="score-coverage"><strong>{score.display.coverage}{score.coverage_basis_points !== null && '%'}</strong><span>结果确认覆盖率</span><small>按权重计算，不是完成率</small></div></div>
      <p className="day-subtle">衡量对当天承诺的履行程度。收入、资产价值和实际投入分别记录。</p>
      <details className="score-details"><summary>评分口径与适用范围</summary><p className="day-subtle">固定口径 v1：现金流 50、长期资产 30、健康 10、学习 10。只将已确认的适用维度归一到 100 分。未知结果不会变成零；明确未达成才按零计入。分数不能用于直接比较不同工作量的日期。</p>{view!.dimensions && DIMENSIONS.map(dimension => <p key={dimension}>{DIMENSION_LABELS[dimension]} · {DIMENSION_WEIGHTS[dimension]}：{view!.dimensions![dimension].applicable ? '已纳入当天计划' : `不适用（${view!.dimensions![dimension].reason}）`}</p>)}</details>
      {view!.history.length > 0 && !view!.current_score_id && <p className="score-warning">数据已变化，历史评分已过期。下方是最新预览，保存后形成新版本。</p>}
      {!!score.missing_task_ids.length && <div className="score-missing"><strong>还有 {score.missing_task_ids.length} 项结果未知</strong><p>{score.tasks.filter(task => task.actual === null).map(task => `${task.project_name}：${task.title}`).join('；')}</p><p>未填写的数量只影响这项分析，不影响任务的完成状态。需要时可在任务详情补充记录。</p>{onWork && <button className="button-secondary" onClick={onWork}>前往当天任务</button>}</div>}
      {score.tasks.length > 0 && <details className="score-details"><summary>查看任务贡献与计算依据</summary><Breakdown score={score} /></details>}
      {view!.can_settle && <p className="day-subtle">{score.reason === 'rest' ? '按休息日结束记录，不计分。' : '任务结果已确认，可直接结算今日评分，无需重复核对每项任务。'}</p>}
      <div className="score-actions"><button className="button-secondary" disabled={busy || !!view!.current_score_id} onClick={() => void save(false)}>{view!.current_score_id ? '当前版本已保存' : '保存评分版本'}</button>{view!.can_settle && <button className="button-primary" disabled={busy} onClick={() => void save(true)}><Check size={14} />确认本日结算</button>}{!view!.plan_version && onWork && <button className="button-secondary" onClick={onWork}>前往安排计划</button>}</div>
      {notice && <p role="status" className="day-subtle">{notice}</p>}
      {view!.comparisons.length > 0 && <details className="score-details"><summary>按原计划比较（{view!.comparisons.length} 个版本）</summary><p className="day-subtle">使用目前已确认的同日事实，分别按旧目标和旧权重重算。历史结算见下方记录。</p>{view!.comparisons.map(item => <div key={item.plan_version}><h3>按计划 v{item.plan_version}：{value(item.score)}{item.score.status !== 'not_applicable' ? ' 分' : ''}</h3><p>{label(item.score)}{item.change_reason ? ` · ${item.change_reason}` : ' · 首次承诺'}</p>{item.score.tasks.length > 0 && <Breakdown score={item.score} />}</div>)}</details>}
      <details className="score-details"><summary>评分历史 · {view!.history.length} 个版本</summary>{!view!.history.length ? <p className="day-subtle">尚未保存评分，当前只展示实时预览。</p> : view!.history.map(item => <HistoryItem key={item.id} item={item} current={item.id === view!.current_score_id} />)}</details>
    </>}
  </section>;
}

export function Review({ timezone, initialDate, onDateChange, onWork, onDirty }: { timezone: string; initialDate?: string; onDateChange?: (date: string) => void; onWork: (date: string) => void; onDirty: (value: boolean) => void }) {
  const [date, setDate] = useState(() => initialDate ?? new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));
  const dirty = useRef(false);
  const onReportDirty = useCallback((value: boolean) => { dirty.current = value; onDirty(value); }, [onDirty]);
  function changeDate(next: string) {
    if (!next || next === date || (dirty.current && !window.confirm('采纳表单尚未保存，切换日期会放弃修改。继续吗？'))) return;
    setDate(next);
    onDateChange?.(next);
  }
  return <div className="review-page">
    <div className="page-heading"><div><h1>回顾与积累</h1><p>看清时间的投入，也看见留下的成果。</p></div><label className="field"><span className="field-label">复盘日期</span><input type="date" value={date} onChange={event => changeDate(event.target.value)} /></label></div>
    <div className="review-checkline"><span>任务结果、成果来源和实际用时，以当天记录为准。</span><button className="button-quiet" type="button" onClick={() => onWork(date)}>查看当天记录 →</button></div>
    <TimeReview key={`time-${date}`} date={date} />
    <GrowthPanel key={`growth-${date}`} date={date} />
    <details className="secondary-panel review-analysis"><summary>数量分析与历史评分（选填）</summary><p className="day-subtle">任务完成以你点击“完成”为准。这里保留按成果数量计算的历史口径，可按需补充。</p><ScorePanel key={date} date={date} onWork={() => onWork(date)} /></details>
    <details className="secondary-panel review-analysis"><summary>近七日经营分析与后续建议</summary><ReportPanel key={`review-${date}`} date={date} type="review" onWork={onWork} onDirty={onReportDirty} /></details>
    <div className="quiet-note">完成的任务和真实投入分别记录，补充数量与来源由你决定。</div>
  </div>;
}

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CalendarDays, Check, LoaderCircle, Plus, X } from 'lucide-react';
import type { AppState, Project } from '../shared/contracts';
import type { DayState, DeltaMetric } from '../shared/day-contracts';
import { buildQuickTaskDraft, type QuickTaskInput } from '../shared/quick-task';
import { orderedMetrics } from '../shared/workflow';
import { ApiError, errorMessage } from './api';
import './quick-task.css';

interface Props {
  app: AppState;
  state: DayState;
  initialProjectId: string | null;
  initialTitle?: string;
  initialMinutes?: number | null;
  onSave: (input: QuickTaskInput, revision: number) => Promise<DayState>;
  onRefresh: () => Promise<{ app: AppState; state: DayState }>;
  onClose: () => void;
  onDirty: (dirty: boolean) => void;
  onAdded: (projectId: string) => void;
  onNotice: (text: string) => void;
}
const STATUS = { preparing: '准备中', active: '进行中', paused: '已暂停', completed: '项目已结束', archived: '已归档' };
const number = (value: string) => value.trim() === '' ? null : Number(value);
const currentPlan = (state: DayState) => state.log?.plan_snapshots.find(plan => plan.plan_version === state.log?.current_plan_version) ?? null;
function budgetFor(app: AppState, project?: Project) { return project ? app.settings.shared_budget_groups.find(group => group.project_ids.includes(project.id))?.budget_minutes ?? project.daily_budget_minutes : null; }
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>; }

export default function QuickTaskDialog(props: Props) {
  const { onSave, onRefresh, onClose, onDirty, onAdded, onNotice } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const [base, setBase] = useState({ app: props.app, state: props.state });
  const initialProject = props.app.projects.find(project => project.id === props.initialProjectId);
  const [projectId, setProjectId] = useState(initialProject?.id ?? '');
  const [title, setTitle] = useState(props.initialTitle ?? (initialProject?.next_action && initialProject.next_action.length <= 240 ? initialProject.next_action : ''));
  const [acceptance, setAcceptance] = useState('');
  const [quant, setQuant] = useState(false);
  const [metric, setMetric] = useState<DeltaMetric | null>(initialProject?.primary_metric_key && initialProject.primary_metric_key !== 'followers' ? initialProject.primary_metric_key : null);
  const [target, setTarget] = useState('');
  const [minutes, setMinutes] = useState(String(props.initialMinutes ?? budgetFor(props.app, initialProject) ?? ''));
  const [capacity, setCapacity] = useState(String(currentPlan(props.state)?.available_minutes ?? props.app.settings.available_minutes ?? ''));
  const [resume, setResume] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [dirty, setDirty] = useState(false);
  const project = base.app.projects.find(item => item.id === projectId);
  const plan = currentPlan(base.state);
  const inactive = !!project && !['preparing', 'active'].includes(project.status);
  const workPlan = plan?.day_mode === 'work';
  const input: QuickTaskInput = { project_id: projectId, project_revision: project?.revision ?? 0, title: title.trim(), acceptance: acceptance.trim() || '由我点击完成', result_type: quant ? 'quant' : 'binary', metric_key: quant ? metric : null, target_value: quant ? number(target) : 1, budget_minutes: number(minutes), available_minutes: workPlan ? plan.available_minutes : number(capacity), resume_project: inactive && resume, acknowledgeOverCapacity: ack };
  let preview = null, previewError = '';
  if (project) { try { preview = buildQuickTaskDraft(base.state, base.app, input); } catch (failure) { previewError = errorMessage(failure); } }
  const task = preview?.tasks.at(-1);
  const block = preview?.work_blocks.find(item => item.id === task?.work_block_id);
  const joined = !!block && !!plan?.work_blocks.some(item => item.id === block.id);
  const total = preview?.work_blocks.reduce((sum, item) => sum + (item.budget_minutes ?? 0), 0) ?? 0;
  const over = input.available_minutes !== null && total > input.available_minutes;
  const valid = !!project && !!input.title && !!input.acceptance && !!preview && !previewError && (!inactive || resume)
    && (input.available_minutes === null || input.available_minutes >= 0) && (joined || input.budget_minutes === null || input.budget_minutes >= 0)
    && (!quant || (!!metric && (number(target) ?? 0) > 0)) && (!over || ack);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; const modal = dialog.current; modal?.showModal(); modal?.querySelector<HTMLElement>(initialProject ? 'input[maxlength="240"]' : 'select')?.focus(); return () => { modal?.close(); previous?.focus(); }; }, []);
  useEffect(() => { onDirty(dirty || busy); }, [dirty, busy, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  function close() { if (!busy && (!dirty || window.confirm('这项任务还未添加，确定放弃填写吗？'))) onClose(); }
  function chooseProject(value: string) {
    const next = base.app.projects.find(item => item.id === value); setProjectId(value); setResume(false); setAck(false); setError(null);
    if (props.initialMinutes == null && (!minutes.trim() || minutes === String(budgetFor(base.app, project) ?? ''))) setMinutes(String(budgetFor(base.app, next) ?? ''));
    setMetric(next?.primary_metric_key && next.primary_metric_key !== 'followers' ? next.primary_metric_key : null);
    if (!title.trim() || title === project?.next_action) setTitle(next?.next_action && next.next_action.length <= 240 ? next.next_action : '');
  }
  async function refresh() {
    setBusy(true);
    try { const next = await onRefresh(); setBase(next); setError(null); setAck(false); if (!currentPlan(next.state) || currentPlan(next.state)?.day_mode === 'rest') setCapacity(String(currentPlan(next.state)?.available_minutes ?? next.app.settings.available_minutes ?? '')); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || !valid) return; setBusy(true); setError(null);
    try { await onSave(input, base.state.log?.revision ?? 0); setDirty(false); onNotice(`已加入 ${base.state.business_date}：${input.title}`); onAdded(projectId); }
    catch (failure) { setError(failure); setBusy(false); }
  }
  return <dialog className="modal day-modal quick-task-modal" ref={dialog} aria-labelledby="quick-task-title" onCancel={event => { event.preventDefault(); close(); }}><form onSubmit={event => void save(event)} onChange={() => setDirty(true)}><header className="modal-header"><div><h2 id="quick-task-title">添加当日任务</h2><p><CalendarDays size={13} />{base.state.business_date} · 只添加这项，其他任务保留</p></div><button type="button" className="icon-button" aria-label="关闭添加任务" disabled={busy} onClick={close}><X size={18} /></button></header>
    <div className="modal-content">
      {!!error && <div className="inline-error" role="alert"><p>{errorMessage(error)}</p>{error instanceof ApiError && error.status === 409 && <button type="button" className="button-secondary" disabled={busy} onClick={() => void refresh()}>读取最新状态，保留填写内容</button>}</div>}
      <fieldset disabled={busy} className="quick-task-fields">
        <Field label="所属项目"><select autoFocus={!initialProject} required value={projectId} onChange={event => chooseProject(event.target.value)}><option value="">选择一个项目</option>{base.app.projects.map(item => <option key={item.id} value={item.id}>{item.name}{['active', 'preparing'].includes(item.status) ? '' : ` · ${STATUS[item.status]}`}</option>)}</select></Field>
        {inactive && <label className="quick-resume checkbox-label"><input type="checkbox" checked={resume} onChange={event => setResume(event.target.checked)} /><span>将“{project!.name}”恢复为进行中，并添加这项任务<small>此项目目前{STATUS[project!.status]}；仅恢复这个项目。</small></span></label>}
        <Field label="当天要做什么"><input autoFocus={!!initialProject} required maxLength={240} value={title} onChange={event => setTitle(event.target.value)} placeholder="写清这一次要做的事" /></Field>
        <Field label="完成标志（选填）" hint="你自己决定怎样算完成；留空就由你点击完成。"><textarea rows={2} maxLength={2000} value={acceptance} onChange={event => setAcceptance(event.target.value)} placeholder="例如：我写完这一章，或我的脚本返回成功" /></Field>
        <div className="quick-task-budget">{joined ? <p className="quick-task-shared"><Check size={15} /><span>使用已有“{block?.title}”时段<small>预算共 {block?.budget_minutes} 分钟，这项任务不重复加时。</small></span></p> : <Field label="预计用时（分钟，选填）" hint={project && base.app.settings.shared_budget_groups.some(group => group.project_ids.includes(project.id)) ? '共享组预算；随后添加同组项目时不会重复累计。' : undefined}><input type="number" min="0" step="1" value={minutes} onChange={event => { setMinutes(event.target.value); setAck(false); }} /></Field>}
        {!workPlan && <Field label="当天可用时间（分钟，选填）" hint="暂不确定可以留空，实际用时由计时单独记录。"><input type="number" min="0" step="1" value={capacity} onChange={event => { setCapacity(event.target.value); setAck(false); }} /></Field>}</div>
        <details className="quick-task-quantity"><summary>目标数量（选填）{quant ? ' · 已启用' : ''}</summary><label className="checkbox-label"><input type="checkbox" checked={quant} onChange={event => setQuant(event.target.checked)} />记录字数、章节、文章等目标数量</label>{quant && <div className="quick-task-budget"><Field label="成果类型"><select required value={metric ?? ''} onChange={event => setMetric((event.target.value || null) as DeltaMetric | null)}><option value="">选择成果类型</option>{orderedMetrics(project).map(item => <option key={item.key} value={item.key}>{item.label} · {item.unit}</option>)}</select></Field><Field label="目标数量"><input required type="number" min="1" step="1" value={target} onChange={event => setTarget(event.target.value)} /></Field></div>}</details>
        {project && preview && <div className="quick-task-preview"><strong>加入后：{preview.tasks.length} 项任务 · {preview.work_blocks.some(item => item.budget_minutes === null) ? '用时待安排' : `预计 ${total} 分钟`}</strong><span>{input.available_minutes === null ? '可用时间尚未设置' : over ? `超出可用时间 ${total - input.available_minutes} 分钟` : `可用 ${input.available_minutes} 分钟`}</span>{plan?.day_mode === 'rest' && <p>本日将从“休息”改为“工作日”，原休息安排仍保留在历史中。</p>}{base.state.log?.draft_plan && <p>另有未确认草稿。本次只加入这项，原草稿继续保留。</p>}</div>}
        {previewError && <p className="inline-error" role="alert">{previewError}</p>}
        {over && <label className="checkbox-label capacity-ack"><input type="checkbox" checked={ack} onChange={event => setAck(event.target.checked)} />已看到超出容量，仍加入这项任务</label>}
        {plan && <details className="quick-task-note"><summary>已有安排如何保留</summary><p>任务、成果和原计划版本保留。同类任务的计分权重自动按原比例调整；可在完整计划中继续修改。加入正在计时的共享时段时，需要先暂停计时。</p></details>}
      </fieldset>
    </div><footer className="modal-footer"><span className="save-note">添加后直接出现在当日任务中</span><button type="button" className="button-secondary" disabled={busy} onClick={close}>取消</button><button type="submit" className="button-primary" disabled={busy || !valid}>{busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{inactive ? '恢复项目并添加任务' : '添加到当日任务'}</button></footer></form></dialog>;
}

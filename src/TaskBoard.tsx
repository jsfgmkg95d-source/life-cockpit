import { BookOpen, Check, FileText, Clock3, Pin, Play, Trash2, Undo2 } from 'lucide-react';
import { METRICS, type AppState } from '../shared/contracts';
import { DIMENSION_LABELS, type DailyTask, type DayState, type WorkBlock } from '../shared/day-contracts';
import { taskBoardState } from '../shared/task-board';
import { metricWarning } from '../shared/workflow';
import './task-board.css';

const STATUS_LABELS = { todo: '待开始', doing: '进行中', done: '已完成', cancelled: '已取消' };
interface Props {
  app: AppState; state: DayState; tasks: DailyTask[]; allTasks: DailyTask[]; blocks: WorkBlock[];
  highlightedTaskId?: string | null; allowFocus?: boolean;
  pinned: Set<string>; busy: boolean; filtered: boolean;
  onFocus: (task: DailyTask) => void;
  onRemove: (task: DailyTask) => void;
  onStatus: (task: DailyTask, status: DailyTask['status']) => void;
  onPin: (task: DailyTask) => void; onFinish: (task: DailyTask) => void;
  onRecord: (task: DailyTask) => void; onResult: (task: DailyTask) => void; onActual: (block: WorkBlock) => void;
}
export default function TaskBoard(props: Props) {
  const { app, state, tasks, allTasks, blocks, pinned, busy, filtered, onFocus, onRemove, onStatus, onPin, onFinish, onRecord, onResult, onActual } = props;
  const views = [...tasks].sort((a, b) => Number(pinned.has(b.task_id)) - Number(pinned.has(a.task_id))).map(task => ({ task, ...taskBoardState(task) }));
  const completed = views.filter(view => view.completed).length;
  const pending = views.filter(view => !['done', 'cancelled'].includes(view.column));
  const closed = views.filter(view => view.completed);
  const cancelled = views.filter(view => view.column === 'cancelled');
  const plan = state.log?.plan_snapshots.find(item => item.plan_version === state.log?.current_plan_version);
  const budget = plan && plan.work_blocks.every(block => block.budget_minutes !== null)
    ? plan.work_blocks.reduce((sum, block) => sum + (block.budget_minutes ?? 0), 0) : null;
  function row(task: DailyTask) {
    const view = taskBoardState(task);
    const project = app.projects.find(item => item.id === task.project_id);
    const metric = METRICS.find(item => item.key === task.metric_key);
    const block = blocks.find(item => item.id === task.work_block_id);
    const shared = allTasks.filter(item => item.work_block_id === task.work_block_id).length > 1;
    const warning = metricWarning(project, task.metric_key, task.acceptance);
    const acceptance = task.acceptance.trim() || '由我点击完成';
    const actualTime = state.log?.work_block_actuals.find(item => item.block_id === task.work_block_id);
    const estimate = block?.budget_minutes;
    const canFocus = task.status === 'todo' || task.status === 'doing';
    const quantityEvents = state.effective_events.filter(event => event.task_id === task.task_id && event.metric_key === task.metric_key);
    const recordedQuantity = quantityEvents.length ? quantityEvents.reduce((sum, event) => sum + (event.value ?? 0), 0) : view.actual;
    const action = view.completed ? '撤销完成' : task.status === 'cancelled' ? '恢复任务' : '完成';
    return <article className={`task-row state-${view.column} ${view.completed ? 'outcome-achieved' : ''} ${props.highlightedTaskId === task.task_id ? 'is-search-target' : ''}`} data-task-id={task.task_id} tabIndex={-1} key={task.task_id} aria-label={`${project?.name ?? task.project_name}：${task.title}`}>
      <span className="task-row-mark" aria-hidden="true">{view.completed ? <Check size={18} /> : project?.project_type === 'novel' ? <BookOpen size={18} strokeWidth={1.6} /> : <FileText size={18} strokeWidth={1.6} />}</span>
      <div className="task-row-copy"><div className="task-row-project">{project?.name ?? task.project_name}{shared && <span>共享时段</span>}{pinned.has(task.task_id) && <Pin size={11} aria-label="已置顶" />}</div><h4>{task.title}</h4><p className="task-row-time">预计 {estimate == null ? '未填写' : `${estimate} 分钟`}{shared ? '（共享）' : ''}<span>实际 {actualTime ? `${actualTime.minutes} 分钟${shared ? '（共享）' : ''}` : '未记录'}</span></p></div>
      <div className="task-row-result"><span className="task-row-outcome">{STATUS_LABELS[task.status]}</span></div>
      <div className="task-row-actions">{canFocus && <button type="button" className="button-quiet task-focus-action" disabled={busy || props.allowFocus === false} title={props.allowFocus === false ? '只能计时今天的任务，历史投入可补记' : undefined} onClick={() => onFocus(task)} aria-label={`开始计时：${task.title}`}><Play size={13} />开始计时</button>}<button type="button" className={`${view.completed || task.status === 'cancelled' ? 'button-quiet' : 'button-primary'} task-row-action`} disabled={busy} onClick={() => task.status === 'cancelled' ? onStatus(task, 'todo') : onFinish(task)} aria-label={`${action}：${task.title}`}>{view.completed ? <Undo2 size={14} /> : <Check size={14} />}{action}</button><button type="button" className="button-quiet task-remove-action" disabled={busy} onClick={() => onRemove(task)} aria-label={`从当天移除：${task.title}`}><Trash2 size={15} />移除当天</button></div>
      <details className="task-row-details"><summary>详情</summary><p>完成标志：{acceptance}</p><p>{DIMENSION_LABELS[task.scoring_dimension]} · {shared ? '共享时段，时间仅记一次' : block?.budget_minutes === null || !block ? '预算未填写' : `预计 ${block.budget_minutes} 分钟`}</p>{task.result_type === 'quant' && <p>数量记录（选填）：{recordedQuantity === null ? '未记录' : recordedQuantity.toLocaleString('zh-CN')} / {task.target_value?.toLocaleString('zh-CN') ?? '—'} {metric?.unit} · {metric?.label}</p>}{warning && <p className="metric-warning">{warning}</p>}{!view.completed && <label><span>任务状态</span><select aria-label={`${task.title}的任务状态`} value={task.status} disabled={busy} onChange={event => onStatus(task, event.target.value as DailyTask['status'])}>{Object.entries(STATUS_LABELS).filter(([value]) => value !== 'done').map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>}<div className="task-row-more"><button type="button" className="button-quiet" disabled={busy} aria-label={`${pinned.has(task.task_id) ? '取消置顶' : '置顶'}：${task.title}`} aria-pressed={pinned.has(task.task_id)} onClick={() => onPin(task)}><Pin size={12} />{pinned.has(task.task_id) ? '取消置顶' : '置顶'}</button><button type="button" className="button-quiet" disabled={busy} onClick={() => onRecord(task)}>补充记录</button>{task.result_state === 'confirmed' && <button type="button" className="button-quiet" disabled={busy} onClick={() => onResult(task)}>编辑旧结果</button>}</div></details>
    </article>;
  }
  return <div className="task-board-shell task-list-shell"><div className="task-list-summary" aria-label="任务完成概览"><div><strong>{filtered ? '当前项目' : '今日任务'}</strong><span className="task-list-count">{pending.length} 项待处理</span></div><div className="task-list-meta"><span>{filtered ? '全天预计' : '预计'} {budget ?? '—'} 分钟</span><span>{completed} / {tasks.length} 项已完成</span></div></div><div aria-label="每日任务看板">{pending.map(view => row(view.task))}{!pending.length && <p className="task-list-empty">今天的任务已收尾。</p>}</div>{closed.length > 0 && <details className="task-list-closed"><summary>已完成 · {closed.length} 项</summary><div>{closed.map(view => row(view.task))}</div></details>}{cancelled.length > 0 && <details className="task-list-closed"><summary>已取消 · {cancelled.length} 项</summary><div>{cancelled.map(view => row(view.task))}</div></details>}<details className="board-time"><summary><Clock3 size={14} />用时记录 <span>{blocks.length} 个时段</span></summary><div>{blocks.map(block => { const actual = state.log?.work_block_actuals.find(item => item.block_id === block.id); const shared = allTasks.filter(task => task.work_block_id === block.id).length > 1; return <div className="board-time-row" key={block.id}><div><strong>{block.title}</strong><span>{block.budget_minutes === null ? '预算未填写' : `预计 ${block.budget_minutes} 分钟`}{shared ? ' · 共享，仅计一次' : ''}</span></div><button type="button" className="button-quiet" disabled={busy} onClick={() => onActual(block)}>{actual ? `实际 ${actual.minutes} 分钟 · 更正` : '记录用时'}</button></div>; })}</div></details></div>;
}

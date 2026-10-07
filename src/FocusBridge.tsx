import { useRef, useState } from 'react';
import { ArrowRight, Clock3, Download, Upload } from 'lucide-react';
import type { AppState } from '../shared/contracts';
import type { DayState, PlanSnapshot, WorkBlock } from '../shared/day-contracts';
import { errorMessage, request } from './api';
import './focus-bridge.css';

type CockpitRef = { workspaceId: string; businessDate: string; taskId: string; blockId: string; projectId: string };
type FocusSession = { id: string; mode: string; startedAt: number; completedAt: number; durationMs: number; taskId: string | null; taskTitle: string; cockpit?: CockpitRef };
type FocusTask = { id: string; title: string; cockpit?: CockpitRef };
type Preview = FocusSession & { blockId: string; imported: boolean; title: string };

function localDate(timestamp: number, timezone: string): string {
  const fields = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(timestamp)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function downloadJson(value: unknown, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export default function FocusBridge({ app, state, plan, onChanged }: { app: AppState; state: DayState; plan: PlanSnapshot | null; onChanged: () => Promise<unknown> }) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const blocks = plan?.day_mode === 'work' ? plan.work_blocks : [];
  const currentTaskIds = new Set(plan?.tasks.map(task => task.task_id) ?? []);
  const tasks = state.tasks.filter(task => currentTaskIds.has(task.task_id) && task.eligible && task.status !== 'done' && task.status !== 'cancelled');

  async function exportPlan() {
    setError(''); setMessage('');
    if (!plan || plan.day_mode !== 'work' || !tasks.length) return setError('这一天没有可导出的已确认任务。');
    setBusy(true);
    try {
      const health = await request<{ workspaceId: string }>('/api/health');
      downloadJson({ kind: 'pcos-focus-plan', version: 1, workspaceId: health.workspaceId,
        businessDate: state.business_date, timezone: state.timezone, planVersion: plan.plan_version,
        tasks: tasks.map(task => ({ taskId: task.task_id, projectId: task.project_id,
          projectName: app.projects.find(project => project.id === task.project_id)?.name ?? task.project_name,
          title: task.title, blockId: task.work_block_id,
          blockTitle: blocks.find(block => block.id === task.work_block_id)?.title ?? '投入时段',
          estimatedMinutes: task.estimated_minutes })) }, `驾驶舱今日专注任务-${state.business_date}.json`);
      setMessage(`已导出 ${tasks.length} 项任务。在一刻中选择“从驾驶舱导入任务”。`);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function readBackup(file: File) {
    setError(''); setMessage(''); setPreview(null); setName(file.name);
    if (file.size > 4 * 1024 * 1024) return setError('请选择小于 4 MB 的一刻备份。');
    setBusy(true);
    try {
      const raw: unknown = JSON.parse(await file.text());
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as {version?:number}).version !== 1) throw new Error('请选择一刻导出的版本 1 JSON 备份。');
      const data = raw as { tasks?: FocusTask[]; sessions?: FocusSession[] };
      if (!Array.isArray(data.tasks) || !Array.isArray(data.sessions)) throw new Error('备份缺少专注任务或记录。');
      const [health, timerView] = await Promise.all([
        request<{ workspaceId: string }>('/api/health'),
        request<{ sessions: { id: string }[] }>(`/api/days/${state.business_date}/timer`),
      ]);
      const existing = new Set(timerView.sessions.map(session => session.id));
      const seen = new Set<string>();
      const items: Preview[] = [];
      for (const session of data.sessions) {
        if (session?.mode !== 'focus' || typeof session.id !== 'string' || !session.id || seen.has(session.id)
          || !Number.isSafeInteger(session.startedAt) || !Number.isSafeInteger(session.completedAt)
          || !Number.isSafeInteger(session.durationMs) || session.durationMs % 1000 !== 0 || session.durationMs < 60_000 || session.durationMs > 180 * 60_000
          || session.startedAt > session.completedAt || session.completedAt > Date.now()
          || session.completedAt - session.startedAt < session.durationMs) continue;
        seen.add(session.id);
        if (localDate(session.startedAt, state.timezone) !== state.business_date || localDate(session.completedAt, state.timezone) !== state.business_date) continue;
        const task = data.tasks.find(item => item && item.id === session.taskId);
        // Only the reference frozen into the completed session is safe to map automatically.
        const ref = session.cockpit;
        const blockId = ref?.workspaceId === health.workspaceId && ref?.businessDate === state.business_date
          && blocks.some(block => block.id === ref.blockId) ? ref.blockId : '';
        items.push({ ...session, blockId, title: session.taskTitle || task?.title || '未命名专注', imported: existing.has(`still-focus:${session.id}`) });
      }
      if (!items.length) throw new Error('这个日期没有可核对的完整专注记录；跨日记录请手工核对。');
      setPreview(items.slice(0, 100));
      setMessage(`找到 ${items.length} 条该日完整专注。请核对投入时段，再确认入账。${items.length > 100 ? '本次最多显示前 100 条。' : ''}`);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function importSelected() {
    if (!preview || busy) return;
    const sessions = preview.filter(item => item.blockId && !item.imported)
      .map(({ id, startedAt, completedAt, durationMs, blockId }) => ({ id, startedAt, completedAt, durationMs, blockId }));
    if (!sessions.length) return setError('先为至少一条未入账的专注选择投入时段。');
    setBusy(true); setError(''); setMessage('');
    try {
      await request(`/api/days/${state.business_date}/focus-import`, 'POST', {
        requestId: crypto.randomUUID(), revision: state.log?.revision ?? 0, sessions,
      });
      await onChanged();
      setPreview(current => current?.map(item => sessions.some(session => session.id === item.id) ? { ...item, imported: true } : item) ?? null);
      setMessage(`已将 ${sessions.length} 条专注记入实际用时。任务成果和验收状态没有改变。`);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  const selected = preview?.filter(item => item.blockId && !item.imported) ?? [];
  const selectedMinutes = selected.reduce((sum, item) => sum + item.durationMs, 0) / 60_000;
  return <section className="focus-bridge" aria-label="一刻番茄钟与驾驶舱连接">
    <div className="focus-bridge-intro"><div className="focus-bridge-icon"><Clock3 size={18} strokeWidth={1.8} /></div><div><span>FOCUS · 一刻</span><h2>专注以后，再核对实际用时。</h2><p>先导出已确认任务，在「一刻」中专注；结束后回到这里导入记录，核对后才入账。</p></div></div>
    <div className="focus-bridge-actions"><button className="button-secondary" type="button" disabled={busy || !tasks.length} onClick={() => void exportPlan()}><Download size={15} />导出今日任务</button><button className="button-primary" type="button" disabled={busy || !blocks.length} onClick={() => input.current?.click()}><Upload size={15} />导入一刻记录</button><input ref={input} type="file" accept=".json,application/json" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void readBackup(file); }} /></div>
    {(message || error) && <p className={`focus-bridge-feedback${error ? ' error' : ''}`} role="status">{error || message}</p>}
    {preview && <div className="focus-bridge-preview"><div className="focus-bridge-preview-head"><strong>{name}</strong><span>{preview.length} 条 · {preview.filter(item => item.imported).length} 条已入账</span></div><div className="focus-bridge-rows">{preview.map(item => <div className="focus-bridge-row" key={item.id}><div><strong>{item.title}</strong><small>{new Intl.DateTimeFormat('zh-CN', { timeZone: state.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(item.completedAt))} 完成 · {Math.round(item.durationMs / 60_000)} 分钟</small></div>{item.imported ? <span className="focus-bridge-done">已入账</span> : <select aria-label={`${item.title} 对应的投入时段`} value={item.blockId} onChange={event => setPreview(current => current?.map(row => row.id === item.id ? { ...row, blockId: event.target.value } : row) ?? null)}><option value="">暂不导入</option>{blocks.map((block: WorkBlock) => <option key={block.id} value={block.id}>{block.title}</option>)}</select>}</div>)}</div><div className="focus-bridge-confirm"><span>{selected.length ? `${selected.length} 条 · 约 ${Math.round(selectedMinutes)} 分钟待核对` : '未选择要记入的专注'}</span><button className="button-primary" type="button" disabled={busy || !selected.length} onClick={() => void importSelected()}>确认记入用时 <ArrowRight size={14} /></button></div></div>}
    <p className="focus-bridge-note">已有手填用时或另一段计时重叠时，系统会拒绝自动相加。番茄完成不等于任务达成，也不生成成果。</p>
  </section>;
}

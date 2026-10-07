import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Archive, BookOpen, CalendarDays, Check, CheckCheck, CircleHelp, Clock3, Compass, FileText, FolderOpen, Inbox, LayoutGrid, Leaf, LoaderCircle, PanelsTopLeft, Pause, Pencil, Play, Plus, Search, Settings2, ShieldCheck, Sprout, Sun, X } from 'lucide-react';
import { METRICS, OPERATING_ROLES, PROJECT_STATUSES, PROJECT_TYPES, type AppState, type Project, type ProjectInput, type ProjectStatus, type SettingsInput } from '../shared/contracts';
import { ApiError, errorMessage, initializeSession, request, setWorkspace, isDemoWorkspace } from './api';
import Today from './Today';
import GrowthPanel from './GrowthPanel';
import { useProjectDay, ProjectProgressDetail } from './ProjectProgress';
import { projectProgress, projectStageLabel } from '../shared/project-progress';
import type { DayState } from '../shared/day-contracts';
import { Review } from './ScorePanel';
import AiSettings from './AiSettings';
import BackupSettings, { hasPendingRestore } from './BackupSettings';
import InboxPanel from './InboxPanel';
import GlobalFocusBar from './GlobalFocusBar';
import CommandSearch from './CommandSearch';
import ExternalFocusTools from './ExternalFocusTools';
import ThemePicker from './ThemePicker';
import type { InboxItem } from '../shared/inbox-contracts';
import type { RestoreReceipt } from '../shared/restore-contracts';
import './shell-polish.css';
import './onboarding.css';

type Page = 'inbox' | 'today' | 'plan' | 'projects' | 'review' | 'settings';
const TYPE_LABEL = { novel: '小说', publication: '内容账号', product: '产品', research: '研究', foundation: '个人维护' };
const ROLE_LABEL = { cashflow: '现金流', growth: '品牌增长', future_asset: '未来资产', maintenance: '基础维护' };
const STATUS_LABEL = { preparing: '准备中', active: '进行中', paused: '已暂停', completed: '已完成', archived: '已归档' };
const INPUT_LABEL: Record<keyof ProjectInput, string> = { name: '项目名称', project_type: '类型', platform: '平台', operating_role: '经营角色', stage: '阶段', status: '状态', primary_metric_key: '主要指标', baseline_value: '基线数量', baseline_at: '基线日期', baseline_source: '基线来源', target_value: '目标数量', target_date: '目标日期', next_milestone: '下一里程碑', next_action: '下一步行动', daily_budget_minutes: '日预算', cadence: '每周安排', notes: '备注' };
function readableValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '未记录';
  if (key === 'project_type') return TYPE_LABEL[value as keyof typeof TYPE_LABEL];
  if (key === 'operating_role') return ROLE_LABEL[value as keyof typeof ROLE_LABEL];
  if (key === 'status') return STATUS_LABEL[value as keyof typeof STATUS_LABEL];
  if (key === 'primary_metric_key') return METRICS.find(item => item.key === value)?.label ?? String(value);
  if (key === 'cadence') { const days = (value as ProjectInput['cadence']).days_per_week; return days === null ? '未记录' : `${days} 天`; }
  return String(value);
}
const EMPTY_PROJECT: ProjectInput = { name: '', project_type: 'novel', platform: null, operating_role: 'cashflow', stage: '', status: 'preparing', primary_metric_key: null, baseline_value: null, baseline_at: null, baseline_source: null, target_value: null, target_date: null, next_milestone: null, next_action: null, daily_budget_minutes: null, cadence: { days_per_week: null }, notes: '' };
const numberOrNull = (value: string) => value.trim() === '' ? null : Number(value);
const textOrNull = (value: string) => value.trim() === '' ? null : value;
function inputOf(project: Project): ProjectInput {
  const { id: _id, revision: _revision, created_at: _created, updated_at: _updated, ...input } = project;
  return structuredClone(input);
}
function Brand({ compact = false }: { compact?: boolean }) { return <div className="brand"><span className="brand-mark cockpit-brand-mark" aria-hidden="true"><img src="/life-cockpit.svg" alt="" /></span><div><div className="brand-name">人生驾驶舱</div><small className="brand-subtitle">{compact ? '时间 · 行动 · 积累' : '让今天的投入留下成果'}</small></div></div>; }
function Field({ label, hint, optional, children, wide = false }: { label: string; hint?: string; optional?: boolean; children: ReactNode; wide?: boolean }) {
  return <label className={`field ${wide ? 'span-two' : ''}`}><span className="field-label">{label}{optional && <small>选填</small>}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
function ErrorNotice({ error, children }: { error: unknown; children?: ReactNode }) {
  if (!error) return null;
  return <div className="inline-error" role="alert"><p>{errorMessage(error)}</p>{error instanceof ApiError && error.fields && <ul>{Object.entries(error.fields).map(([key, value]) => <li key={key}>{value}</li>)}</ul>}{children}</div>;
}
function metricFor(project: ProjectInput) { return METRICS.find(metric => metric.key === project.primary_metric_key); }
function budgetRows(state: AppState) {
  const grouped = new Set(state.settings.shared_budget_groups.flatMap(group => group.project_ids));
  const singles = state.projects.filter(project => !grouped.has(project.id) && project.daily_budget_minutes !== null).map(project => ({ id: project.id, title: project.name, note: project.platform ?? TYPE_LABEL[project.project_type], minutes: project.daily_budget_minutes! }));
  return [...singles, ...state.settings.shared_budget_groups.map(group => ({ id: group.id, title: group.title, note: group.project_ids.map(id => state.projects.find(project => project.id === id)?.name ?? '未找到项目').join('、') + ' · 共享', minutes: group.budget_minutes }))];
}
function BudgetList({ state }: { state: AppState }) {
  return <div className="budget-list">{budgetRows(state).map(row => <div key={row.id}><span>{row.title}<small>{row.note}</small></span><span>{row.minutes} 分钟</span></div>)}</div>;
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = useState<Page>(() => !isDemoWorkspace() && hasPendingRestore() ? 'settings' : 'today');
  useEffect(() => { window.scrollTo(0, 0); }, [page]);
  const projectDay = useProjectDay(page === 'projects' && !!state?.setupCompleted, state?.settings.timezone ?? 'Asia/Shanghai');
  const [workDate, setWorkDate] = useState<string | undefined>();
  const [dayProjectFilter, setDayProjectFilter] = useState<string | null>(null);
  const [quickTaskProjectId, setQuickTaskProjectId] = useState<string | null>(null);
  const [selectedTaskEntry, setSelectedTaskEntry] = useState<string | null>(null);
  const [inboxEntry, setInboxEntry] = useState<InboxItem | null>(null);
  const onTaskEntryHandled = useCallback(() => { setQuickTaskProjectId(null); setInboxEntry(null); setSelectedTaskEntry(null); }, []);
  const [commandOpen, setCommandOpen] = useState(false);
  const dayDirty = useRef(false);
  const onDayDirty = useCallback((dirty: boolean) => { dayDirty.current = dirty; }, []);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<Project | 'new' | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('current');
  const [actionBusy, setActionBusy] = useState(false);
  const settingsDirty = useRef(false);
  const aiDirty = useRef(false);
  const backupDirty = useRef(false);
  const [settingsChanged, setSettingsChanged] = useState(false);
  const [aiChanged, setAiChanged] = useState(false);
  const [restored, setRestored] = useState<RestoreReceipt | null>(null);
  const [firstRunRecovery, setFirstRunRecovery] = useState(false);
  const onSettingsDirty = useCallback((value: boolean) => { settingsDirty.current = value; setSettingsChanged(value); }, []);
  const onAiDirty = useCallback((value: boolean) => { aiDirty.current = value; setAiChanged(value); }, []);
  const onBackupDirty = useCallback((value: boolean) => { backupDirty.current = value; }, []);
  const onRestored = useCallback((receipt: RestoreReceipt) => { setRestored(receipt); }, []);
  const boot = useCallback(async () => {
    setLoading(true); setError(null);
    try { await initializeSession(); const data = await request<AppState>('/api/state'); setState(data); setSelectedId(current => current ?? data.projects[0]?.id ?? null); }
    catch (failure) { setError(failure); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void boot(); }, [boot]);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommandOpen(current => !current); } }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, []);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 4200); return () => clearTimeout(timer); }, [toast]);
  const refresh = useCallback(async () => { const data = await request<AppState>('/api/state'); setState(data); return data; }, []);
  const acceptProject = (project: Project) => {
    setState(current => current && ({ ...current, projects: current.projects.some(item => item.id === project.id) ? current.projects.map(item => item.id === project.id ? project : item) : [...current.projects, project] }));
    setSelectedId(project.id); setFilter(project.status === 'archived' ? 'archived' : 'current'); setSearch(''); setEditor(null); setToast('项目已保存到本地'); setError(null);
  };
  async function exitDemo() {
    if (actionBusy || (dayDirty.current && !window.confirm('示例中有未保存的内容，确认返回吗？'))) return;
    setActionBusy(true); setError(null);
    try { await request('/api/exit', 'POST', {}); setWorkspace('personal'); setActionBusy(false); }
    catch (failure) { setError(failure); setActionBusy(false); }
  }
  const navigate = (next: Page) => {
    if (isDemoWorkspace() && next === 'settings') { setToast('设置与备份请返回个人工作台使用。'); return false; }
    if (next === page) return true;
    if (['today','plan','inbox','review'].includes(page) && dayDirty.current && !window.confirm('还有未保存的内容，离开将放弃这些修改。继续吗？')) return false;
    if (page === 'settings' && (settingsDirty.current || aiDirty.current || backupDirty.current) && !window.confirm('设置有未保存内容或备份恢复尚在处理中，确定离开吗？')) return false;
    settingsDirty.current = false; setPage(next); setError(null); return true;
  };
  async function changeStatus(project: Project, status: ProjectStatus) {
    if (actionBusy) return;
    setActionBusy(true); setError(null);
    try { const data = await request<{ project: Project }>(`/api/projects/${encodeURIComponent(project.id)}`, 'PUT', { revision: project.revision, project: { ...inputOf(project), status } }); acceptProject(data.project); setToast(`「${project.name}」${STATUS_LABEL[status]}`); }
    catch (failure) { setError(failure); }
    finally { setActionBusy(false); }
  }
  if (restored) return <div className="loading-screen restore-complete"><ShieldCheck size={35} /><h1>本地账本已恢复</h1><p>恢复时间：{new Date(restored.restoredAt).toLocaleString('zh-CN')}</p><p className="backup-path">来源备份：{restored.backupId}<br />恢复前保全备份：{restored.preservationBackupId}</p><p>旧页面已停止编辑。重新打开后，将读取恢复后的项目、计划和报告；其他打开的窗口也需要刷新。</p><button className="button-primary" onClick={() => window.location.reload()}>重新打开恢复后的账本</button></div>;
  if (loading && !state) return <div className="loading-screen"><Sprout size={35} strokeWidth={1.3} /><p>正在打开人生驾驶舱…</p></div>;
  if (!state) return <div className="loading-screen"><Leaf size={35} /><h1>暂时无法打开本地账本</h1><ErrorNotice error={error} /><button className="button-primary" onClick={() => void boot()}>重新连接</button></div>;
  if (!state.setupCompleted && !hasPendingRestore()) {
    if (firstRunRecovery) return <main className="first-run-recovery"><Brand /><h1>从已有备份恢复</h1><p>先把完整备份文件夹放入下方目录，再刷新与校验；无需重新建立项目。</p><BackupSettings settingsUnsaved={false} onDirty={onBackupDirty} onRestored={onRestored} /><button className="button-secondary" onClick={() => { if (!backupDirty.current || window.confirm('备份恢复仍在处理中，确定返回吗？')) setFirstRunRecovery(false); }}>返回首次设置</button></main>;
    return <><div className="setup-recovery-entry"><button className="button-secondary" onClick={() => setFirstRunRecovery(true)}>从已有备份恢复</button></div><Setup onDemo={() => setWorkspace('demo')} onComplete={data => { setState(data); setSelectedId(data.projects[0]?.id ?? null); setPage('projects'); setEditor('new'); setToast('工作台已建立，添加你的第一个项目'); }} /></>;
  }
  const selected = state.projects.find(project => project.id === selectedId) ?? null;
  const rows = budgetRows(state);
  const totalMinutes = rows.reduce((sum, row) => sum + row.minutes, 0);
  const shown = state.projects.filter(project => (filter === 'all' || (filter === 'current' ? project.status !== 'archived' : project.status === filter)) && `${project.name} ${project.platform ?? ''} ${TYPE_LABEL[project.project_type]}`.toLowerCase().includes(search.toLowerCase()));
  const businessDate = workDate ?? new Intl.DateTimeFormat('en-CA', { timeZone: state.settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return <div className="app-shell polished-shell planner-shell" data-page={page}>
    <aside className="sidebar"><Brand compact /><nav className="nav" aria-label="主导航">
      {([{ id: 'inbox', label: '收件箱', icon: Inbox }, { id: 'today', label: '今天', icon: Sun }, { id: 'plan', label: '计划', icon: CalendarDays }, { id: 'projects', label: '项目', icon: LayoutGrid }, { id: 'review', label: '回顾与积累', icon: FileText }] as const).map(item => <button key={item.id} className={page === item.id ? 'active' : ''} aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><item.icon size={17} strokeWidth={1.6} />{item.label}{item.id === 'projects' && <span className="nav-count">{state.projects.length}</span>}</button>)}
    </nav><div className="sidebar-bottom">{!isDemoWorkspace() && window.lifeCockpitDesktop && <button type="button" className="sidebar-settings desktop-widget-entry" aria-label="打开桌面小组件" title="打开桌面小组件" onClick={() => void window.lifeCockpitDesktop!.openWidget().catch(setError)}><PanelsTopLeft size={17} /><span>桌面小组件</span></button>}{!isDemoWorkspace() && <button className={`sidebar-settings ${page === 'settings' ? 'active' : ''}`} aria-current={page === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><Settings2 size={16} />设置</button>}<div className="local-indicator"><span className="status-dot" />保存在这台电脑</div></div></aside>
    <div className="workspace">
      <header className="topbar planner-topbar"><button type="button" className="planner-search-button" aria-label="搜索工作空间" aria-keyshortcuts="Control+K Meta+K" aria-haspopup="dialog" onClick={() => setCommandOpen(true)}><Search size={16} /><span>搜索工作空间</span><kbd>Ctrl K</kbd></button><div className="planner-topbar-actions"><GlobalFocusBar timezone={state.settings.timezone} onOpen={date => { if (navigate('today')) setWorkDate(date); }} /><ThemePicker compact /><button className="button-quiet" aria-label="快速记录" onClick={() => navigate('inbox')}><Plus size={15} /><span className="quick-capture-label">快速记录</span></button></div></header>
      <main className="main">
        {isDemoWorkspace() && <div className="demo-banner" role="status"><span><strong>示例工作台</strong> · 所有数据均为虚构，与个人记录分开保存。可以自由体验。</span><button className="button-secondary" disabled={actionBusy} onClick={() => void exitDemo()}>返回我的工作台</button></div>}
        <ErrorNotice error={error}>{error instanceof ApiError && error.status === 409 && <div className="error-actions"><button className="button-secondary" onClick={() => void refresh().then(() => setError(null)).catch(setError)}>重新读取最新记录</button></div>}</ErrorNotice>
        {page === 'projects' && <>
          <div className="page-heading"><div><h1>项目</h1><p>目标、下一步与已确认成果。</p></div><button className="button-primary" onClick={() => setEditor('new')}><Plus size={16} />新建项目</button></div>
          <div className="overview-line"><div className="overview-item"><div className="overview-value">{state.projects.filter(project => project.status !== 'archived').length}<small>个</small></div><div className="overview-label">在册项目</div></div><div className="overview-item"><div className="overview-value">{totalMinutes}<small>分钟</small></div><div className="overview-label">已设置的参考日预算</div></div><div className="overview-item"><div className="overview-value">{state.settings.available_minutes === null ? '—' : state.settings.available_minutes}<small>{state.settings.available_minutes === null ? '' : '分钟'}</small></div><div className="overview-label">{state.settings.available_minutes === null ? '可用容量 · 尚未设置' : '默认日可用容量'}</div></div><div className="overview-note">预算是对投入的安排。<br />实际用时和成果，将各自记录。</div></div>
          <div className="portfolio-grid"><section className="project-area" aria-label="项目列表"><div className="toolbar"><div className="filter-group" aria-label="筛选项目状态">{[{ key: 'current', label: '在册项目' }, { key: 'active', label: '进行中' }, { key: 'paused', label: '暂停' }, { key: 'archived', label: '归档' }, { key: 'all', label: '全部' }].map(item => <button key={item.key} className={filter === item.key ? 'selected' : ''} aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>{item.label}</button>)}</div><label className="search"><Search size={13} /><input aria-label="搜索项目" placeholder="搜索项目…" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
            <div className="project-list"><div className="list-head" aria-hidden="true"><span>项目</span><span className="role-column">经营角色</span><span>项目状态</span><span style={{ textAlign: 'right' }}>日预算</span></div>
              {shown.map(project => { const shared = state.settings.shared_budget_groups.find(group => group.project_ids.includes(project.id)); return <button key={project.id} className={`project-row ${selectedId === project.id ? 'selected' : ''}`} onClick={() => setSelectedId(project.id)} aria-pressed={selectedId === project.id} aria-label={`查看${project.name}，${STATUS_LABEL[project.status]}`}><span className="project-identity"><span className="project-icon">{project.project_type === 'novel' ? <BookOpen size={17} strokeWidth={1.5} /> : <FileText size={17} strokeWidth={1.5} />}</span><span className="project-text"><span className="project-name">{project.name}</span><span className="project-subtitle" style={{ display: 'block' }}>{project.platform ?? TYPE_LABEL[project.project_type]}{` · ${projectStageLabel(project.stage)}`}</span><span className="project-day-label">{projectDay.day ? projectProgress(projectDay.day, project.id).label : projectDay.error ? '今日结果同步失败' : '正在同步今日结果…'}</span></span></span><span className="role-label role-column">{ROLE_LABEL[project.operating_role]}</span><span className={`status-pill ${project.status}`}>{STATUS_LABEL[project.status]}</span><span className="budget-cell">{shared ? '共享' : project.daily_budget_minutes === null ? '未设置' : `${project.daily_budget_minutes} 分钟`}{shared && <small>组共 {shared.budget_minutes} 分钟</small>}</span></button>; })}
              {shown.length === 0 && <div className="empty-state"><FolderOpen size={30} strokeWidth={1.3} /><h2>这里还没有项目</h2><p>{search ? '换一个关键词，或查看其他项目状态。' : filter === 'archived' ? '归档后的项目仍会保留完整档案。' : '建立一个项目，给接下来的投入一个明确的归属。'}</p>{!search && filter !== 'archived' && <button className="button-secondary" onClick={() => setEditor('new')}><Plus size={14} />新建项目</button>}</div>}
            </div><div className="list-caption"><span>{shown.length} 个项目 · 选择项目查看档案</span><span>保存在这台电脑</span></div><div className="project-note"><Sprout size={20} strokeWidth={1.4} /><div><strong>先明确下一步，再衡量进展</strong><p>项目角色是起始建议，可以调整。尚未录入的基线与目标，会保持空白。</p></div></div>
          </section><ProjectDetail project={selected} day={projectDay.day} dayError={projectDay.error} state={state} busy={actionBusy} onEdit={project => setEditor(project)} onStatus={(project, status) => void changeStatus(project, status)} onAddTask={project => { if (!navigate('today')) return; setQuickTaskProjectId(project.id); setWorkDate(projectDay.day?.business_date); setDayProjectFilter(null); }} onResults={project => { if (!navigate('today')) return; setWorkDate(projectDay.day?.business_date); setDayProjectFilter(project.id); }} /></div>
        </>}
        {page === 'inbox' && <div className="planner-inbox-page"><div className="page-heading"><div><h1>收件箱</h1><p>先把事情记下来，准备好时再安排。</p></div></div><InboxPanel app={state} date={businessDate} onDateChange={setWorkDate} onDirty={onDayDirty} onPromote={item => { if (!navigate('today')) return; setInboxEntry(item); setDayProjectFilter(null); }} /></div>}
        {(page === 'today' || page === 'plan') && <Today key={page} initialDate={workDate} initialView={page === 'plan' ? 'schedule' : 'tasks'} pageTitle={page === 'plan' ? '计划' : '今天'} app={state} filterProjectId={dayProjectFilter} onFilter={setDayProjectFilter} onDateChange={setWorkDate} onDirty={onDayDirty} onNotice={setToast} initialTaskProjectId={quickTaskProjectId} initialInboxItem={inboxEntry} initialSelectedTaskId={selectedTaskEntry} onTaskEntryHandled={onTaskEntryHandled} onProjectsChanged={refresh} onProjects={() => { setFilter('all'); setSearch(''); navigate('projects'); }} />}
        {page === 'review' && <Review initialDate={workDate} onDateChange={setWorkDate} onDirty={onDayDirty} timezone={state.settings.timezone} onWork={date => { if (!navigate('today')) return; setWorkDate(date); setDayProjectFilter(null); }} />}
        {page === 'settings' && <><SettingsPage state={state} onSave={data => { setState(data); setToast('设置已保存到本地'); }} onDirty={onSettingsDirty} refresh={refresh} /><details className="settings-section"><summary>AI 复盘与建议</summary><AiSettings onDirty={onAiDirty} /></details><ExternalFocusTools app={state} /><BackupSettings settingsUnsaved={settingsChanged || aiChanged} onDirty={onBackupDirty} onRestored={onRestored} /></>}
      </main>
    </div>
    {toast && <div className="toast" role="status"><Check size={15} />{toast}</div>}
    {editor && <ProjectEditor project={editor === 'new' ? null : editor} state={state} onClose={() => setEditor(null)} onSaved={acceptProject} refresh={refresh} />}
    {commandOpen && <CommandSearch app={state} onClose={() => setCommandOpen(false)} onChoose={item => { setCommandOpen(false); if (item.kind === 'project') { if (!navigate('projects')) return; setSelectedId(item.id); setSearch(''); setFilter('all'); } else if (item.kind === 'inbox') navigate('inbox'); else { if (!navigate('today')) return; setWorkDate(item.date); setDayProjectFilter(null); setSelectedTaskEntry(item.id); } }} />}
  </div>;
}

function Setup({ onComplete, onDemo }: { onComplete: (state: AppState) => void; onDemo: () => void }) {
  const [timezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const requestKey = useRef(crypto.randomUUID());
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(null);
    try { onComplete(await request<AppState>('/api/setup', 'POST', { requestId: requestKey.current, timezone, availableMinutes: null, mode: 'blank' })); }
    catch (failure) { setError(failure); } finally { setBusy(false); }
  }
  return <div className="setup-page"><div className="setup-top"><Brand /><span className="build-tag">欢迎来到你的本地工作空间</span></div><div className="setup-layout"><section className="setup-copy"><div className="eyebrow">LIFE COCKPIT</div><h1>把今天的行动，<br />变成看得见的积累。</h1><p>选一件今天要做的事，记录实际投入，再回看留下了什么。从一个小项目开始就好。</p><div className="setup-principles"><div><FolderOpen size={17} strokeWidth={1.5} />为自己的项目安排下一步</div><div><Clock3 size={17} strokeWidth={1.5} />分别记录计划、用时与成果</div><div><ShieldCheck size={17} strokeWidth={1.5} />核心功能离线可用，数据保存在本机</div></div></section><section className="setup-card"><h2>开始你的第一个项目</h2><p>无需账号，也无需配置 AI。建立工作台后，只需添加一个项目和今天的第一件事。</p><form className="setup-form" onSubmit={event => void submit(event)}><ErrorNotice error={error} /><button className="button-primary" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={16} />}{busy ? '正在建立…' : '建立我的工作台'}</button></form><div className="setup-demo-choice"><h3>先看看怎么用</h3><p>体验创作、学习、产品三个虚构项目。示例单独保存，不会混入你的工作台。</p><button type="button" className="button-secondary" disabled={busy} onClick={onDemo}>体验示例</button></div><p className="setup-note">当前时区：{timezone}。之后可在设置中修改。</p></section></div></div>;
}

function ProjectDetail({ project, day, dayError, state, busy, onEdit, onStatus, onAddTask, onResults }: { project: Project | null; day: DayState | null; dayError: string; state: AppState; busy: boolean; onEdit: (project: Project) => void; onStatus: (project: Project, status: ProjectStatus) => void; onAddTask: (project: Project) => void; onResults: (project: Project) => void }) {
  if (!project) return <aside className="detail-panel"><div className="empty-state"><Compass size={30} /><h2>每个项目，都值得看清</h2><p>从左侧选择一个项目，查看目标、下一步和参考预算。</p></div></aside>;
  const metric = metricFor(project);
  const shared = state.settings.shared_budget_groups.find(group => group.project_ids.includes(project.id));
  const known = (value: string | number | null | undefined, suffix = '') => value === null || value === undefined || value === '' ? <span className="unrecorded">未记录</span> : `${value}${suffix}`;
  return <aside className="detail-panel" aria-label={`${project.name}的项目档案`}><div className="detail-top"><span>项目档案</span><button className="icon-button" aria-label={`编辑${project.name}`} onClick={() => onEdit(project)}><Pencil size={14} /></button></div><div className="detail-body"><div className="detail-heading"><div className="project-icon">{project.project_type === 'novel' ? <BookOpen size={22} strokeWidth={1.3} /> : <FileText size={22} strokeWidth={1.3} />}</div><div><h2>{project.name}</h2><p>{TYPE_LABEL[project.project_type]} · {ROLE_LABEL[project.operating_role]}</p></div></div><button type="button" className="button-primary" style={{ width: '100%', marginBottom: 20 }} disabled={busy} onClick={() => onAddTask(project)}><Plus size={15} />添加今日任务</button><ProjectProgressDetail day={day} projectId={project.id} error={dayError} />{day && <GrowthPanel date={day.business_date} projectId={project.id} revision={`${project.revision}:${day.log?.revision ?? 0}`} />}<section className="detail-section"><h3>下一里程碑</h3><p className={`milestone-text ${!project.next_milestone ? 'unrecorded' : ''}`}>{project.next_milestone || '还没有填写，先给下一步一个方向。'}</p>{project.next_action && <p className="detail-caption">下一步：{project.next_action}</p>}</section><section className="detail-section"><button className="button-secondary detail-result-link" onClick={() => onResults(project)}>查看今日任务与成果<ArrowRight size={13} /></button><p className="detail-caption">打开上方同一天的任务与成果，可查看更正历史。</p></section><section className="detail-section"><h3>目标与基线</h3><dl className="detail-dl"><div><dt>主要指标</dt><dd>{known(metric?.label)}</dd></div><div><dt>已记录基线</dt><dd>{known(project.baseline_value, metric ? ` ${metric.unit}` : '')}</dd></div><div><dt>基线截至</dt><dd>{known(project.baseline_at)}</dd></div><div><dt>基线来源</dt><dd>{known(project.baseline_source)}</dd></div><div><dt>目标量</dt><dd>{known(project.target_value, metric ? ` ${metric.unit}` : '')}</dd></div><div><dt>目标日期</dt><dd>{known(project.target_date)}</dd></div></dl><p className="detail-caption">基线是指定日期的记录。日成果独立保存；此处保留原始基线；上方长期积累按截至日与有效成果计算。</p></section><section className="detail-section"><h3>投入与安排</h3><dl className="detail-dl"><div><dt>参考日预算</dt><dd>{shared ? `共享组共 ${shared.budget_minutes} 分钟` : known(project.daily_budget_minutes, ' 分钟')}</dd></div><div><dt>每周节奏</dt><dd>{known(project.cadence.days_per_week, ' 天')}</dd></div><div><dt>项目阶段</dt><dd>{projectStageLabel(project.stage)}</dd></div></dl>{shared && <p className="detail-caption">{shared.project_ids.map(id => state.projects.find(item => item.id === id)?.name ?? '未找到项目').join('、')}共用这个时段；每个项目的分钟数尚未拆分。</p>}</section>{project.notes && <section className="detail-section"><h3>项目备注</h3><p className="milestone-text">{project.notes}</p></section>}</div><div className="detail-actions"><button className="button-quiet" disabled={busy} onClick={() => onEdit(project)}><Pencil size={12} />编辑</button>{project.status !== 'active' && <button className="button-quiet" disabled={busy} onClick={() => onStatus(project, 'active')}><Play size={12} />{project.status === 'preparing' ? '开始' : '恢复'}</button>}{project.status === 'active' && <button className="button-quiet" disabled={busy} onClick={() => onStatus(project, 'paused')}><Pause size={12} />暂停</button>}{project.status !== 'completed' && project.status !== 'archived' && <button className="button-quiet" disabled={busy} onClick={() => onStatus(project, 'completed')}><CheckCheck size={13} />结束整个项目</button>}{project.status !== 'archived' && <button className="button-quiet" disabled={busy} onClick={() => onStatus(project, 'archived')}><Archive size={12} />归档</button>}</div></aside>;
}

function ProjectEditor({ project, state, onClose, onSaved, refresh }: { project: Project | null; state: AppState; onClose: () => void; onSaved: (project: Project) => void; refresh: () => Promise<AppState> }) {
  const [source, setSource] = useState(project);
  const [draft, setDraft] = useState<ProjectInput>(() => project ? inputOf(project) : structuredClone(EMPTY_PROJECT));
  const [baseline, setBaseline] = useState(() => JSON.stringify(project ? inputOf(project) : EMPTY_PROJECT));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [latest, setLatest] = useState<Project | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const requestKey = useRef({ signature: '', id: crypto.randomUUID() });
  const dirty = JSON.stringify(draft) !== baseline;
  const shared = source ? state.settings.shared_budget_groups.find(group => group.project_ids.includes(source.id)) : undefined;
  const metric = metricFor(draft);
  const patch = <K extends keyof ProjectInput>(key: K, value: ProjectInput[K]) => setDraft(current => ({ ...current, [key]: value }));
  useEffect(() => { const dialog = dialogRef.current; const previous = document.activeElement as HTMLElement | null; dialog?.showModal(); return () => { dialog?.close(); previous?.focus(); }; }, []);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, [dirty]);
  const close = () => { if (busy) return; if (!dirty || window.confirm('项目修改还没有保存，确定放弃这些修改吗？')) onClose(); };
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(null);
    const input = { ...draft, name: draft.name.trim(), platform: textOrNull(draft.platform ?? ''), baseline_source: textOrNull(draft.baseline_source ?? ''), next_milestone: textOrNull(draft.next_milestone ?? ''), next_action: textOrNull(draft.next_action ?? '') };
    const signature = JSON.stringify(input); if (requestKey.current.signature !== signature) requestKey.current = { signature, id: crypto.randomUUID() };
    try { const response = source ? await request<{ project: Project }>(`/api/projects/${encodeURIComponent(source.id)}`, 'PUT', { revision: source.revision, project: input }) : await request<{ project: Project }>('/api/projects', 'POST', { requestId: requestKey.current.id, project: input }); onSaved(response.project); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  async function loadLatest() { setBusy(true); try { const data = await refresh(); setLatest(data.projects.find(item => item.id === source?.id) ?? null); } catch (failure) { setError(failure); } finally { setBusy(false); } }
  const useLatest = () => { if (!latest || (dirty && !window.confirm('这会用最新项目记录替换当前未保存草稿。确定重新编辑吗？'))) return; const next = inputOf(latest); setSource(latest); setDraft(next); setBaseline(JSON.stringify(next)); setError(null); setLatest(null); };
  return <dialog className="modal" ref={dialogRef} aria-labelledby="project-form-title" onCancel={event => { event.preventDefault(); close(); }}><form onSubmit={event => void save(event)}><header className="modal-header"><div><h2 id="project-form-title">{source ? '编辑项目档案' : '建立一个新项目'}</h2><p>先记录你知道的，暂不确定的可以留空。</p></div><button type="button" className="icon-button" aria-label="关闭编辑" onClick={close} disabled={busy}><X size={19} /></button></header><div className="modal-content"><ErrorNotice error={error}>{error instanceof ApiError && error.status === 409 && <><p>你的草稿仍保留，系统没有覆盖新版本。可以读取最新记录，再决定是否重新编辑。</p><div className="error-actions"><button type="button" className="button-secondary" disabled={busy} onClick={() => void loadLatest()}>读取最新记录作对照</button></div>{latest && <div className="conflict-comparison"><p>最新记录：{latest.name} · {STATUS_LABEL[latest.status]} · 版本 {latest.revision}</p><dl>{Object.entries(inputOf(latest)).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(draft[key as keyof ProjectInput])).map(([key, value]) => <div key={key}><dt>{INPUT_LABEL[key as keyof ProjectInput]}</dt><dd>最新：{readableValue(key, value)} ／ 草稿：{readableValue(key, draft[key as keyof ProjectInput])}</dd></div>)}</dl><button type="button" className="button-secondary" onClick={useLatest}>使用最新记录重新编辑</button></div>}</>}</ErrorNotice><fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}><div className="form-grid"><Field label="项目名称" wide><input required maxLength={120} autoFocus value={draft.name} onChange={event => patch('name', event.target.value)} placeholder="你正在经营的一个长期项目" /></Field><Field label="项目类型"><select value={draft.project_type} onChange={event => patch('project_type', event.target.value as ProjectInput['project_type'])}>{PROJECT_TYPES.map(type => <option key={type} value={type}>{TYPE_LABEL[type]}</option>)}</select></Field><Field label="下一步行动" optional wide><input maxLength={500} value={draft.next_action ?? ''} onChange={event => patch('next_action', textOrNull(event.target.value))} placeholder="例如：完成下一篇文章的结构提纲" /></Field></div><details className="project-advanced" open={Boolean(source)}><summary>更多项目设置（选填）</summary><div className="form-grid"><Field label="经营角色"><select value={draft.operating_role} onChange={event => patch('operating_role', event.target.value as ProjectInput['operating_role'])}>{OPERATING_ROLES.map(role => <option key={role} value={role}>{ROLE_LABEL[role]}</option>)}</select></Field><Field label="平台" optional><input maxLength={80} value={draft.platform ?? ''} onChange={event => patch('platform', textOrNull(event.target.value))} placeholder="例如：番茄、公众号" /></Field><Field label="项目状态" hint="这是整个项目的状态。完成今日工作请在“今天”结束任务；已完成项目不会带入新一天的计划。"><select value={draft.status} onChange={event => patch('status', event.target.value as ProjectStatus)}>{PROJECT_STATUSES.map(status => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}</select></Field><Field label="当前阶段" optional wide><input maxLength={120} value={draft.stage} onChange={event => patch('stage', event.target.value)} placeholder="例如：准备、连载、产品验证" /></Field></div><h3 className="form-section-title">目标与基线</h3><div className="form-grid"><Field label="主要指标" optional><select value={draft.primary_metric_key ?? ''} onChange={event => patch('primary_metric_key', (event.target.value || null) as ProjectInput['primary_metric_key'])}><option value="">暂不设置</option>{METRICS.map(item => <option key={item.key} value={item.key}>{item.label} · {item.unit}</option>)}</select></Field><Field label={`基线数量${metric ? `（${metric.unit}）` : ''}`} optional hint="未知请留空；已确认的 0 可以填写。"><input type="number" min="0" step="1" value={draft.baseline_value ?? ''} onChange={event => patch('baseline_value', numberOrNull(event.target.value))} /></Field><Field label="基线截至日期" optional><input type="date" value={draft.baseline_at ?? ''} onChange={event => patch('baseline_at', textOrNull(event.target.value))} /></Field><Field label="基线来源" optional><input maxLength={500} value={draft.baseline_source ?? ''} onChange={event => patch('baseline_source', textOrNull(event.target.value))} placeholder="例如：本人核对，或来源链接" /></Field><Field label={`目标数量${metric ? `（${metric.unit}）` : ''}`} optional><input type="number" min="1" step="1" value={draft.target_value ?? ''} onChange={event => patch('target_value', numberOrNull(event.target.value))} /></Field><Field label="目标日期" optional><input type="date" value={draft.target_date ?? ''} onChange={event => patch('target_date', textOrNull(event.target.value))} /></Field><Field label="下一里程碑" optional wide><input maxLength={500} value={draft.next_milestone ?? ''} onChange={event => patch('next_milestone', textOrNull(event.target.value))} placeholder="一项可以明确判断是否完成的成果" /></Field></div><h3 className="form-section-title">投入安排</h3><div className="form-grid"><Field label="参考日预算（分钟）" optional hint={shared ? `与其他项目共享 ${shared.budget_minutes} 分钟；请在设置中修改共享预算。` : '只记录预算，实际用时将在成果功能中单独记录。'}><input type="number" min="0" step="1" disabled={Boolean(shared)} value={draft.daily_budget_minutes ?? ''} onChange={event => patch('daily_budget_minutes', numberOrNull(event.target.value))} placeholder={shared ? '共享时段，单项未拆分' : '未设置'} /></Field><Field label="每周安排天数" optional><input type="number" min="1" max="7" step="1" value={draft.cadence.days_per_week ?? ''} onChange={event => patch('cadence', { days_per_week: numberOrNull(event.target.value) })} /></Field><Field label="备注" optional wide><textarea maxLength={10000} value={draft.notes} onChange={event => patch('notes', event.target.value)} placeholder="保留对这个项目重要的背景或想法。" /></Field></div></details></fieldset></div><footer className="modal-footer"><span className="save-note">保存到本地项目账本</span><button type="button" className="button-secondary" onClick={close} disabled={busy}>取消</button><button type="submit" className="button-primary" disabled={busy}>{busy && <LoaderCircle size={14} className="spin" />}{busy ? '正在保存…' : '保存项目'}</button></footer></form></dialog>;
}

function SettingsPage({ state, onSave, onDirty, refresh }: { state: AppState; onSave: (state: AppState) => void; onDirty: (dirty: boolean) => void; refresh: () => Promise<AppState> }) {
  const initial = useMemo(() => ({ timezone: state.settings.timezone, available_minutes: state.settings.available_minutes, shared_budget_groups: structuredClone(state.settings.shared_budget_groups) }), []);
  const [draft, setDraft] = useState<SettingsInput>(initial);
  const [revision, setRevision] = useState(state.settings.revision);
  const [baseline, setBaseline] = useState(JSON.stringify(initial));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== baseline;
  useEffect(() => { onDirty(dirty || busy); }, [dirty, busy, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, [dirty, busy]);
  async function submit(event: FormEvent) { event.preventDefault(); if (busy) return; setBusy(true); setError(null); try { const data = await request<AppState>('/api/settings', 'PUT', { revision, settings: draft }); setRevision(data.settings.revision); const next = { timezone: data.settings.timezone, available_minutes: data.settings.available_minutes, shared_budget_groups: data.settings.shared_budget_groups }; setDraft(next); setBaseline(JSON.stringify(next)); onSave(data); } catch (failure) { setError(failure); } finally { setBusy(false); } }
  async function reload() { if (dirty && !window.confirm('重新读取会放弃当前未保存的设置，确定继续吗？')) return; setBusy(true); try { const data = await refresh(); const next = { timezone: data.settings.timezone, available_minutes: data.settings.available_minutes, shared_budget_groups: data.settings.shared_budget_groups }; setDraft(next); setBaseline(JSON.stringify(next)); setRevision(data.settings.revision); setError(null); } catch (failure) { setError(failure); } finally { setBusy(false); } }
  return <div className="settings-page"><div className="page-heading"><div><h1>设置</h1><p>工作节奏、AI 与本地数据。</p></div></div><ThemePicker /><form onSubmit={event => void submit(event)}><section className="settings-section"><h2>时间与容量</h2><p>参考预算与可用容量分别保存，计划与实际投入也会分别记录。</p><div className="settings-form"><Field label="时区"><input required disabled={busy} value={draft.timezone} onChange={event => setDraft(current => ({ ...current, timezone: event.target.value }))} /></Field><Field label="默认日可用容量（分钟）" optional hint="留空表示尚未确定，不会自动推定可用时间。"><input type="number" min="0" step="1" disabled={busy} value={draft.available_minutes ?? ''} onChange={event => setDraft(current => ({ ...current, available_minutes: numberOrNull(event.target.value) }))} /></Field></div></section><section className="settings-section"><h2>共享的投入时段</h2><p>同一时段只累计一次，各项目仍保留独立档案。</p><div className="settings-form">{draft.shared_budget_groups.map(group => <Field key={group.id} label={`${group.title}（分钟）`} hint={group.project_ids.map(id => state.projects.find(project => project.id === id)?.name ?? '未找到项目').join('、') + ' 合计，不代表各自用时。'}><input required type="number" min="0" step="1" disabled={busy} value={group.budget_minutes} onChange={event => setDraft(current => ({ ...current, shared_budget_groups: current.shared_budget_groups.map(item => item.id === group.id ? { ...item, budget_minutes: Number(event.target.value) } : item) }))} /></Field>)}{draft.shared_budget_groups.length === 0 && <p className="field-hint">尚无共享时段。各项目的独立日预算可在项目档案中修改。</p>}</div></section><ErrorNotice error={error}>{error instanceof ApiError && error.status === 409 && <div className="error-actions"><button type="button" className="button-secondary" onClick={() => void reload()} disabled={busy}>放弃草稿，读取最新设置</button></div>}</ErrorNotice><button className="button-primary" disabled={busy || !dirty}>{busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{busy ? '正在保存…' : '保存设置'}</button></form><section className="settings-section" style={{ marginTop: 30 }}><h2>已保存的参考预算</h2><p>下面显示实际保存的项目设置，包含暂停或归档项目；它们不会自动成为今日计划。</p><BudgetList state={state} /></section><div className="quiet-note">当前已支持本地项目、每日计划、成果记录和评分结算。AI 报告已可在复盘页使用；备份入口在本页下方。</div></div>;
}

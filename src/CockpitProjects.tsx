import { ArrowRight, BookOpen, Boxes, FileText, FolderOpen, Microscope, Plus, Sprout } from 'lucide-react';
import { METRICS, type AppState, type OperatingRole, type ProjectStatus, type ProjectType } from '../shared/contracts';

const PROJECT_ICONS: Record<ProjectType, typeof BookOpen> = { novel: BookOpen, publication: FileText, product: Boxes, research: Microscope, foundation: Sprout };

const ROLE_LABELS: Record<OperatingRole, string> = {
  cashflow: '现金流',
  growth: '品牌增长',
  future_asset: '未来资产',
  maintenance: '基础维护',
};

const STATUS_LABELS: Record<ProjectStatus, string> = {
  preparing: '准备中',
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  archived: '已归档',
};

interface Props {
  app: AppState;
  onAdd: (projectId: string) => void;
  onProjects: () => void;
}

export default function CockpitProjects({ app, onAdd, onProjects }: Props) {
  const projects = app.projects.filter(project => project.status === 'active' || project.status === 'preparing').slice(0, 4);

  return <section className="cockpit-projects" aria-label="项目下一步">
    <header className="cockpit-projects-heading">
      <div><h2><FolderOpen size={16} aria-hidden="true" />项目下一步</h2><p>从正在经营的项目里，选一件今天能推进的事。</p></div>
      <button type="button" className="button-quiet cockpit-projects-all" onClick={onProjects}>查看全部 {app.projects.length} 个<ArrowRight size={14} /></button>
    </header>
    {projects.length ? <div className="cockpit-project-grid">
      {projects.map(project => {
        const metric = METRICS.find(item => item.key === project.primary_metric_key);
        const ProjectIcon = PROJECT_ICONS[project.project_type];
        return <article className={`cockpit-project-card role-${project.operating_role}`} key={project.id}>
          <span className="cockpit-project-emblem" aria-hidden="true"><ProjectIcon size={19} /></span>
          <div className="cockpit-project-meta"><span>{ROLE_LABELS[project.operating_role]}</span><span className={`cockpit-project-status status-${project.status}`}>{STATUS_LABELS[project.status]}</span></div>
          <h3>{project.name}</h3>
          <p className="cockpit-project-next">{project.next_action?.trim() || project.next_milestone?.trim() || '下一步待补充'}</p>
          {metric && project.target_value !== null && <p className="cockpit-project-target">目标：{metric.label} {project.target_value.toLocaleString('zh-CN')} {metric.unit}{project.target_date && <span> · {project.target_date}</span>}</p>}
          <button type="button" className="button-quiet cockpit-project-action" onClick={() => onAdd(project.id)} aria-label={`为${project.name}添加任务`}><Plus size={14} />添加任务<ArrowRight size={13} /></button>
        </article>;
      })}
    </div> : <div className="cockpit-project-empty"><FolderOpen size={22} strokeWidth={1.5} /><div><h3>还没有进行中或准备中的项目</h3><p>打开项目，确认当前状态与下一步行动。</p></div><button type="button" className="button-secondary" onClick={onProjects}>管理项目<ArrowRight size={14} /></button></div>}
  </section>;
}

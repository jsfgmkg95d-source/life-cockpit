export const PROJECT_TYPES = ['novel', 'publication', 'product', 'research', 'foundation'] as const;
export const OPERATING_ROLES = ['cashflow', 'growth', 'future_asset', 'maintenance'] as const;
export const PROJECT_STATUSES = ['preparing', 'active', 'paused', 'completed', 'archived'] as const;
export type ProjectType = typeof PROJECT_TYPES[number];
export type OperatingRole = typeof OPERATING_ROLES[number];
export type ProjectStatus = typeof PROJECT_STATUSES[number];

export const METRICS = [
  { key: 'accepted_words', label: '已验收正文', unit: '字' },
  { key: 'accepted_chapters', label: '已验收章节', unit: '章' },
  { key: 'published_chapters', label: '公开章节', unit: '章' },
  { key: 'accepted_articles', label: '已验收文章', unit: '篇' },
  { key: 'published_articles', label: '公开文章', unit: '篇' },
  { key: 'submission_batches', label: '成功提交批次', unit: '批' },
  { key: 'milestone_completed', label: '阶段成果', unit: '项' },
  { key: 'followers', label: '粉丝', unit: '人' },
  { key: 'health_sessions', label: '健康活动', unit: '次' },
  { key: 'learning_outputs', label: '学习成果', unit: '项' },
] as const;
export type MetricKey = typeof METRICS[number]['key'];

export interface ProjectInput {
  name: string;
  project_type: ProjectType;
  platform: string | null;
  operating_role: OperatingRole;
  stage: string;
  status: ProjectStatus;
  primary_metric_key: MetricKey | null;
  baseline_value: number | null;
  /** Date-only YYYY-MM-DD, retained as a dated baseline. No live progress implied. */
  baseline_at: string | null;
  baseline_source: string | null;
  target_value: number | null;
  target_date: string | null;
  next_milestone: string | null;
  next_action: string | null;
  daily_budget_minutes: number | null;
  cadence: { days_per_week: number | null };
  notes: string;
}
export interface Project extends ProjectInput {
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface SharedBudgetGroup {
  id: string;
  title: string;
  project_ids: string[];
  budget_minutes: number;
}
export interface SettingsInput {
  timezone: string;
  available_minutes: number | null;
  /** Reference shared budgets only; individual budgets live on Project. Not daily plans. */
  shared_budget_groups: SharedBudgetGroup[];
}
export interface Settings extends SettingsInput { revision: number }
export interface AppState {
  projects: Project[];
  settings: Settings;
  setupCompleted: boolean;
}
export interface SetupInput { requestId: string; timezone: string; availableMinutes: number | null; mode?: 'blank' | 'demo' }
export interface CreateProjectInput { requestId: string; project: ProjectInput }
export interface UpdateProjectInput { revision: number; project: ProjectInput }
export interface UpdateSettingsInput { revision: number; settings: SettingsInput }
export interface ApiErrorBody { error: { code: string; message: string; fields?: Record<string, string> } }

/** Synthetic examples only. The ordinary workspace starts empty. */
export const DEMO_PROJECTS = [
  { key: 'writing', name: '写一篇文章', project_type: 'publication', platform: null, operating_role: 'growth', next_action: '列出文章的三个要点' },
  { key: 'learning', name: '学习一个主题', project_type: 'research', platform: null, operating_role: 'future_asset', next_action: '读一节内容，写下自己的理解' },
  { key: 'product', name: '推进一个产品', project_type: 'product', platform: null, operating_role: 'future_asset', next_action: '完成一个最小功能' },
] as const;

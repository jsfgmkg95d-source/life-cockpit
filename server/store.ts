import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEMO_PROJECTS } from '../shared/contracts.ts';
import type { AppState, Project, ProjectInput, Settings, SettingsInput } from '../shared/contracts.ts';
import { AppError } from './errors.ts';
import { migrate } from './migrations.ts';

const PROJECT_COLUMNS = [
  'name', 'project_type', 'platform', 'operating_role', 'stage', 'status', 'primary_metric_key',
  'baseline_value', 'baseline_at', 'baseline_source', 'target_value', 'target_date',
  'next_milestone', 'next_action', 'daily_budget_minutes', 'cadence_json', 'notes',
] as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function projectValues(project: ProjectInput) {
  return PROJECT_COLUMNS.map((column) => column === 'cadence_json' ? JSON.stringify(project.cadence) : project[column]);
}

function toProject(row: Record<string, unknown>): Project {
  const { cadence_json, ...fields } = row;
  return { ...fields, cadence: JSON.parse(String(cadence_json)) } as Project;
}

export class Store {
  database: DatabaseSync;
  closed = false;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.database = new DatabaseSync(resolve(dataDir, 'personal-company.sqlite'));
    try {
      migrate(this.database);
      this.database.prepare('INSERT OR IGNORE INTO app_settings(id,settings_json,revision,setup_completed,updated_at) VALUES(1,?,1,0,?)')
        .run(JSON.stringify({ timezone: 'Asia/Shanghai', available_minutes: null, shared_budget_groups: [] }), new Date().toISOString());
    } catch (error) { this.database.close(); throw error; }
  }

  close(): void {
    if (!this.closed) { this.database.close(); this.closed = true; }
  }

  transaction<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.database.exec('COMMIT'); return value; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  getState(): AppState {
    const settingsRow = this.database.prepare('SELECT * FROM app_settings WHERE id=1').get()!;
    const settings = { ...JSON.parse(String(settingsRow.settings_json)), revision: Number(settingsRow.revision) } as Settings;
    return {
      projects: this.database.prepare('SELECT * FROM projects ORDER BY created_at, rowid').all().map(toProject),
      settings,
      setupCompleted: settingsRow.setup_completed === 1,
    };
  }

  getProject(id: string): Project {
    const row = this.database.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!row) throw new AppError(404, 'PROJECT_NOT_FOUND', '未找到该项目，请刷新列表。');
    return toProject(row);
  }

  insertProject(input: ProjectInput): Project {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO projects(id,${PROJECT_COLUMNS.join(',')},revision,created_at,updated_at) VALUES(${Array(PROJECT_COLUMNS.length + 4).fill('?').join(',')})`)
      .run(id, ...projectValues(input), 1, now, now);
    return this.getProject(id);
  }

  idempotent<T>(scope: string, requestId: string, payload: unknown, work: () => T): T {
    return this.transaction(() => {
      const hash = createHash('sha256').update(canonical(payload)).digest('hex');
      const previous = this.database.prepare('SELECT * FROM request_dedup WHERE scope=? AND request_id=?').get(scope, requestId);
      if (previous) {
        if (previous.payload_hash !== hash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '同一保存请求包含不同内容，请刷新后重新保存。');
        return JSON.parse(String(previous.response_json)) as T;
      }
      const response = work();
      this.database.prepare('INSERT INTO request_dedup(scope,request_id,payload_hash,response_json,created_at) VALUES(?,?,?,?,?)')
        .run(scope, requestId, hash, JSON.stringify(response), new Date().toISOString());
      return response;
    });
  }

  setup(requestId: string, timezone: string, availableMinutes: number | null, mode: 'blank' | 'demo' = 'blank'): AppState {
    return this.idempotent('setup', requestId, { timezone, availableMinutes, mode }, () => {
      const before = this.getState();
      if (before.setupCompleted) throw new AppError(409, 'SETUP_ALREADY_COMPLETED', '初始化已经完成；已有项目不会重新导入。');
      if (before.projects.length > 0) throw new AppError(409, 'SETUP_NONEMPTY', '已有手工创建的项目，不能再次导入初始清单。已有数据已保留。');
      for (const initial of mode === 'demo' ? DEMO_PROJECTS : []) {
        this.insertProject({
          name: initial.name, project_type: initial.project_type, platform: initial.platform,
          operating_role: initial.operating_role, daily_budget_minutes: null,
          stage: '示例', status: 'active', primary_metric_key: null,
          baseline_value: null, baseline_at: null, baseline_source: null,
          target_value: null, target_date: null, next_milestone: null, next_action: initial.next_action,
          cadence: { days_per_week: null }, notes: '合成示例数据，用于体验，不代表真实成果。',
        });
      }
      const settings: SettingsInput = {
        timezone, available_minutes: availableMinutes,
        shared_budget_groups: [],
      };
      this.database.prepare('UPDATE app_settings SET settings_json=?,revision=revision+1,setup_completed=1,updated_at=? WHERE id=1')
        .run(JSON.stringify(settings), new Date().toISOString());
      return this.getState();
    });
  }

  createProject(requestId: string, input: ProjectInput): { project: Project } {
    return this.idempotent('create-project', requestId, input, () => ({ project: this.insertProject(input) }));
  }

  updateProject(id: string, revision: number, input: ProjectInput): { project: Project } {
    return this.transaction(() => {
      const previous = this.getProject(id);
      if (previous.revision !== revision) throw new AppError(409, 'REVISION_CONFLICT', '项目已在其他页面更新，请加载最新内容后再保存。');
      if (input.daily_budget_minutes !== null && this.getState().settings.shared_budget_groups.some((group) => group.project_ids.includes(id))) {
        throw new AppError(409, 'SHARED_BUDGET_CONFLICT', '该项目使用共享预算，请保留单项预算为空，或先在设置中移出共享组。');
      }
      this.database.prepare(`UPDATE projects SET ${PROJECT_COLUMNS.map((column) => `${column}=?`).join(',')},revision=revision+1,updated_at=? WHERE id=? AND revision=?`)
        .run(...projectValues(input), new Date().toISOString(), id, revision);
      return { project: this.getProject(id) };
    });
  }

  updateSettings(revision: number, settings: SettingsInput): AppState {
    return this.transaction(() => {
      const before = this.getState();
      if (before.settings.revision !== revision) throw new AppError(409, 'REVISION_CONFLICT', '设置已在其他页面更新，请加载最新内容后再保存。');
      for (const group of settings.shared_budget_groups) {
        for (const id of group.project_ids) {
          const project = before.projects.find((item) => item.id === id);
          if (!project) throw new AppError(400, 'UNKNOWN_PROJECT', '共享预算引用了不存在的项目。');
          if (project.daily_budget_minutes !== null) throw new AppError(409, 'SHARED_BUDGET_CONFLICT', '共享组内项目的单项预算必须为空，避免重复累计。');
        }
      }
      this.database.prepare('UPDATE app_settings SET settings_json=?,revision=revision+1,updated_at=? WHERE id=1 AND revision=?')
        .run(JSON.stringify(settings), new Date().toISOString(), revision);
      return this.getState();
    });
  }
}

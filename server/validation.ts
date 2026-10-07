import { METRICS, OPERATING_ROLES, PROJECT_STATUSES, PROJECT_TYPES } from '../shared/contracts.ts';
import type { ProjectInput, SettingsInput } from '../shared/contracts.ts';
import { invalid } from './errors.ts';

export function object(value: unknown, label: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label}必须是对象。`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) invalid(`${label}包含不支持的字段。`);
  return record;
}

function text(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') invalid(`${label}必须是文字。`);
  const result = value.trim();
  if ((!allowEmpty && result.length === 0) || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(result)) {
    invalid(`${label}${allowEmpty ? '' : '不能为空，且'}不能超过 ${max} 个字符。`);
  }
  return result;
}

function nullableText(value: unknown, label: string, max: number): string | null {
  if (value === null) return null;
  const result = text(value, label, max, true);
  return result || null;
}

export function integer(value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`${label}必须是 ${min} 到 ${max} 之间的整数。`);
  }
  return value;
}

function optionalInteger(value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number | null {
  return value === null ? null : integer(value, label, min, max);
}

function choice<T extends string>(value: unknown, label: string, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) invalid(`${label}不是支持的选项。`);
  return value as T;
}

function dateOnly(value: unknown, label: string): string | null {
  if (value === null) return null;
  const result = text(value, label, 10);
  const timestamp = Date.parse(`${result}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(result) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== result) {
    invalid(`${label}必须是有效的 YYYY-MM-DD 日期。`);
  }
  return result;
}

export function timezone(value: unknown): string {
  const zone = text(value, '时区', 80);
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: zone }).format(); }
  catch { invalid('时区无效，请选择有效的 IANA 时区。'); }
  return zone;
}

export function availableMinutes(value: unknown): number | null {
  return optionalInteger(value, '每日可用分钟数', 0, 1440);
}

export function requestId(value: unknown): string {
  const result = text(value, '请求标识', 128);
  if (!/^[a-zA-Z0-9_-]{8,128}$/u.test(result)) invalid('请求标识格式不正确，请刷新后重试。');
  return result;
}

export function projectInput(value: unknown): ProjectInput {
  const input = object(value, '项目', [
    'name', 'project_type', 'platform', 'operating_role', 'stage', 'status', 'primary_metric_key',
    'baseline_value', 'baseline_at', 'baseline_source', 'target_value', 'target_date',
    'next_milestone', 'next_action', 'daily_budget_minutes', 'cadence', 'notes',
  ]);
  const cadence = object(input.cadence, '更新节奏', ['days_per_week']);
  const metric = input.primary_metric_key === null ? null : choice(input.primary_metric_key, '主指标', METRICS.map((item) => item.key));
  const result: ProjectInput = {
    name: text(input.name, '项目名称', 120),
    project_type: choice(input.project_type, '项目类型', PROJECT_TYPES),
    platform: nullableText(input.platform, '平台', 80),
    operating_role: choice(input.operating_role, '经营角色', OPERATING_ROLES),
    stage: input.stage === undefined ? '待确认' : text(input.stage, '项目阶段', 120, true) || '待确认',
    status: choice(input.status, '项目状态', PROJECT_STATUSES),
    primary_metric_key: metric,
    baseline_value: optionalInteger(input.baseline_value, '基线数量', 0),
    baseline_at: dateOnly(input.baseline_at, '基线日期'),
    baseline_source: nullableText(input.baseline_source, '基线来源', 1000),
    target_value: optionalInteger(input.target_value, '目标数量', 1),
    target_date: dateOnly(input.target_date, '目标日期'),
    next_milestone: nullableText(input.next_milestone, '下一里程碑', 1000),
    next_action: nullableText(input.next_action, '下一步行动', 1000),
    daily_budget_minutes: optionalInteger(input.daily_budget_minutes, '每日投入预算', 0, 1440),
    cadence: { days_per_week: optionalInteger(cadence.days_per_week, '每周计划次数', 1, 7) },
    notes: text(input.notes, '项目备注', 10000, true),
  };
  const baseline = [result.baseline_value, result.baseline_at, result.baseline_source];
  if (baseline.some((part) => part !== null) && baseline.some((part) => part === null)) invalid('基线数量、日期和来源需要一起填写，或一起留空。');
  if (result.primary_metric_key === null && (result.baseline_value !== null || result.target_value !== null)) invalid('填写基线或目标数量前，请先选择主指标。');
  return result;
}

export function settingsInput(value: unknown): SettingsInput {
  const input = object(value, '设置', ['timezone', 'available_minutes', 'shared_budget_groups']);
  if (!Array.isArray(input.shared_budget_groups) || input.shared_budget_groups.length > 20) invalid('共享预算组必须为列表，最多 20 组。');
  const seenGroups = new Set<string>();
  const seenProjects = new Set<string>();
  const groups = input.shared_budget_groups.map((value) => {
    const group = object(value, '共享预算组', ['id', 'title', 'project_ids', 'budget_minutes']);
    const id = text(group.id, '共享预算组标识', 100);
    if (seenGroups.has(id)) invalid('共享预算组标识不能重复。');
    seenGroups.add(id);
    if (!Array.isArray(group.project_ids) || group.project_ids.length < 2 || group.project_ids.length > 50) invalid('共享预算组须关联 2 到 50 个独立项目。');
    const ids = group.project_ids.map((value) => {
      const projectId = text(value, '项目标识', 100);
      if (seenProjects.has(projectId)) invalid('同一项目不能重复加入共享预算组。');
      seenProjects.add(projectId);
      return projectId;
    });
    return { id, title: text(group.title, '共享预算组名称', 120), project_ids: ids, budget_minutes: integer(group.budget_minutes, '共享预算分钟数', 0, 1440) };
  });
  return { timezone: timezone(input.timezone), available_minutes: availableMinutes(input.available_minutes), shared_budget_groups: groups };
}

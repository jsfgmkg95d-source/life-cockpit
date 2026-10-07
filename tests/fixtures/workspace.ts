import { randomUUID } from 'node:crypto';
import type { AppState, ProjectInput, SettingsInput } from '../../shared/contracts.ts';
import type { PlanDraft } from '../../shared/day-contracts.ts';
import type { Store } from '../../server/store.ts';

/** Deliberately richer than onboarding: covers shared budgets and distinct unknown values. */
export const TEST_PROJECTS = [
  { key: 'story-a', name: '示例长篇甲', project_type: 'novel', platform: '测试平台甲', operating_role: 'cashflow', daily_budget_minutes: 60 },
  { key: 'story-b', name: '示例长篇乙', project_type: 'novel', platform: '测试平台甲', operating_role: 'cashflow', daily_budget_minutes: 15 },
  { key: 'journal', name: '示例专栏甲', project_type: 'publication', platform: '测试专栏', operating_role: 'growth', daily_budget_minutes: 30 },
  { key: 'notes', name: '示例专栏乙', project_type: 'publication', platform: '测试专栏', operating_role: 'growth', daily_budget_minutes: 15 },
  { key: 'serial-a', name: '示例连载甲', project_type: 'novel', platform: '测试连载平台', operating_role: 'cashflow', daily_budget_minutes: null },
  { key: 'serial-b', name: '示例连载乙', project_type: 'novel', platform: '测试连载平台', operating_role: 'cashflow', daily_budget_minutes: null },
] as const;
function projectInput(initial: typeof TEST_PROJECTS[number]): ProjectInput {
  const { key: _key, ...project } = initial;
  return { ...project, stage: '待确认', status: 'preparing', primary_metric_key: null,
    baseline_value: null, baseline_at: null, baseline_source: null, target_value: null, target_date: null,
    next_milestone: null, next_action: null, cadence: { days_per_week: null }, notes: '' };
}
function grouped(state: AppState): SettingsInput {
  return { ...state.settings, shared_budget_groups: [{ id: 'synthetic-shared-slot', title: '测试连载平台共用时段', project_ids: state.projects.slice(4).map(project => project.id), budget_minutes: 15 }] };
}
export function setupTestWorkspace(store: Store, requestId: string, timezone: string, availableMinutes: number | null): AppState {
  store.setup(requestId, timezone, availableMinutes);
  if (!store.getState().projects.length) {
    for (const project of TEST_PROJECTS) store.createProject(randomUUID(), projectInput(project));
    const state = store.getState(); store.updateSettings(state.settings.revision, grouped(state));
  }
  return store.getState();
}

/** Real HTTP initialization followed by public project/settings calls; never a production test mode. */
export async function testFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const result = await fetch(input, init);
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname !== '/api/setup' || init?.method !== 'POST' || !result.ok || typeof init.body !== 'string') return result;
  const body = JSON.parse(init.body);
  if (body.mode !== undefined) return result;
  const stateUrl = new URL('/api/state', url);
  let state = await (await fetch(stateUrl)).json() as AppState;
  if (!state.projects.length) {
    for (const project of TEST_PROJECTS) {
      const created = await fetch(new URL('/api/projects', url), { ...init, body: JSON.stringify({ requestId: randomUUID(), project: projectInput(project) }) });
      if (!created.ok) throw new Error(`Synthetic project setup failed: ${await created.text()}`);
    }
    state = await (await fetch(stateUrl)).json() as AppState;
    const { revision: _revision, ...settings } = grouped(state) as SettingsInput & { revision?: number };
    const saved = await fetch(new URL('/api/settings', url), { ...init, method: 'PUT', body: JSON.stringify({ revision: state.settings.revision, settings }) });
    if (!saved.ok) throw new Error(`Synthetic settings setup failed: ${await saved.text()}`);
    state = await saved.json() as AppState;
  }
  return new Response(JSON.stringify(state), { status: result.status, headers: { 'Content-Type': 'application/json' } });
}

/** Explicit unequal weights for scoring/proportional-reallocation counterexamples. */
export function setUnequalTestWeights(draft: PlanDraft): PlanDraft {
  if (draft.tasks.length !== 6) throw new Error('Expected six synthetic projects');
  draft.tasks.forEach((task, index) => { task.raw_points = [30, 10, 20, 10, 5, 5][index]; });
  return draft;
}

import type { Store } from './store.ts';
import type { AssetEvent, DailyLog, PlanSnapshot, ConfirmedResult } from '../shared/day-contracts.ts';
import { METRICS } from '../shared/contracts.ts';
import { isChapterMetric } from '../shared/chapters.ts';
import { chaptersFor } from './chapter-store.ts';
import type { GrowthMetric, GrowthView } from '../shared/growth-contracts.ts';

export function shiftDate(date: string, shift: number) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + shift); return value.toISOString().slice(0, 10); }

export function growth(store: Store, date: string): GrowthView {
  const start7 = shiftDate(date, -6), start30 = shiftDate(date, -29), previousStart = shiftDate(date, -13), previousEnd = shiftDate(date, -7);
  const db = store.database;
  const events = db.prepare(`SELECT e.* FROM asset_events e WHERE e.occurred_on<=? AND e.change_kind!='void' AND NOT EXISTS(SELECT 1 FROM asset_events n WHERE n.supersedes_event_id=e.id) ORDER BY e.occurred_on,e.id`).all(date) as unknown as AssetEvent[];
  const chapterKeys = new Map<string, Set<number>>();
  const identityCounts = new Map<string, number>();
  // A duplicate legacy identity is displayed as unresolved instead of silently trusted.
  for (const event of events) for (const n of chaptersFor(store, event.root_event_id)) { const key = `${event.project_id}:${event.metric_key}:${n}`; identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1); }
  const logs = db.prepare(`SELECT l.* FROM daily_logs l WHERE business_date BETWEEN ? AND ? AND
    (current_plan_version>0 OR draft_plan_json IS NOT NULL OR work_block_actuals_json!='[]' OR EXISTS(SELECT 1 FROM asset_events e WHERE e.daily_log_id=l.id)) ORDER BY business_date`).all(start30, date);
  const recorded = (start: string, end: string) => logs.filter(row => String(row.business_date) >= start && String(row.business_date) <= end);
  const recentLogs = recorded(start7, date);
  const actuals = recentLogs.map(row => JSON.parse(String(row.work_block_actuals_json)) as DailyLog['work_block_actuals']);
  const projects = store.getState().projects.map(project => {
    const own = events.filter(e => e.project_id === project.id);
    const metrics: GrowthMetric[] = METRICS.filter(m => own.some(e => e.metric_key === m.key) || project.primary_metric_key === m.key).map(metric => {
      const members = own.filter(e => e.metric_key === metric.key);
      const unresolved: AssetEvent[] = [];
      const valid = members.filter(event => {
        if (!isChapterMetric(metric.key)) return true;
        const chapters = chaptersFor(store, event.root_event_id);
        const collision = chapters.some(n => (identityCounts.get(`${project.id}:${metric.key}:${n}`) ?? 0) > 1);
        if (chapters.length !== event.value || collision) { unresolved.push(event); return false; }
        const key = `${project.id}:${metric.key}`; const seen = chapterKeys.get(key) ?? new Set<number>(); chapters.forEach(n => seen.add(n)); chapterKeys.set(key, seen);
        return true;
      });
      const sum = (list: AssetEvent[]) => list.reduce((n, e) => n + BigInt(e.value ?? 0), 0n).toString();
      return { metric: metric.key, unit: metric.unit, label: metric.label, recorded: sum(members), identified: sum(valid),
        recent7: sum(valid.filter(e => e.occurred_on >= start7)), previous7: sum(valid.filter(e => e.occurred_on >= previousStart && e.occurred_on <= previousEnd)), recent30: sum(valid.filter(e => e.occurred_on >= start30)),
        unresolved: unresolved.length, recentUnresolved: unresolved.filter(e => e.occurred_on >= start7).length, previousUnresolved: unresolved.filter(e => e.occurred_on >= previousStart && e.occurred_on <= previousEnd).length,
        source_ids: members.map(e => e.id) };
    });
    const main = metrics.find(m => m.metric === project.primary_metric_key);
    let stock: string | null = null;
    let stockNote = '尚无完整基线，累计已记录成果不代表项目全部资产。';
    if (main && project.baseline_value !== null && project.baseline_at && project.baseline_at <= date && main.metric !== 'followers') {
      if (main.unresolved) stockNote = '有章节身份待核对，暂不推算资产总量。';
      else {
        const added = own.filter(e => e.metric_key === main.metric && e.occurred_on > project.baseline_at!).reduce((n, e) => n + BigInt(e.value ?? 0), 0n);
        stock = (BigInt(project.baseline_value) + added).toString();
        stockNote = `按 ${project.baseline_at} 截至日基线＋次日起已记录新增计算；未采集成果仍可能缺失。`;
      }
    }
    return { id: project.id, name: project.name, status: project.status, unit: METRICS.find(m => m.key === project.primary_metric_key)?.unit ?? '', metrics, baseline: project.baseline_value, baselineDate: project.baseline_at, stock,
      remaining: stock !== null && project.target_value !== null ? (BigInt(project.target_value) > BigInt(stock) ? BigInt(project.target_value) - BigInt(stock) : 0n).toString() : null, stockNote };
  });
  const adoptions = db.prepare(`SELECT a.*,r.content_json FROM report_adoptions a JOIN reports r ON r.id=a.report_id WHERE a.target_date BETWEEN ? AND ? ORDER BY a.target_date`).all(start30, date).map(row => {
    const log = db.prepare('SELECT * FROM daily_logs WHERE business_date=?').get(String(row.target_date));
    const plans = log ? JSON.parse(String(log.plan_snapshots_json)) as PlanSnapshot[] : [];
    const current = plans.find(p => p.plan_version === Number(log?.current_plan_version));
    const task = current?.tasks.find(t => t.candidate_id === row.candidate_id);
    const saved = task ? db.prepare('SELECT result_state,confirmed_result_json FROM tasks WHERE id=?').get(task.task_id) : null;
    const result = saved?.confirmed_result_json ? JSON.parse(String(saved.confirmed_result_json)) as ConfirmedResult : null;
    const draft = log?.draft_plan_json ? JSON.parse(String(log.draft_plan_json)) : null;
    const suggestion = JSON.parse(String(row.content_json))?.suggestions?.[Number(row.suggestion_index)];
    return { action: task?.title ?? suggestion?.action ?? '历史建议', targetDate: String(row.target_date), reportId: String(row.report_id),
      state: result ? '已确认结果' : task ? '已进入计划，结果未知' : draft?.tasks?.some((t: { candidate_id: string }) => t.candidate_id === row.candidate_id) ? '仍在草稿' : '未在当前计划或草稿中',
      observed: result && task ? task.result_type === 'binary' ? result.actual_value === 1 ? '验收达成' : '明确未达成' : `${result.actual_value} / ${task.target_value} ${METRICS.find(m => m.key === task.metric_key)?.unit ?? ''}` : '未知；不能据此评价建议效果' };
  });
  return { end: date, start7, start30, previousStart, previousEnd, projects, recordedDays7: recentLogs.length,
    recordedDaysPrevious: recorded(previousStart, previousEnd).length, recordedDays30: logs.length,
    actualMinutes7: actuals.some(a => a.length) ? actuals.flat().reduce((n, a) => n + a.minutes, 0) : null, timeDays7: actuals.filter(a => a.length).length, adoptions };
}

import type { MetricKey } from './contracts.ts';
export interface GrowthMetric {
  metric: MetricKey; unit: string; label: string;
  recorded: string; identified: string; recent7: string; previous7: string; recent30: string;
  unresolved: number; recentUnresolved: number; previousUnresolved: number; source_ids: string[];
}
export interface ProjectGrowth {
  id: string; name: string; status: string; unit: string; metrics: GrowthMetric[];
  baseline: number | null; baselineDate: string | null; stock: string | null; remaining: string | null; stockNote: string;
}
export interface GrowthView {
  end: string; start7: string; start30: string; previousStart: string; previousEnd: string;
  recordedDays7: number; recordedDaysPrevious: number; recordedDays30: number;
  actualMinutes7: number | null; timeDays7: number; projects: ProjectGrowth[];
  adoptions: { action: string; targetDate: string; state: string; observed: string; reportId: string }[];
}

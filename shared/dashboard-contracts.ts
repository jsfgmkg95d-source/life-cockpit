import type { ScoreCalculation } from './score-contracts.ts';
import type { DeltaMetric, Dimension, EventStage } from './day-contracts.ts';

export interface MetricTotal { metric: DeltaMetric; stage: EventStage; value: string; records: number }
export interface DashboardDay {
  date: string; timezone: string; recorded: boolean; settled: boolean;
  mode: 'work' | 'rest' | null; score: ScoreCalculation;
  policy: string | null; dimensions: Dimension[]; planVersion: number;
  plannedTasks: number;
  /** Current planned tasks explicitly marked complete; independent of measured results. */
  completedTasks: number;
  confirmedTasks: number; achievedTasks: number;
  actualMinutes: number | null; recordedBlocks: number; missingBlocks: number;
  budgetMinutes: number | null; missingBudgets: number; capacity: number | null;
  totals: MetricTotal[];
}
export interface DashboardView {
  start: string; end: string; days: DashboardDay[]; totals: MetricTotal[];
  actualMinutes: number | null; recordedTimeDays: number; settledDays: number;
  dimensions: { dimension: Dimension; applicableDays: number; workDays: number }[];
  projects: { id: string; name: string; status: string; plannedDays: number; eventDays: number; latestEvent: string | null; totals: MetricTotal[]; attention: string[] }[];
}
export interface BackupManifest {
  format: 'personal-company-backup-v1'; id: string; createdAt: string; appVersion: string; schemaVersion: number;
  files: Record<'database.sqlite' | 'export.json', { bytes: number; sha256: string }>;
  rowCounts: Record<string, number>; excluded: string[];
}
export interface BackupList { directory: string; backups: BackupManifest[]; unreadable: number }

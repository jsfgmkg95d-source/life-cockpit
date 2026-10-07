import type { MetricTotal } from './dashboard-contracts.ts';

export interface CalendarDay {
  date: string;
  recorded: boolean;
  mode: 'work' | 'rest' | null;
  plannedTasks: number;
  /** Current planned tasks explicitly marked complete; no result verification required. */
  completedTasks: number;
  confirmedTasks: number;
  achievedTasks: number;
  /** Legacy alias of completedTasks, retained for existing integrations. */
  endedTasks: number;
  positiveResultTasks: number;
  hasHarvest: boolean;
  /** Chapter events with missing or conflicting identities are excluded from totals. */
  unresolvedEvents: number;
  totals: MetricTotal[];
}

export interface CalendarMonth {
  month: string;
  today: string;
  days: CalendarDay[];
}

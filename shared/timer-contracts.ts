import type { DayWrite } from './day-contracts.ts';

export interface TimerSession {
  id: string;
  block_id: string;
  block_title: string;
  started_at: string;
  stopped_at: string | null;
  elapsed_seconds: number | null;
  task_id: string | null;
  task_title: string | null;
  target_minutes: number | null;
}
export interface ActiveTimer extends TimerSession { daily_log_id: string; business_date: string; timezone: string }
export interface TimerPoint { id: string; label: string; occurred_at: string; created_at: string }
export interface TimerView {
  active: ActiveTimer | null;
  sessions: TimerSession[];
  points: TimerPoint[];
  summary: {
    /** Recorded authoritative minutes; null means no confirmed time record. */
    todayMinutes: number | null;
    weekMinutes: number | null;
    totalMinutes: number | null;
    timeDays: number;
    week: { date: string; minutes: number | null }[];
    pointCount: number;
  };
}
export interface TimerPointWrite extends DayWrite { label: string; occurred_at: string }
export interface TimerPeriodWrite extends DayWrite { block_id: string; started_at: string; stopped_at: string; acknowledgeUntrackedActual?: boolean }
export interface TimerPointDeleteWrite extends DayWrite { point_id: string }
export interface TimerStartWrite extends DayWrite { block_id: string; task_id?: string | null; target_minutes?: number | null }
export interface TimerStopWrite extends DayWrite {
  discard: boolean; expected_session_id?: string | null;
  /** Captured platform pause time; delayed delivery must not include sleep. */
  stopped_at?: string;
}

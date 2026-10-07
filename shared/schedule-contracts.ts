import type { DayWrite } from './day-contracts.ts';

/** A planned wall-clock allocation in the day's timezone, never an actual session. */
export interface ScheduleBlock {
  id: string;
  task_id: string | null;
  title: string;
  start_minute: number;
  duration_minutes: number;
  task_eligible: boolean | null;
}
export interface ScheduleView {
  business_date: string;
  timezone: string;
  revision: number;
  blocks: ScheduleBlock[];
  plannedMinutes: number;
}
export interface ScheduleSaveWrite extends DayWrite {
  id?: string | null;
  task_id: string | null;
  title: string;
  start_minute: number;
  duration_minutes: number;
}
export interface ScheduleDeleteWrite extends DayWrite { id: string }

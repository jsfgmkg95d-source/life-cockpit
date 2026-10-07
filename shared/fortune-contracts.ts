/** A personal reflection record, separate from plans, confirmed outcomes and scores. */
export interface DailyFortuneRecord {
  businessDate: string;
  revision: number;
  intention: string;
  reflection: string;
  mood: string;
  completedActionIds: string[];
  updatedAt: string | null;
}

export type DailyFortuneWrite = Pick<DailyFortuneRecord,
  'revision' | 'intention' | 'reflection' | 'mood' | 'completedActionIds'>;

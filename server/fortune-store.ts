import type { DailyFortuneRecord, DailyFortuneWrite } from '../shared/fortune-contracts.ts';
import { dayText } from './day-validation.ts';
import { AppError, invalid } from './errors.ts';
import type { Store } from './store.ts';
import { integer, object } from './validation.ts';

export function fortuneWrite(value: unknown): DailyFortuneWrite {
  const input = object(value, '每日行运记录', ['revision', 'intention', 'reflection', 'mood', 'completedActionIds']);
  if (!Array.isArray(input.completedActionIds) || input.completedActionIds.length > 100) invalid('每日练习最多 100 项。');
  const completedActionIds = input.completedActionIds.map((id) => dayText(id, '练习标识', 128));
  if (new Set(completedActionIds).size !== completedActionIds.length) invalid('每日练习不能重复。');
  return {
    revision: integer(input.revision, '每日行运版本', 0),
    intention: dayText(input.intention, '今日意向', 500, true),
    reflection: dayText(input.reflection, '今日回顾', 2000, true),
    mood: dayText(input.mood, '今日心情', 32, true),
    completedActionIds,
  };
}

function toRecord(row: Record<string, unknown>): DailyFortuneRecord {
  return {
    businessDate: String(row.business_date),
    revision: Number(row.revision),
    intention: String(row.intention),
    reflection: String(row.reflection),
    mood: String(row.mood),
    completedActionIds: JSON.parse(String(row.completed_action_ids_json)) as string[],
    updatedAt: String(row.updated_at),
  };
}

export class FortuneStore {
  store: Store;
  constructor(store: Store) { this.store = store; }

  get(date: string): DailyFortuneRecord {
    const row = this.store.database.prepare('SELECT * FROM daily_fortune_records WHERE business_date=?').get(date);
    return row ? toRecord(row) : { businessDate: date, revision: 0, intention: '', reflection: '', mood: '', completedActionIds: [], updatedAt: null };
  }

  put(date: string, input: DailyFortuneWrite): DailyFortuneRecord {
    return this.store.transaction(() => {
      const current = this.get(date);
      if (current.revision !== input.revision) {
        throw new AppError(409, 'REVISION_CONFLICT', '这一天的行运记录已更新，请先加载最新内容；当前输入未覆盖已有记录。');
      }
      const now = new Date().toISOString();
      if (current.revision === 0) {
        this.store.database.prepare(`INSERT INTO daily_fortune_records
          (business_date,revision,intention,reflection,mood,completed_action_ids_json,updated_at)
          VALUES(?,1,?,?,?,?,?)`).run(date, input.intention, input.reflection, input.mood, JSON.stringify(input.completedActionIds), now);
      } else {
        this.store.database.prepare(`UPDATE daily_fortune_records SET revision=revision+1,
          intention=?,reflection=?,mood=?,completed_action_ids_json=?,updated_at=? WHERE business_date=?`)
          .run(input.intention, input.reflection, input.mood, JSON.stringify(input.completedActionIds), now, date);
      }
      return this.get(date);
    });
  }
}

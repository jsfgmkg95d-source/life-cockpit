export type OdetteMood = 'expectant' | 'encouraging' | 'happy' | 'ecstatic' | 'sad' | 'resting';

export interface OdetteMoodInput {
  mode?: string;
  plannedTasks: number;
  completedTasks: number;
  hasHarvest?: boolean;
  future?: boolean;
  past?: boolean;
}

export interface OdetteMoodView {
  mood: OdetteMood;
  label: string;
  message: string;
}

function response(mood: OdetteMood, label: string, message: string): OdetteMoodView {
  return { mood, label, message };
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Expressions follow the user's completion flags, independently of measured results. */
export function getOdetteMood(input: OdetteMoodInput): OdetteMoodView {
  if (input.mode === 'rest') return response('resting', '休息', '这一天已安排休息，给自己留一点空间。');
  if (input.future === true) return response('expectant', '期待', '这一天还没到，先期待新的收获。');

  const { plannedTasks, completedTasks } = input;
  if (![plannedTasks, completedTasks].every(isCount) || completedTasks > plannedTasks) {
    return response('expectant', '期待', '进展暂未同步，先留一点期待。');
  }

  if (plannedTasks === 0) {
    if (input.hasHarvest === true) {
      return response('happy', '开心', '今天已有确认的收获，值得开心。');
    }
    return response('expectant', '期待', '今天暂时没有安排任务，先留一点期待。');
  }

  const completedRatio = completedTasks / plannedTasks;
  if (completedRatio === 1) return response('ecstatic', '雀跃', '这一天的任务都已完成，记住这份进展。');
  if (completedRatio >= 0.75) return response('happy', '开心', '大部分任务已完成，这份进展值得开心。');
  if (input.past && completedRatio < 0.5) return response('sad', '失落', '这一天还有未完成的任务，可以重新安排下一步。');
  if (completedTasks === 0) return response('expectant', '期待', '从一件事开始，完成后点一下就好。');
  return response('encouraging', '鼓励', '已经完成了一部分，按自己的节奏继续。');
}

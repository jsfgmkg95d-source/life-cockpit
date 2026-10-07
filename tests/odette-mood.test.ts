import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOdetteMood, type OdetteMoodInput } from '../shared/odette-mood.ts';

function mood(changes: Partial<OdetteMoodInput> = {}) {
  return getOdetteMood({ mode: 'work', plannedTasks: 4, completedTasks: 4, ...changes });
}

test('点完成直接驱动表情，不需要核验结果或成果数量', () => {
  for (const [plannedTasks, completedTasks, expected] of [
    [4, 4, 'ecstatic'], [4, 3, 'happy'], [4, 2, 'encouraging'], [4, 1, 'encouraging'], [4, 0, 'expectant'],
    [100, 74, 'encouraging'], [100, 75, 'happy'], [1, 1, 'ecstatic'], [1, 0, 'expectant'],
  ] as const) {
    const view = mood({ plannedTasks, completedTasks });
    assert.equal(view.mood, expected);
    assert.doesNotMatch(view.message, /核对|待确认|验收/);
  }
});

test('当天没做完仍可继续，只有过去日期的低完成比例显示失落', () => {
  assert.equal(mood({ completedTasks: 0 }).mood, 'expectant');
  assert.equal(mood({ completedTasks: 1 }).mood, 'encouraging');
  assert.equal(mood({ completedTasks: 0, past: true }).mood, 'sad');
  assert.equal(mood({ completedTasks: 1, past: true }).mood, 'sad');
  assert.equal(mood({ completedTasks: 2, past: true }).mood, 'encouraging');
});

test('休息优先且未来日期保持期待，不推断未来完成', () => {
  assert.equal(mood({ mode: 'rest', future: true }).mood, 'resting');
  assert.match(mood({ mode: 'rest', future: true }).message, /这一天已安排休息/);
  assert.equal(mood({ mode: 'rest', plannedTasks: NaN, completedTasks: Infinity }).mood, 'resting');
  assert.equal(mood({ future: true }).mood, 'expectant');
  assert.equal(mood({ future: true, plannedTasks: 0, completedTasks: 0, hasHarvest: true }).mood, 'expectant');
});

test('无计划不生成完成率，真实已确认收获仍可开心', () => {
  const empty = { plannedTasks: 0, completedTasks: 0 };
  assert.equal(mood(empty).mood, 'expectant');
  const harvest = mood({ ...empty, hasHarvest: true });
  assert.equal(harvest.mood, 'happy');
  assert.doesNotMatch(harvest.message, /%|百分|全部|比例/);
  assert.equal(mood({ plannedTasks: 0, completedTasks: 1 }).mood, 'expectant');
});

test('坏数和矛盾计数保持期待，不强转零或制造完成', () => {
  for (const field of ['plannedTasks', 'completedTasks'] as const) {
    for (const value of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, null, '4']) {
      assert.equal(mood({ [field]: value } as Partial<OdetteMoodInput>).mood, 'expectant');
    }
  }
  assert.equal(mood({ completedTasks: 5 }).mood, 'expectant');
});

test('规则不修改输入，并为每个状态提供简短标签和说明', () => {
  const input: OdetteMoodInput = { plannedTasks: 8, completedTasks: 6 };
  const original = structuredClone(input);
  const view = getOdetteMood(input);
  assert.deepEqual(input, original);
  assert.equal(view.mood, 'happy');
  assert.ok(view.label && view.message);
});

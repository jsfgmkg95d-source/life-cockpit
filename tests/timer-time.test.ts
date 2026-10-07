import assert from 'node:assert/strict';
import { test } from 'node:test';
import { businessTimeToIso, clockTime, timerDuration } from '../shared/timer-time.ts';
test('时刻按账本时区转换，保留秒数，午夜不写入错误日期', () => {
  assert.equal(businessTimeToIso('2026-09-30', '00:05:12', 'Asia/Shanghai'), '2026-09-29T16:05:12.000Z');
  assert.equal(clockTime('2026-09-29T16:05:12.000Z', 'Asia/Shanghai'), '00:05:12');
  assert.equal(businessTimeToIso('2026-09-30', '12:34', 'Asia/Kolkata'), '2026-09-30T07:04:00.000Z');
  assert.throws(() => businessTimeToIso('2026-02-30', '12:00', 'Asia/Shanghai'));
});
test('夏令时不存在或重复的时刻须由用户核对', () => {
  assert.throws(() => businessTimeToIso('2026-03-08', '02:30', 'America/New_York'));
  assert.throws(() => businessTimeToIso('2026-11-01', '01:30', 'America/New_York'));
  assert.equal(businessTimeToIso('2026-11-01', '03:30', 'America/New_York'), '2026-11-01T08:30:00.000Z');
});
test('用时超过一小时展示小时，不丢掉一分钟以内投入', () => {
  assert.equal(timerDuration(59), '00:59'); assert.equal(timerDuration(3661), '01:01:01');
});

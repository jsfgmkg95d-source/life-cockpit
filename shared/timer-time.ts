export function clockTime(value: number | string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}
export function timerDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(Math.floor(safe / 60) % 60).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}
// Use the business timezone, which can differ from the browser timezone.
export function businessTimeToIso(date: string, time: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(time)) throw new Error('请填写有效的时刻。');
  const full = time.length === 5 ? `${time}:00` : time;
  const wall = Date.parse(`${date}T${full}Z`);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const wallAt = (stamp: number) => { const parts = formatter.formatToParts(stamp); const get = (kind: string) => parts.find(part => part.type === kind)!.value; return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`; };
  let candidate = wall;
  for (let attempt = 0; attempt < 4; attempt++) { const displayed = Date.parse(`${wallAt(candidate)}Z`); if (displayed === wall) break; candidate += wall - displayed; }
  if (wallAt(candidate) !== `${date}T${full}`) throw new Error('该时区在此时刻发生了跳时，请核对实际发生的时间。');
  if ([candidate - 3600000, candidate + 3600000, candidate - 1800000, candidate + 1800000].some(stamp => wallAt(stamp) === `${date}T${full}`)) throw new Error('该时区的这个时刻重复出现，请核对累计分钟或选择一个明确时刻。');
  return new Date(candidate).toISOString();
}

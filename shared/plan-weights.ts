/** Keep positive integer points and the existing proportions within a dimension. */
export function apportion(weights: number[], total: number): number[] {
  if (!weights.length) return [];
  if (weights.length > total) throw new Error('这个维度的任务数量已达到可分配权重上限，请在调整安排中合并任务。');
  const positive = weights.map(weight => Math.max(0, weight));
  const sum = positive.reduce((value, weight) => value + weight, 0);
  const ideals = positive.map(weight => (sum ? weight / sum : 1 / weights.length) * total);
  const result = ideals.map(value => Math.max(1, Math.floor(value)));
  let difference = total - result.reduce((value, points) => value + points, 0);
  while (difference !== 0) {
    const direction = difference > 0 ? 1 : -1;
    let best = -1;
    for (let i = 0; i < result.length; i++) {
      if (direction < 0 && result[i] <= 1) continue;
      if (best < 0 || direction * (ideals[i] - result[i]) > direction * (ideals[best] - result[best])) best = i;
    }
    result[best] += direction;
    difference -= direction;
  }
  return result;
}

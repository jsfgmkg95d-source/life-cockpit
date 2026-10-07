/** Explicit chapter identities only. Free-text quantities are never inferred. */
export function parseChapters(text: string): number[] {
  if (!text.trim()) return [];
  const result: number[] = [];
  for (const part of text.replaceAll('，', ',').split(',')) {
    const match = /^\s*(\d+)\s*(?:[-—–~至]\s*(\d+)\s*)?$/u.exec(part);
    if (!match) throw new Error('章节请填写 193-200 或 193,195，每次最多 500 章。');
    const start = Number(match[1]); const end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start >= 500) throw new Error('章节范围无效，每次最多 500 章。');
    for (let n = start; n <= end; n++) result.push(n);
  }
  if (result.length > 500 || new Set(result).size !== result.length) throw new Error('章号不能重复，每次最多 500 章。');
  return result.sort((a, b) => a - b);
}

export function chapterFromKey(key: string): number[] {
  const match = /^(?:github:[^:\s/]+\/[^:\s/]+:chapter:|chapter:)(\d+)$/u.exec(key);
  return match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0 ? [Number(match[1])] : [];
}

export function isChapterMetric(metric: string): boolean { return metric === 'accepted_chapters' || metric === 'published_chapters'; }

export function resultDisabled(busy: boolean, type: 'binary' | 'quant', value: string): boolean {
  return busy || (type === 'binary' && value === '');
}

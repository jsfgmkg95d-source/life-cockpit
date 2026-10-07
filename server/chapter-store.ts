import type { Store } from './store.ts';
import type { AssetEvent } from '../shared/day-contracts.ts';
import { chapterFromKey, isChapterMetric } from '../shared/chapters.ts';
import { invalid } from './errors.ts';

export function checkedChapters(numbers: unknown, metric: string, value: number, key: string): number[] {
  const selected = numbers === undefined || (Array.isArray(numbers) && numbers.length === 0) ? chapterFromKey(key) : numbers;
  if (!Array.isArray(selected) || selected.length > 500 || selected.some(n => !Number.isSafeInteger(n) || n < 1) || new Set(selected).size !== selected.length) invalid('章号必须是不重复的正整数，每次最多 500 章。');
  if (selected.length && (!isChapterMetric(metric) || selected.length !== value)) invalid('章节身份数量必须与章节指标的成果数量一致。');
  return [...selected].sort((a, b) => a - b);
}

export function chapterMatches(store: Store, project: string, metric: string, chapter: number): AssetEvent[] {
  return store.database.prepare(`SELECT e.* FROM asset_chapters c JOIN asset_events e ON e.root_event_id=c.root_event_id
    WHERE e.project_id=? AND e.metric_key=? AND c.chapter=? AND NOT EXISTS(SELECT 1 FROM asset_events n WHERE n.supersedes_event_id=e.id)`)
    .all(project, metric, chapter) as unknown as AssetEvent[];
}

export function chaptersFor(store: Store, root: string): number[] {
  return store.database.prepare('SELECT chapter FROM asset_chapters WHERE root_event_id=? ORDER BY chapter').all(root).map(row => Number(row.chapter));
}

// Only server-created roots can own this relation. Their key includes their own
// server-generated UUID; user-entered artifact keys cannot create these links.
export function chapterReplacementRoots(store: Store, root: string): Set<string> {
  const roots = new Set<string>([root]);
  let current = root;
  while (true) {
    const record = store.database.prepare("SELECT artifact_key FROM asset_events WHERE id=? AND root_event_id=id AND change_kind='record'").get(current);
    if (record?.artifact_key !== `pcos-internal:chapter-correction:${current}`) break;
    const relation = store.database.prepare("SELECT evidence_key FROM asset_evidence WHERE root_event_id=? AND evidence_key LIKE 'pcos-internal:replaces:%'").get(current);
    const previous = relation ? String(relation.evidence_key).slice('pcos-internal:replaces:'.length) : '';
    if (!previous || roots.has(previous)) break;
    roots.add(previous); current = previous;
  }
  return roots;
}

export function unknownBatches(store: Store, project: string, date?: string): AssetEvent[] {
  return store.database.prepare(`SELECT e.* FROM asset_events e WHERE e.project_id=? AND e.metric_key='accepted_chapters'
    AND e.change_kind!='void' AND e.value>0 AND NOT EXISTS(SELECT 1 FROM asset_events n WHERE n.supersedes_event_id=e.id)
    AND NOT EXISTS(SELECT 1 FROM asset_chapters c WHERE c.root_event_id=e.root_event_id) ${date ? 'AND e.occurred_on=?' : ''}`)
    .all(...(date ? [project, date] : [project])) as unknown as AssetEvent[];
}

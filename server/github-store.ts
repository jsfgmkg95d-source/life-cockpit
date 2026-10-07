import type { GitHubCandidate, GitHubStatus } from '../shared/github-contracts.ts';
import type { DayWrite, EventInput } from '../shared/day-contracts.ts';
import { chapterMatches, unknownBatches } from './chapter-store.ts';
import { AppError, invalid } from './errors.ts';
import type { DayStore } from './day-store.ts';

export const WEDDING_REPOSITORY = 'https://example.invalid/sample-repository';
interface Snapshot { head: string; paths: string[] }
interface Connection { project_id: string; baseline_at: string; checked_at: string; head: string; known: number[]; candidates: GitHubCandidate[] }

/** Only canonical chapter paths count. Edits, renames and deleted/re-added chapters are not new assets. */
export function chapterInventory(paths: string[]): Map<number, string> {
  const chapters = new Map<number, string>();
  for (const path of paths) {
    const match = /^正文\/第(\d+)章\.md$/u.exec(path);
    if (!match) continue;
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || number < 1) continue;
    if (chapters.has(number)) invalid(`远端第 ${number} 章有多个文件，先核对仓库再采集。`);
    chapters.set(number, path);
  }
  return chapters;
}

export class GitHubStore {
  private running = false;
  lastError: string | null = null;
  private reader: () => Promise<Snapshot>;
  private days: DayStore;
  constructor(days: DayStore, _dataDir: string, reader?: () => Promise<Snapshot>) {
    this.days = days;
    this.reader = reader ?? (() => this.remoteSnapshot());
  }
  private read(): Connection | null {
    try { return JSON.parse(String(this.days.store.database.prepare("SELECT state_json FROM connector_states WHERE id='wedding'").get()?.state_json ?? 'null')) as Connection | null; }
    catch { throw new AppError(409, 'CONNECTOR_STATE', '采集状态无法读取，请保留当前数据库并检查完整备份。'); }
  }
  private save(value: Connection) {
    this.days.store.database.prepare("UPDATE connector_states SET state_json=?,updated_at=? WHERE id='wedding'").run(JSON.stringify(value), new Date().toISOString());
  }
  status(): GitHubStatus {
    const state = this.read();
    return { connected: !!state, project_id: state?.project_id ?? null, repository: WEDDING_REPOSITORY, branch: 'main',
      last_error: this.lastError, unidentified_batches: state ? unknownBatches(this.days.store, state.project_id).length : 0,
      baseline_at: state?.baseline_at ?? null, checked_at: state?.checked_at ?? null, head: state?.head ?? null, known_count: state?.known.length ?? 0,
      candidates: state?.candidates.filter(item => !this.days.store.database.prepare(`SELECT e.id FROM asset_events e WHERE e.project_id=? AND e.artifact_key=? AND e.metric_key='accepted_chapters' AND e.change_kind='record'
        UNION ALL SELECT v.root_event_id FROM asset_evidence v JOIN asset_events e ON e.id=v.root_event_id WHERE e.project_id=? AND v.evidence_key=?`).get(state.project_id, item.artifact_key, state.project_id, item.artifact_key)).map(item => {
          const matches = chapterMatches(this.days.store, state.project_id, 'accepted_chapters', item.chapter);
          const active = matches.filter(event => event.change_kind !== 'void');
          return { ...item, disposition: active.length > 1 || (!active.length && matches.length) ? 'conflict' as const : active.length ? 'recorded' as const : 'new' as const,
            recorded_on: active[0]?.occurred_on ?? null, recorded_task_id: active[0]?.task_id ?? null, recorded_root_id: active[0]?.root_event_id ?? null, recorded_value: active[0]?.value ?? null };
        }) ?? [],
    };
  }
  private async remoteSnapshot(): Promise<Snapshot> { throw new AppError(410, 'CONNECTOR_DISABLED', '公开版未启用远端章节采集。'); }
  async scan(projectId?: string): Promise<GitHubStatus> {
    if (this.running) throw new AppError(409, 'GITHUB_BUSY', '正在检查远端，请稍后刷新。');
    this.running = true;
    try {
      const previous = this.read();
      if (!previous && !projectId) invalid('请先连接示例长篇甲项目。');
      if (previous && projectId && previous.project_id !== projectId) invalid('当前连接已绑定项目，不能重新归属已有基线。');
      const id = previous?.project_id ?? projectId!;
      const project = this.days.store.getProject(id);
      // Once bound, the stable project ID remains authoritative even when its display name changes.
      if ((!previous && project.name !== '示例长篇甲') || project.project_type !== 'novel') invalid('当前连接仅支持已核实的示例长篇甲小说项目。');
      const snapshot = await this.reader();
      const inventory = chapterInventory(snapshot.paths);
      if (!inventory.size) invalid('远端没有符合约定的正文文件，保留原基线。');
      const now = new Date().toISOString();
      const known = new Set(previous?.known ?? [...inventory.keys()]);
      const candidates = [...(previous?.candidates ?? [])];
      for (const [chapter, path] of inventory) {
        if (!known.has(chapter)) candidates.push({ chapter, path, artifact_key: `github:example/sample-repository:chapter:${chapter}`, commit: snapshot.head, observed_at: now, url: `${WEDDING_REPOSITORY}/blob/${snapshot.head}/${encodeURIComponent(path).replaceAll('%2F', '/')}` });
        known.add(chapter);
      }
      this.save({ project_id: id, baseline_at: previous?.baseline_at ?? now, checked_at: now, head: snapshot.head, known: [...known].sort((a, b) => a - b), candidates });
      this.lastError = null;
      return this.status();
    } finally { this.running = false; }
  }
  events(chapters: number[], taskId: string | null): EventInput[] {
    if (!chapters.length || chapters.length > 100 || chapters.some(n => !Number.isSafeInteger(n) || n < 1) || new Set(chapters).size !== chapters.length) invalid('请选择 1–100 个不同章节，并核对发生日期。');
    const state = this.read();
    if (!state) invalid('尚未建立 GitHub 基线。');
    const candidates = chapters.map(chapter => {
      const item = state.candidates.find(candidate => candidate.chapter === chapter);
      if (!item) invalid('选中的章节不属于本次连接的待核对记录。');
      return item;
    });
    return candidates.map(item => ({ project_id: state.project_id, task_id: taskId, chapter_numbers: [item.chapter],
      artifact_key: item.artifact_key, metric_key: 'accepted_chapters', value: 1, stage: 'finalized',
      summary: `第 ${item.chapter} 章定稿已存在于 GitHub main`,
      source: `GitHub 远端文件已核验：${item.url}；首次发现 ${item.observed_at}；发生日期由用户核对，不推定推送时间。`,
    }));
  }
  import(date: string, input: DayWrite, chapters: number[], taskId: string | null, confirmed: boolean) {
    if (!confirmed) invalid('请核对发生日期。');
    return this.days.importEvents(date, input, this.events(chapters, taskId));
  }
}

export interface GitHubCandidate {
  disposition?: 'new' | 'recorded' | 'conflict';
  recorded_on?: string | null;
  recorded_task_id?: string | null;
  recorded_root_id?: string | null;
  recorded_value?: number | null;
  chapter: number;
  path: string;
  artifact_key: string;
  commit: string;
  observed_at: string;
  url: string;
}
export interface GitHubStatus {
  last_error?: string | null;
  unidentified_batches?: number;
  connected: boolean;
  project_id: string | null;
  repository: string;
  branch: string;
  baseline_at: string | null;
  checked_at: string | null;
  head: string | null;
  known_count: number;
  candidates: GitHubCandidate[];
}

import type { BackupManifest } from './dashboard-contracts.ts';

export const RESTORE_CONFIRMATION = '恢复本地账本';

/** Preview does not alter the ledger; the token binds the backup and current facts. */
export interface RestorePreview {
  token: string;
  backup: BackupManifest;
  expiresAt: string;
  currentCounts: Record<string, number>;
  incomingCounts: Record<string, number>;
  currentHash: string;
  warnings: string[];
}

export interface RestoreRequest {
  requestId: string;
  token: string;
  confirmation: typeof RESTORE_CONFIRMATION;
}

/** Operational receipt survives later restores; it is not a business fact. */
export interface RestoreReceipt {
  requestId: string;
  backupId: string;
  preservationBackupId: string;
  restoredAt: string;
  sourceSha256: string;
}

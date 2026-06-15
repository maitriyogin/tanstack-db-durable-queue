export type QueueOpType = 'insert' | 'update' | 'delete';
export type QueueOpStatus = 'pending' | 'inflight';

// One row in the active queue. Persisted; survives reload.
export interface QueueOpRow {
  id: string;
  collectionId: string;
  type: QueueOpType;
  key: string;
  payload: { modified?: unknown; original?: unknown };
  enqueuedAt: number;
  seq: number;
  attempts: number;
  status: QueueOpStatus;
  sessionId?: string;
  recoveredFromCrash?: boolean;
  correlationKey: string;
  nextAttemptAt: number | null;
}

export interface QuarantineRow extends QueueOpRow {
  quarantineReason: 'parent' | 'cascade';
  quarantineError?: string;
  quarantinedAt: number;
}

export interface IdBinding {
  collectionId: string;
  tempId: string;
  serverId: string;
  boundAt: number;
}

export const TEMP_ID_PREFIX = 'temp_';
export const isTempId = (id: string): boolean => id.startsWith(TEMP_ID_PREFIX);
export const mintTempId = (): string => `${TEMP_ID_PREFIX}${crypto.randomUUID()}`;
export const bindingKey = (collectionId: string, tempId: string): string =>
  `${collectionId}:${tempId}`;

export const MAX_ATTEMPTS = 5;
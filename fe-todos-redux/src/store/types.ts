// Domain types — kept in sync with fe-todos/src/db/types.ts. Matched intentionally
// so both apps target the same BFF without divergence.
export interface Todo {
  id: string;
  name: string;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTodoInput {
  id?: string;
  name: string;
  description?: string;
  status: string;
}

export interface UpdateTodoInput {
  id: string;
  name?: string;
  description?: string;
  status?: string;
}

// ---- Durable queue types ----

export type QueueOpType = 'insert' | 'update' | 'delete';
// `quarantined` rows live in the same slice as `pending`/`inflight` rows —
// keeping one collection means selectors see them all in one place. The
// runner ignores quarantined rows in pickNext.
export type QueueOpStatus = 'pending' | 'inflight' | 'quarantined';

export interface QueueOp<T = unknown> {
  id: string;
  collectionId: string;
  type: QueueOpType;
  // Row identity. For inserts this is the temp id minted on the FE; for
  // update/delete it's the row's current id (which may be a temp id if the
  // create hasn't acked yet — the runner rewrites at dispatch).
  key: string;
  payload: {
    modified?: T;
    original?: T;
    changes?: Partial<T>;
  };
  enqueuedAt: number;
  // Monotonic counter — drain order. wall-clock `enqueuedAt` ties when
  // many ops fire in the same tick (tested in fe-todos's task #2).
  seq: number;
  attempts: number;
  status: QueueOpStatus;
  // Box #9: ops sharing a correlation key quarantine as a group.
  correlationKey: string;
  // Box #8: wall-clock ms when the op becomes eligible. null = now.
  // Persisted with the op so a 25s remaining backoff still waits 25s
  // after a reload.
  nextAttemptAt: number | null;
  // Box #9: set when the op moves from active to quarantined.
  quarantineReason?: 'parent' | 'cascade';
  quarantineError?: string;
  quarantinedAt?: number;
  // Box #12: identifies the session that last flipped this op to inflight.
  // Cold-boot sweep uses it to spot crash leftovers.
  sessionId?: string;
  // Box #12: set true when the cold-boot sweep promotes this op back to
  // pending after a crash. Cleared on the next attempt.
  recoveredFromCrash?: boolean;
}

export interface IdBinding {
  id: string; // `${collectionId}:${tempId}`
  collectionId: string;
  tempId: string;
  serverId: string;
  boundAt: number;
}

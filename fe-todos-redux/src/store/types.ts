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
export type QueueOpStatus = 'pending' | 'inflight';

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
  // Future-proofing for tasks #4 / #9 / #11 / #12. Carried through the
  // slice now so persistence shape doesn't churn later.
  correlationKey: string;
  nextAttemptAt: number | null;
}

export interface IdBinding {
  id: string; // `${collectionId}:${tempId}`
  collectionId: string;
  tempId: string;
  serverId: string;
  boundAt: number;
}

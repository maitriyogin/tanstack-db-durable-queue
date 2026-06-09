// Domain types — matched across all FE builds (fe-todos, fe-todos-redux,
// fe-todos-legend) so they all hit the same BFF schema.
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

export type QueueOpType = 'insert' | 'update' | 'delete';
export type QueueOpStatus = 'pending' | 'inflight' | 'quarantined';

export interface QueueOp<T = unknown> {
  id: string;
  collectionId: string;
  type: QueueOpType;
  key: string;
  payload: {
    modified?: T;
    original?: T;
    changes?: Partial<T>;
  };
  enqueuedAt: number;
  seq: number;
  attempts: number;
  status: QueueOpStatus;
  correlationKey: string;
  nextAttemptAt: number | null;
  quarantineReason?: 'parent' | 'cascade';
  quarantineError?: string;
  quarantinedAt?: number;
  sessionId?: string;
  recoveredFromCrash?: boolean;
}

export interface IdBinding {
  id: string;
  collectionId: string;
  tempId: string;
  serverId: string;
  boundAt: number;
}

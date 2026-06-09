import { state$ } from './state';
import * as graphql from './graphql';
import {
  mintTempId,
  type CollectionHandlers,
  type MutationQueue,
} from './mutationQueue';
import type { CreateTodoInput, QueueOp, Todo } from './types';

export const TODOS_COLLECTION_ID = 'todos';
export const TODOS_QUERY_KEY = ['todos'] as const;

// Wires the todos collection into the runner. Called once after the
// queue is constructed. Hand-off matches the redux/valtio builds — this
// build only swaps the state container, not the runner contract.
export function registerTodosCollection(queue: MutationQueue): void {
  const handlers: CollectionHandlers<Todo> = {
    primaryQueryKey: TODOS_QUERY_KEY,
    invalidates: [],

    onInsert: async (op) => {
      const inserted = op.payload.modified;
      if (!inserted) throw new Error('insert op missing payload.modified');
      const created = await graphql.createTodo(
        {
          name: inserted.name,
          description: inserted.description,
          status: inserted.status,
        },
        op.id, // X-Client-Op-Id for BFF idempotency dedup
      );
      return { serverId: created.id };
    },

    onUpdate: async (op) => {
      const modified = op.payload.modified;
      if (!modified) throw new Error('update op missing payload.modified');
      await graphql.updateTodo(
        {
          id: op.key, // already temp→server rewritten by the runner
          name: modified.name,
          description: modified.description,
          status: modified.status,
        },
        op.id,
      );
    },

    onDelete: async (op) => {
      await graphql.deleteTodo(op.key, op.id);
    },
  };
  queue.registerCollection<Todo>(TODOS_COLLECTION_ID, handlers);
}

// ---- read-side helpers ----

// Box #2 read side: synced cache + queued ops layered on top in seq order.
// Plain function rather than a `computed()` because consumers are React
// components that wrap this in `useValue(() => computeTodos())`. Legend
// State tracks every `.get()` call inside that `useValue` callback, so
// the component re-renders whenever byId, ops, or bindings change.
export function computeTodos(): Todo[] {
  const byId = state$.todos.byId.get() as Record<string, Todo>;
  const ops = state$.queue.ops.get() as Record<string, QueueOp>;
  const overlay: Record<string, Todo> = { ...byId };
  const queued = Object.values(ops)
    .filter(
      (op): op is QueueOp<Todo> =>
        op.collectionId === TODOS_COLLECTION_ID && op.status !== 'quarantined',
    )
    .sort((a, b) => a.seq - b.seq);
  for (const op of queued) {
    if (op.type === 'insert') {
      const next = op.payload.modified;
      if (next) overlay[op.key] = next;
    } else if (op.type === 'update') {
      const existing = overlay[op.key];
      const next = op.payload.modified;
      if (existing && next) overlay[op.key] = { ...existing, ...next };
      else if (next) overlay[op.key] = next;
    } else {
      delete overlay[op.key];
    }
  }
  return Object.values(overlay).sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
}

// Box #4: render-key alias. Returns the temp id for a known binding,
// otherwise the input. Used as React `key=` so a row doesn't unmount on
// temp→server flip.
export function aliasFor(key: string): string {
  const bindings = state$.queue.bindings.get() as Record<string, { collectionId: string; tempId: string; serverId: string }>;
  for (const b of Object.values(bindings)) {
    if (b.collectionId === TODOS_COLLECTION_ID && b.serverId === key) {
      return b.tempId;
    }
  }
  return key;
}

// Box #9/#10: parent-quarantined ops keyed by row id, for the failure
// band UI. Cascade siblings show up via their group's anchor, not as
// independent rows.
export function computeQuarantineByRowId(): Map<string, QueueOp> {
  const m = new Map<string, QueueOp>();
  const ops = state$.queue.ops.get() as Record<string, QueueOp>;
  for (const op of Object.values(ops)) {
    if (op.collectionId !== TODOS_COLLECTION_ID) continue;
    if (op.status !== 'quarantined') continue;
    if (op.quarantineReason !== 'parent') continue;
    m.set(op.key, op);
  }
  return m;
}

export function computeQueueDepth(): number {
  const ops = state$.queue.ops.get() as Record<string, QueueOp>;
  return Object.values(ops).filter((op) => op.status !== 'quarantined').length;
}

// ---- user-facing helpers ----

function buildOp<T>(
  type: QueueOp['type'],
  key: string,
  payload: QueueOp<T>['payload'],
): Omit<QueueOp<T>, 'seq'> {
  return {
    id: crypto.randomUUID(),
    collectionId: TODOS_COLLECTION_ID,
    type,
    key,
    payload,
    enqueuedAt: Date.now(),
    attempts: 0,
    status: 'pending',
    correlationKey: `${TODOS_COLLECTION_ID}:${key}`,
    nextAttemptAt: null,
  };
}

export function addTodo(
  queue: MutationQueue,
  input: CreateTodoInput,
): { id: string; promise: Promise<void> } {
  const id = mintTempId();
  const now = new Date().toISOString();
  const optimistic: Todo = {
    id,
    name: input.name,
    description: input.description ?? '',
    status: input.status,
    createdAt: now,
    updatedAt: now,
  };
  const op = buildOp<Todo>('insert', id, { modified: optimistic });
  return { id, promise: queue.enqueueAndAwait<Todo>(op) };
}

export function updateTodo(
  queue: MutationQueue,
  id: string,
  patch: Partial<Pick<Todo, 'name' | 'description' | 'status'>>,
  current: Todo,
): Promise<void> {
  const modified: Todo = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  const op = buildOp<Todo>('update', id, { modified, original: current });
  return queue.enqueueAndAwait<Todo>(op);
}

export function deleteTodo(
  queue: MutationQueue,
  id: string,
  current: Todo,
): Promise<void> {
  const op = buildOp<Todo>('delete', id, { original: current });
  return queue.enqueueAndAwait<Todo>(op);
}

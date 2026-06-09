import * as graphql from './graphql';
import { mintTempId, type MutationQueue } from './mutationQueue';
import type { CreateTodoInput, QueueOp, Todo } from './types';

// Wires the todos collection into the runner. Two responsibilities:
//   1. registerCollection — tells the runner how to dispatch each op type
//      against the BFF and which TQ query to invalidate after an ack.
//   2. exports user-facing addTodo / updateTodo / deleteTodo — these are
//      the methods components call. They mint the op id, build the payload,
//      and hand it to the queue.
//
// The wrapper does NOT touch redux directly for optimistic state — the
// queue's enqueue action is what makes the row visible. selectTodos in
// selectors.ts overlays the queue on top of the synced cache at read time.

export const TODOS_COLLECTION_ID = 'todos';
export const TODOS_QUERY_KEY = ['todos'] as const;

export function registerTodosCollection(queue: MutationQueue) {
  queue.registerCollection<Todo>(TODOS_COLLECTION_ID, {
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
        op.id, // X-Client-Op-Id — BFF idempotency dedups on this
      );
      return { serverId: created.id };
    },

    onUpdate: async (op) => {
      const modified = op.payload.modified;
      if (!modified) throw new Error('update op missing payload.modified');
      await graphql.updateTodo(
        {
          id: op.key, // already rewritten temp→server by the runner
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
  });
}

// ---- Helpers for components ----

// Build a queue op without seq (the runner stamps it on enqueue). The
// payload shape mirrors the TanStack DB version so a future port of
// existing fe-todos components is mostly a method-name swap.
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
  const modified: Todo = { ...current, ...patch, updatedAt: new Date().toISOString() };
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

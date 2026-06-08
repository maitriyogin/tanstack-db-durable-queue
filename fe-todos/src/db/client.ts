import { createCollection } from '@tanstack/db';
import type {
  Todo,
  CreateTodoInput,
  TodoAudit,
  ShoppingList,
} from './types';
import * as graphql from './graphql';
import { queryClient } from './queryClient';
import {
  clearCollectionCache,
  connectQuarantineReapplier,
  durableQueueCollectionOptions,
  mintTempId,
} from './durableQueueCollection';
import { persistence, mutationQueue } from './persistence';
import { consoleLogger } from './consoleLogger';
import { attachDrainTriggers } from './drainTriggers';
import { shoppingListsCollection } from './shoppingListClient';
import { budgetsCollection } from './budgetClient';

// Drain the queue when the browser comes back online (or window regains
// focus, in case the OS was suspended). The runner already pauses on
// `navigator.onLine === false`, so the `online` event is what nudges it
// awake.
attachDrainTriggers({ queue: mutationQueue });

const AUDITED_FIELDS = ['name', 'description', 'status'] as const;
type AuditedField = (typeof AUDITED_FIELDS)[number];

function diffTodo(original: Todo, modified: Todo): Partial<Record<AuditedField, { from: unknown; to: unknown }>> {
  const changes: Partial<Record<AuditedField, { from: unknown; to: unknown }>> = {};
  for (const field of AUDITED_FIELDS) {
    if (original[field] !== modified[field]) {
      changes[field] = { from: original[field], to: modified[field] };
    }
  }
  return changes;
}

export const todosCollection = createCollection(
  durableQueueCollectionOptions<Todo>({
    collectionId: 'todos',
    logger: consoleLogger,
    persistence,
    queue: mutationQueue,
    queryKey: ['todos'],
    queryFn: graphql.fetchTodos,
    queryClient,
    getKey: (todo) => todo.id,
    // Audit refetch is now driven by todoAuditsCollection's own ack path,
    // not piggy-backed on the parent todo op.
    invalidates: [],

    onInsert: async ({ transaction }) => {
      const inserted = transaction.mutations[0].modified as Todo;
      const created = await graphql.createTodo(
        {
          name: inserted.name,
          description: inserted.description,
          status: inserted.status,
        },
        (transaction as any).clientOpId,
      );
      return { serverId: created.id };
    },

    onUpdate: async ({ transaction }) => {
      const updated = transaction.mutations[0].modified as Todo;
      await graphql.updateTodo(
        {
          id: updated.id,
          name: updated.name,
          description: updated.description,
          status: updated.status,
        },
        (transaction as any).clientOpId,
      );
    },

    onDelete: async ({ transaction }) => {
      const key = transaction.mutations[0].key as string;
      await graphql.deleteTodo(key, (transaction as any).clientOpId);
    },
  })
);

// Box #10: wire the quarantine reapplier so failed ops keep their optimistic
// state visible. The UI can then surface them via `mutationQueue.quarantineList()`
// and offer retry / discard / discard-anchor-requeue-rest.
connectQuarantineReapplier({
  collection: todosCollection,
  queue: mutationQueue,
  collectionId: 'todos',
});

// Audit collection — wrapped with the same durable queue. Insertions go
// through the queue, so an offline-recorded audit waits in SQLite until the
// network returns. Reads go through the synced cache (server truth).
export const todoAuditsCollection = createCollection(
  durableQueueCollectionOptions<TodoAudit>({
    collectionId: 'todoAudits',
    logger: consoleLogger,
    persistence,
    queue: mutationQueue,
    queryKey: ['todoAudits'],
    queryFn: graphql.fetchAllTodoAudits,
    queryClient,
    getKey: (audit) => audit.id,

    onInsert: async ({ transaction }) => {
      const inserted = transaction.mutations[0].modified as TodoAudit;
      const created = await graphql.createTodoAudit(
        {
          todoId: inserted.todoId,
          action: inserted.action,
          changes: inserted.changes ?? undefined,
        },
        (transaction as any).clientOpId,
      );
      // Server mints the real id; bind so the temp row in our synced cache
      // flips to the canonical id without unmounting in the React tree.
      return { serverId: created.id };
    },
  })
);

// Audit rows are inserted at *intent time* — synchronously when the user
// mutates a todo — so the audit's own queue entry is durable even if the
// parent todo's server call never succeeds (e.g. offline). The audit then
// drains independently when the network returns.
function enqueueAudit(input: {
  todoId: string;
  action: 'added' | 'updated' | 'deleted';
  changes?: string;
}) {
  const optimistic: TodoAudit = {
    id: mintTempId(),
    todoId: input.todoId,
    action: input.action,
    changes: input.changes ?? null,
    createdAt: new Date().toISOString(),
  };
  todoAuditsCollection.insert(optimistic);
}

export async function addTodo(input: CreateTodoInput) {
  const optimisticTodo: Todo = {
    id: mintTempId(),
    ...input,
    description: input.description ?? '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  todosCollection.insert(optimisticTodo);
  // Audit gets a temp todoId at first; once the todo's server insert acks
  // and binds temp→server, the wrapper's `rewriteKeyForDispatch` updates
  // the audit op's key automatically before its own GraphQL POST runs.
  enqueueAudit({ todoId: optimisticTodo.id, action: 'added' });
  return optimisticTodo;
}

export function updateTodo(
  todoId: string,
  patch: (draft: Todo) => void,
) {
  // Snapshot the original *before* the optimistic update, so we can diff
  // for the audit's `changes` payload.
  const before = todosCollection.get(todoId);
  todosCollection.update(todoId, (draft) => {
    patch(draft as Todo);
  });
  const after = todosCollection.get(todoId);
  if (!before || !after) return;
  const changes = diffTodo(before as unknown as Todo, after as unknown as Todo);
  if (Object.keys(changes).length > 0) {
    enqueueAudit({
      todoId,
      action: 'updated',
      changes: JSON.stringify(changes),
    });
  }
}

export function deleteTodo(todoId: string) {
  // Cascade-delete the linked shopping list optimistically. The BFF cascades
  // server-side via Prisma's `onDelete: Cascade` relation, but we also drop
  // the local row so the panel disappears immediately rather than waiting
  // for the shoppingLists refetch.
  for (const list of shoppingListsCollection.values() as Iterable<ShoppingList>) {
    if (list.todoId === todoId) {
      shoppingListsCollection.delete(list.id);
      break;
    }
  }
  todosCollection.delete(todoId);
  enqueueAudit({ todoId, action: 'deleted' });
}

// Wipe every local cache + the durable mutation queue + quarantine + id
// bindings. Server data is untouched.
//
// Deliberately does NOT refetch afterwards: the caches stay empty until
// something else triggers a refetch (window focus, online event, the next
// mutation). The view ends up empty post-clear, which is what "clear local
// data" should look like. The data will repopulate on its own when one of
// those triggers fires — that's expected, since the server still has it.
//
// Sequence:
//   1. mutationQueue.clearLocalState() — rejects all pending awaitOpCompletion
//      deferreds, cancels the wake timer, clears queue/quarantine/binding
//      rows. Doing this first means a subsequent trigger isn't fighting an
//      in-flight drain.
//   2. clearCollectionCache(...) on each wrapped collection — wipes the synced
//      cache via the writeBatch + writeDelete utils. Bypasses onDelete so
//      we don't queue server deletes against rows we're trying to forget.
export async function clearAll() {
  await mutationQueue.clearLocalState();

  for (const c of [
    todosCollection,
    todoAuditsCollection,
    shoppingListsCollection,
    budgetsCollection,
  ]) {
    clearCollectionCache(c);
  }
}

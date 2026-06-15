// Intent helpers — exported async functions, not hooks. Component event
// handlers `await addTodo(...)` exactly like the fe-todos surface.

import { store } from './store';
import { runner } from '../queue/runner';
import { enqueueMutation } from '../queue/durableEndpoint';
import { mintTempId, isTempId } from '../queue/types';
import { patchTodos, patchAudits } from './cachePatches';
import { api } from '../api/api';
import { deleteShoppingList } from './shoppingIntents';
import type { CreateTodoInput, Todo, TodoAudit, TodoAuditAction } from '../api/types';

const AUDITED_FIELDS = ['name', 'description', 'status'] as const;
type AuditedField = (typeof AUDITED_FIELDS)[number];

function diffTodo(
  original: Todo,
  modified: Todo,
): Partial<Record<AuditedField, { from: unknown; to: unknown }>> {
  const out: Partial<Record<AuditedField, { from: unknown; to: unknown }>> = {};
  for (const field of AUDITED_FIELDS) {
    if (original[field] !== modified[field]) {
      out[field] = { from: original[field], to: modified[field] };
    }
  }
  return out;
}

// readTodos / readShoppingLists live in cacheReads.ts so the same flat-array
// helpers are shared across intents/runtime modules.
import { readTodos, readShoppingLists } from './cacheReads';

function enqueueAudit(input: { todoId: string; action: TodoAuditAction; changes?: string }): void {
  const optimistic: TodoAudit = {
    id: mintTempId(),
    todoId: input.todoId,
    action: input.action,
    changes: input.changes ?? null,
    createdAt: new Date().toISOString(),
  };
  enqueueMutation(
    store,
    'todoAudits',
    'insert',
    optimistic.id,
    { modified: optimistic },
    {
      optimistic: [
        {
          apply: () =>
            patchAudits((draft) => {
              draft.unshift(optimistic);
            }),
        },
      ],
    },
  );
}

export async function addTodo(input: CreateTodoInput): Promise<void> {
  const tempId = mintTempId();
  const optimistic: Todo = {
    id: tempId,
    name: input.name,
    description: input.description ?? '',
    status: input.status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const { completion } = enqueueMutation(
    store,
    'todos',
    'insert',
    tempId,
    { modified: optimistic },
    {
      optimistic: [
        {
          apply: () =>
            patchTodos((draft) => {
              draft.unshift(optimistic);
            }),
        },
      ],
    },
  );
  enqueueAudit({ todoId: tempId, action: 'added' });
  // Await so the form-clear / error paths in the component work as before.
  // Quarantined ops never settle — the await sits open, which matches
  // fe-todos behavior exactly. Components already swallow rejections.
  try {
    await completion;
  } catch (err) {
    // Swallowed; quarantine UI surfaces the failure.
    console.warn('[intents] addTodo settled with error:', err);
  }
}

export function updateTodo(todoId: string, patch: (draft: Todo) => void): void {
  const before = readTodos().find((t) => t.id === todoId);
  if (!before) return;
  const after: Todo = JSON.parse(JSON.stringify(before));
  patch(after);
  if (
    AUDITED_FIELDS.every((f) => before[f] === after[f]) &&
    before.name === after.name &&
    before.description === after.description &&
    before.status === after.status
  ) {
    return;
  }
  enqueueMutation(
    store,
    'todos',
    'update',
    todoId,
    { original: before, modified: after },
    {
      optimistic: [
        {
          apply: () =>
            patchTodos((draft) => {
              const idx = draft.findIndex((t) => t.id === todoId);
              if (idx >= 0) draft[idx] = after;
            }),
        },
      ],
    },
  );
  const changes = diffTodo(before, after);
  if (Object.keys(changes).length > 0) {
    enqueueAudit({ todoId, action: 'updated', changes: JSON.stringify(changes) });
  }
}

export function deleteTodo(todoId: string): void {
  const before = readTodos().find((t) => t.id === todoId);
  if (!before) return;
  // Cascade-delete linked shopping list optimistically. The BFF's Prisma
  // schema does the same via `onDelete: Cascade`; doing it locally too means
  // the panel disappears immediately rather than waiting for a refetch.
  const linkedList = readShoppingLists().find((l) => l.todoId === todoId);
  if (linkedList) deleteShoppingList(linkedList.id);
  enqueueMutation(
    store,
    'todos',
    'delete',
    todoId,
    { original: before },
    {
      optimistic: [
        {
          apply: () =>
            patchTodos((draft) => {
              const idx = draft.findIndex((t) => t.id === todoId);
              if (idx >= 0) draft.splice(idx, 1);
            }),
        },
      ],
    },
  );
  enqueueAudit({ todoId, action: 'deleted' });
}

export async function clearAll(): Promise<void> {
  runner.clearLocalState();
  // Reset RTK Query caches too so the UI matches the wiped queue. RTKQ's
  // `resetApiState` does this. Server data is untouched — the next mount,
  // focus, or online event refetches.
  store.dispatch(api.util.resetApiState());
}

// Exposed so components don't import `isTempId` from the queue dir.
export { isTempId };

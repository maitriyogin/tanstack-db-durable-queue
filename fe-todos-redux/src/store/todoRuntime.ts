import { runner, type CollectionRuntime } from '../queue/runner';
import { api } from '../api/api';
import { store } from './store';
import { patchTodos, patchAudits } from './cachePatches';
import type { QueueOpRow } from '../queue/types';
import type { Todo, TodoAudit } from '../api/types';

const todosRuntime: CollectionRuntime = {
  async dispatch(op: QueueOpRow) {
    if (op.type === 'insert') {
      const inserted = (op.payload.modified as Todo) ?? null;
      if (!inserted) throw new Error('insert op has no modified payload');
      const created = await store
        .dispatch(
          api.endpoints.createTodo.initiate({
            input: {
              name: inserted.name,
              description: inserted.description,
              status: inserted.status,
            },
            clientOpId: op.id,
          }),
        )
        .unwrap();
      // Mutation responses come wrapped (`{ createTodo: Todo }`); unwrap.
      return { serverId: created.createTodo.id };
    }
    if (op.type === 'update') {
      const updated = (op.payload.modified as Todo) ?? null;
      if (!updated) throw new Error('update op has no modified payload');
      await store
        .dispatch(
          api.endpoints.updateTodo.initiate({
            input: {
              id: op.key,
              name: updated.name,
              description: updated.description,
              status: updated.status,
            },
            clientOpId: op.id,
          }),
        )
        .unwrap();
      return;
    }
    if (op.type === 'delete') {
      await store
        .dispatch(
          api.endpoints.deleteTodo.initiate({ id: op.key, clientOpId: op.id }),
        )
        .unwrap();
      return;
    }
  },
  isRetrySafe: (op) => op.type === 'update',
  invalidates: () => [{ type: 'Todos', id: 'LIST' }],
  rehydrateOptimistic: (op) => {
    // After a reload, re-apply the optimistic state for any still-pending op
    // so the UI looks the same as it did before the crash.
    if (op.type === 'insert') {
      const todo = op.payload.modified as Todo | undefined;
      if (todo) patchTodos((draft) => {
        if (!draft.find((t) => t.id === todo.id)) draft.unshift(todo);
      });
    } else if (op.type === 'update') {
      const updated = op.payload.modified as Todo | undefined;
      if (updated) patchTodos((draft) => {
        const idx = draft.findIndex((t) => t.id === op.key);
        if (idx >= 0) draft[idx] = updated;
      });
    } else if (op.type === 'delete') {
      patchTodos((draft) => {
        const idx = draft.findIndex((t) => t.id === op.key);
        if (idx >= 0) draft.splice(idx, 1);
      });
    }
  },
};

const todoAuditsRuntime: CollectionRuntime = {
  async dispatch(op: QueueOpRow) {
    if (op.type !== 'insert') {
      // Audits are insert-only — nothing else to do.
      return;
    }
    const inserted = (op.payload.modified as TodoAudit) ?? null;
    if (!inserted) throw new Error('audit insert op has no modified payload');
    // The temp todoId rides the audit until its own todo binds; the runner's
    // rewriteKeyForDispatch only swaps op.key, not nested payload fields, so
    // we look up the bound id ourselves at dispatch time.
    const todoId = runner.resolveServerId('todos', inserted.todoId);
    const created = await store
      .dispatch(
        api.endpoints.createTodoAudit.initiate({
          input: {
            todoId,
            action: inserted.action,
            changes: inserted.changes ?? undefined,
          },
          clientOpId: op.id,
        }),
      )
      .unwrap();
    return { serverId: created.createTodoAudit.id };
  },
  isRetrySafe: () => true, // audits tolerate retry — server dedups on clientOpId
  invalidates: () => [{ type: 'TodoAudits', id: 'LIST' }],
  rehydrateOptimistic: (op) => {
    if (op.type !== 'insert') return;
    const audit = op.payload.modified as TodoAudit | undefined;
    if (!audit) return;
    patchAudits((draft) => {
      if (!draft.find((a) => a.id === audit.id)) draft.unshift(audit);
    });
  },
};

runner.registerCollection('todos', todosRuntime);
runner.registerCollection('todoAudits', todoAuditsRuntime);

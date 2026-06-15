import { api } from '../api/api';
import { store } from './store';
import type { Todo, TodoAudit, ShoppingList, Budget } from '../api/api';

// Helpers that wrap RTK Query's updateQueryData against each cached query.
// Returned `{ undo }` lets the runner roll back optimistic state on quarantine
// discard. Centralised here to avoid circular imports between the per-domain
// runtime modules and the per-domain intent modules.
//
// The cache stores raw operation responses (`{ todos: Todo[] }`,
// `{ allTodoAudits: TodoAudit[] }`, …) because the codegen plugin emits
// strict result types that the enhanceEndpoints API can't re-shape. We
// mutate the wrapper field here and present a flat array via the read
// helpers in `cacheReads.ts`.

export function patchTodos(recipe: (draft: Todo[]) => void): { undo: () => void } {
  const r = store.dispatch(
    api.util.updateQueryData('getTodos', undefined, (draft) => {
      recipe(draft.todos);
    }),
  );
  return { undo: () => r.undo() };
}

export function patchAudits(recipe: (draft: TodoAudit[]) => void): { undo: () => void } {
  const r = store.dispatch(
    api.util.updateQueryData('getTodoAudits', undefined, (draft) => {
      recipe(draft.allTodoAudits);
    }),
  );
  return { undo: () => r.undo() };
}

export function patchShoppingLists(
  recipe: (draft: ShoppingList[]) => void,
): { undo: () => void } {
  const r = store.dispatch(
    api.util.updateQueryData('getShoppingLists', undefined, (draft) => {
      recipe(draft.shoppingLists);
    }),
  );
  return { undo: () => r.undo() };
}

export function patchBudgets(recipe: (draft: Budget[]) => void): { undo: () => void } {
  const r = store.dispatch(
    api.util.updateQueryData('getBudgets', undefined, (draft) => {
      recipe(draft.budgets);
    }),
  );
  return { undo: () => r.undo() };
}

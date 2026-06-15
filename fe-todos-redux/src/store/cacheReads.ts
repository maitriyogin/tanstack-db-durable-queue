// Flat-array readers over the wrapped operation responses sitting in
// RTK Query's cache. Used by intents/components when they need to peek
// at the cache outside of a useSelector call.
import { api } from '../api/api';
import { store } from './store';
import type { Todo, TodoAudit, ShoppingList, Budget } from '../api/api';

export function readTodos(): Todo[] {
  return api.endpoints.getTodos.select()(store.getState() as any).data?.todos ?? [];
}

export function readTodoAudits(): TodoAudit[] {
  return (
    api.endpoints.getTodoAudits.select()(store.getState() as any).data?.allTodoAudits ??
    []
  );
}

export function readShoppingLists(): ShoppingList[] {
  return (
    api.endpoints.getShoppingLists.select()(store.getState() as any).data?.shoppingLists ??
    []
  );
}

export function readBudgets(): Budget[] {
  return api.endpoints.getBudgets.select()(store.getState() as any).data?.budgets ?? [];
}

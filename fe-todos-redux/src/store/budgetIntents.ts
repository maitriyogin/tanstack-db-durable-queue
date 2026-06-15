import { store } from './store';
import { api } from '../api/api';
import { enqueueMutation } from '../queue/durableEndpoint';
import { mintTempId } from '../queue/types';
import { patchBudgets } from './cachePatches';
import type { Budget } from '../api/types';

import { readBudgets } from './cacheReads';

export function findBudgetForShoppingList(
  shoppingListId: string,
): Budget | undefined {
  return readBudgets().find((b) => b.shoppingListId === shoppingListId);
}

// Insert a fresh budget for a newly-created list. Queues separately from
// the list create; runner resolves temp shoppingListId at dispatch time.
export function addBudgetForShoppingList(
  shoppingListId: string,
  total: number,
): void {
  const now = new Date().toISOString();
  const optimistic: Budget = {
    id: mintTempId(),
    total,
    remaining: total,
    shoppingListId,
    createdAt: now,
    updatedAt: now,
  };
  enqueueMutation(
    store,
    'budgets',
    'insert',
    optimistic.id,
    { modified: optimistic },
    {
      optimistic: [
        {
          apply: () =>
            patchBudgets((draft) => {
              draft.unshift(optimistic);
            }),
        },
      ],
    },
  );
}

// Spend `delta` out of this list's budget. Implemented as a normal
// queued update so it survives offline.
export function decrementBudgetForShoppingList(
  shoppingListId: string,
  delta: number,
): void {
  const before = findBudgetForShoppingList(shoppingListId);
  if (!before) return;
  const after: Budget = { ...before, remaining: before.remaining - delta };
  enqueueMutation(
    store,
    'budgets',
    'update',
    before.id,
    { original: before, modified: after },
    {
      optimistic: [
        {
          apply: () =>
            patchBudgets((draft) => {
              const idx = draft.findIndex((b) => b.id === before.id);
              if (idx >= 0) draft[idx] = after;
            }),
        },
      ],
    },
  );
}

export function incrementBudgetForShoppingList(
  shoppingListId: string,
  delta: number,
): void {
  decrementBudgetForShoppingList(shoppingListId, -delta);
}

// Net adjust: positive → spend, negative → refund. Used by the list's
// projection on item add/remove.
export function adjustBudgetForShoppingList(
  shoppingListId: string,
  netDelta: number,
): void {
  if (netDelta === 0) return;
  decrementBudgetForShoppingList(shoppingListId, netDelta);
}
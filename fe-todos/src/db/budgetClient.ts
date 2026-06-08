import { createCollection } from '@tanstack/db';
import type { Budget } from './types';
import * as graphql from './graphql';
import { queryClient } from './queryClient';
import {
  connectQuarantineReapplier,
  durableQueueCollectionOptions,
  mintTempId,
} from './durableQueueCollection';
import { persistence, mutationQueue } from './persistence';
import { consoleLogger } from './consoleLogger';

// Sentinel field stashed on update payloads so the wrapper's onUpdate can
// distinguish "decrement by N" intent from any other future field changes.
// We only ever update the `remaining` field through the queue, but the queue
// passes both `original` and `modified` so the handler computes `delta`.
//
// One Budget row per ShoppingList. Created via `createBudget` (FE-driven on
// list create), updated only via the projection's `decrement(listId, delta)`.

export const budgetsCollection = createCollection(
  durableQueueCollectionOptions<Budget>({
    collectionId: 'budgets',
    logger: consoleLogger,
    persistence,
    queue: mutationQueue,
    queryKey: ['budgets'],
    queryFn: graphql.fetchBudgets,
    queryClient,
    getKey: (b) => b.id,

    onInsert: async ({ transaction }) => {
      const inserted = transaction.mutations[0].modified as Budget;
      // Resolve the temp shopping-list id to its server id at dispatch time
      // so the budget row links to the right list. The shopping list's
      // own onInsert binds the list temp→server before this op drains; the
      // queue runner's `rewriteKeyForDispatch` doesn't help here because
      // `shoppingListId` is a *payload* field, not the row key. Look it up
      // in the binding map manually.
      const resolvedListId = mutationQueue.resolveServerId(
        'shoppingLists',
        inserted.shoppingListId,
      );
      const created = await graphql.createBudget(
        {
          shoppingListId: resolvedListId,
          total: inserted.total,
        },
        (transaction as any).clientOpId,
      );
      return { serverId: created.id };
    },

    onUpdate: async ({ transaction }) => {
      const original = transaction.mutations[0].original as Budget;
      const modified = transaction.mutations[0].modified as Budget;
      // delta > 0  → spend (decrement)
      // delta < 0  → refund (increment), e.g. user removed an item
      const delta = original.remaining - modified.remaining;
      if (delta === 0) return;
      // Resolve the budget's shoppingListId to its bound server id (in case
      // the budget update queued before the list create acked).
      const resolvedListId = mutationQueue.resolveServerId(
        'shoppingLists',
        modified.shoppingListId,
      );
      if (delta > 0) {
        await graphql.decrementBudget(resolvedListId, delta, (transaction as any).clientOpId);
      } else {
        await graphql.incrementBudget(resolvedListId, -delta, (transaction as any).clientOpId);
      }
    },
  })
);

// Write-through-bind for the budget row, mirroring the shopping-list wrapper.
// If a budget's temp id has a queued decrement/increment when the create's
// bind lands, project it into the synced cache under the server id so the
// post-create refetch doesn't briefly show the un-decremented value.
connectQuarantineReapplier({
  collection: budgetsCollection,
  queue: mutationQueue,
  collectionId: 'budgets',
});

export function findBudgetForShoppingList(
  shoppingListId: string,
): Budget | undefined {
  for (const b of budgetsCollection.values() as Iterable<Budget>) {
    if (b.shoppingListId === shoppingListId) return b;
  }
  return undefined;
}

// Insert a fresh budget for a newly-created list. Called by addShoppingList
// right after the optimistic list insert. The budget op queues separately
// and drains once the list's create has bound its temp→server id.
export function addBudgetForShoppingList(
  shoppingListId: string,
  total: number,
) {
  const now = new Date().toISOString();
  const optimistic: Budget = {
    id: mintTempId(),
    total,
    remaining: total,
    shoppingListId,
    createdAt: now,
    updatedAt: now,
  };
  budgetsCollection.insert(optimistic);
  return optimistic;
}

// The user-facing intent: "spend $delta out of this list's budget."
// Implemented as a normal collection.update so it flows through the
// durable queue exactly like any other op (offline-survivable, retryable,
// quarantine-able). Called by the projection on shopping-list updates
// when items are added.
export function decrementBudgetForShoppingList(
  shoppingListId: string,
  delta: number,
) {
  const b = findBudgetForShoppingList(shoppingListId);
  if (!b) return;
  budgetsCollection.update(b.id, (draft) => {
    draft.remaining -= delta;
  });
}

// Inverse: refund $delta to this list's budget when an item is removed.
export function incrementBudgetForShoppingList(
  shoppingListId: string,
  delta: number,
) {
  const b = findBudgetForShoppingList(shoppingListId);
  if (!b) return;
  budgetsCollection.update(b.id, (draftRaw) => {
    const draft = draftRaw as Budget;
    draft.remaining += delta;
  });
}

// Net helper for the projection: positive netDelta = spend; negative = refund.
export function adjustBudgetForShoppingList(
  shoppingListId: string,
  netDelta: number,
) {
  if (netDelta > 0) decrementBudgetForShoppingList(shoppingListId, netDelta);
  else if (netDelta < 0) incrementBudgetForShoppingList(shoppingListId, -netDelta);
}
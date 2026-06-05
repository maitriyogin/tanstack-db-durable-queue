import { createCollection } from '@tanstack/db';
import type {
  ShoppingList,
  ShoppingListItem,
  CreateShoppingListInput,
  CreateShoppingListItemInput,
  UpdateShoppingListItemInput,
} from './types';
import * as graphql from './graphql';
import { queryClient } from './queryClient';
import {
  connectQuarantineReapplier,
  durableQueueCollectionOptions,
  mintTempId,
} from './durableQueueCollection';
import { persistence, mutationQueue } from './persistence';
import { consoleLogger } from './consoleLogger';
import {
  addBudgetForShoppingList,
  adjustBudgetForShoppingList,
} from './budgetClient';

// Each row in this collection is a full shopping list *document* with its
// nested items inline. Wrapped via durableQueueCollectionOptions so list +
// item mutations queue durably offline. Item costs are random whole units
// 10–15 generated in the FE helpers; the budget decrement happens via a
// projection on the *update* path only (item-add).

const ITEM_PERSISTED_FIELDS = ['name', 'quantity', 'unit', 'notes', 'cost'] as const;
type ItemPersistedField = (typeof ITEM_PERSISTED_FIELDS)[number];

function diffItemFields(
  original: ShoppingListItem,
  modified: ShoppingListItem,
): Partial<Pick<ShoppingListItem, ItemPersistedField>> {
  const changes: Partial<Pick<ShoppingListItem, ItemPersistedField>> = {};
  for (const field of ITEM_PERSISTED_FIELDS) {
    if (original[field] !== modified[field]) {
      (changes as any)[field] = modified[field];
    }
  }
  return changes;
}

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function syncItems(
  resolvedListId: string,
  original: ShoppingList,
  modified: ShoppingList,
) {
  const originalById = new Map(original.items.map((item) => [item.id, item]));
  const modifiedById = new Map(modified.items.map((item) => [item.id, item]));

  const added = modified.items.filter((item) => !originalById.has(item.id));
  const removed = original.items.filter((item) => !modifiedById.has(item.id));
  const updated = modified.items.filter((item) => {
    const originalItem = originalById.get(item.id);
    if (!originalItem) return false;
    return Object.keys(diffItemFields(originalItem, item)).length > 0;
  });

  // Resolve each item id through the binding map. Nested items have temp
  // ids minted client-side; the previous time they were added in this
  // session their server id was captured and bound (see below). For items
  // added in the *current* batch the temp id is what the server hasn't
  // seen yet, so we leave it for the addShoppingListItem call.
  const resolveItemId = (itemId: string) =>
    mutationQueue.resolveServerId('shoppingListItems', itemId);

  // Adds run first so their temp→server bindings exist before any remove
  // or update in the same batch translates an item id. Without this an
  // add-then-remove of the same item *within one batch* would race —
  // remove would resolve the temp id before the bind landed and silently
  // no-op against a server id that doesn't exist yet.
  await Promise.all(
    added.map(async (item) => {
      const created = await graphql.addShoppingListItem({
        shoppingListId: resolvedListId,
        name: item.name,
        quantity: item.quantity,
        unit: item.unit ?? undefined,
        notes: item.notes ?? undefined,
        cost: item.cost ?? 0,
      });
      // Bind temp item id → server id so subsequent queued ops (or any
      // remove/update in this same batch) target the right row.
      if (created?.id && created.id !== item.id) {
        await mutationQueue.bindServerId(
          'shoppingListItems',
          item.id,
          created.id,
        );
      }
    }),
  );

  await Promise.all([
    ...removed.map((item) =>
      graphql.removeShoppingListItem(resolveItemId(item.id)),
    ),
    ...updated.map((item) => {
      const originalItem = originalById.get(item.id)!;
      const changes = diffItemFields(originalItem, item);
      const input: UpdateShoppingListItemInput = {
        id: resolveItemId(item.id),
        ...Object.fromEntries(
          Object.entries(changes).map(([key, value]) => [key, value ?? undefined]),
        ),
      };
      return graphql.updateShoppingListItem(input);
    }),
  ]);
}

// Net cost change between two snapshots:
//   positive → items added (spend)
//   negative → items removed (refund)
function netItemCostDelta(
  original: ShoppingList,
  modified: ShoppingList,
): number {
  const originalById = new Map(original.items.map((i) => [i.id, i]));
  const modifiedIds = new Set(modified.items.map((i) => i.id));
  const added = modified.items
    .filter((item) => !originalById.has(item.id))
    .reduce((sum, item) => sum + (item.cost ?? 0), 0);
  const removed = original.items
    .filter((item) => !modifiedIds.has(item.id))
    .reduce((sum, item) => sum + (item.cost ?? 0), 0);
  return added - removed;
}

export const shoppingListsCollection = createCollection(
  durableQueueCollectionOptions<ShoppingList>({
    collectionId: 'shoppingLists',
    logger: consoleLogger,
    persistence,
    queue: mutationQueue,
    queryKey: ['shoppingLists'],
    queryFn: graphql.fetchShoppingLists,
    queryClient,
    getKey: (list) => list.id,
    // After any list mutation acks, force a budgets refetch too. Belt-and-
    // suspenders for the offline cascade-delete path: when an optimistic
    // delete is keyed under a temp id but the synced cache lands the row
    // under the bound server id (after the create acks first), the
    // auto-rollback can leave a stale row visible until the next refetch.
    invalidates: [['budgets'], ['shoppingLists']],

    onInsert: async ({ transaction }) => {
      const inserted = transaction.mutations[0].modified as ShoppingList;
      const created = await graphql.createShoppingList({
        name: inserted.name,
        description: inserted.description ?? undefined,
        todoId: inserted.todoId ?? undefined,
        items: inserted.items.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          unit: item.unit ?? undefined,
          notes: item.notes ?? undefined,
          cost: item.cost ?? 0,
        })),
      });
      return { serverId: created.id };
    },

    onUpdate: async ({ transaction }) => {
      const original = transaction.mutations[0].original as ShoppingList;
      const modified = transaction.mutations[0].modified as ShoppingList;
      const resolvedListId = String(transaction.mutations[0].key);
      await syncItems(resolvedListId, original, modified);
    },

    onDelete: async ({ transaction }) => {
      const key = String(transaction.mutations[0].key);
      await graphql.deleteShoppingList(key);
    },

    // Projection: when items are added or removed from an existing list,
    // adjust the linked budget. Net delta:
    //   + → spend (items added) → decrement budget
    //   − → refund (items removed) → increment budget
    // The adjust goes through the budgets collection's own queue, so it
    // survives offline exactly the same way the parent list update does.
    //
    // Deliberately not on insert — the FE queues a separate budget insert
    // right after the list insert (see addShoppingList below). Initial
    // items in the create payload don't trigger a deduction (no budget
    // exists yet).
    projections: {
      budgetAdjust: {
        optimistic: (op) => {
          if (op.type !== 'update') return;
          const original = op.payload.original as ShoppingList | undefined;
          const modified = op.payload.modified as ShoppingList | undefined;
          if (!original || !modified) return;
          const delta = netItemCostDelta(original, modified);
          if (delta === 0) return;
          // Look up the local budget row by the list's temp id (which the
          // in-memory binding map resolves) and queue an update on it.
          adjustBudgetForShoppingList(modified.id, delta);
          // No rollback thunk needed: the budget update is its own queued
          // op, with its own retry/quarantine lifecycle.
          return undefined;
        },
        apply: async () => {},
        onError: 'tolerate',
      },
    },
  })
);

// Wire write-through-bind: when a list temp id binds to its server id, any
// queued delete/update for that list gets projected into the synced cache
// under the server id, masking the row before queryCollection's auto-refetch
// can re-introduce it. Without this an offline create + delete pair would
// briefly show the list on reconnect.
connectQuarantineReapplier({
  collection: shoppingListsCollection,
  queue: mutationQueue,
  collectionId: 'shoppingLists',
});

export async function addShoppingList(input: CreateShoppingListInput) {
  const now = new Date().toISOString();
  const listId = mintTempId();
  const budgetTotal = input.budgetTotal ?? randInt(70, 100);

  const optimistic: ShoppingList = {
    id: listId,
    name: input.name,
    description: input.description ?? null,
    todoId: input.todoId ?? null,
    items: input.items.map((item) => ({
      id: mintTempId(),
      name: item.name,
      quantity: item.quantity,
      unit: item.unit ?? null,
      notes: item.notes ?? null,
      cost: item.cost ?? randInt(10, 15),
      shoppingListId: listId,
      createdAt: now,
      updatedAt: now,
    })),
    createdAt: now,
    updatedAt: now,
  };

  shoppingListsCollection.insert(optimistic);
  // Queue the budget create as a separate op. It references the list's
  // temp id; the queue runner resolves temp→server before dispatching
  // (see budgetClient's onInsert).
  addBudgetForShoppingList(listId, budgetTotal);
  return optimistic;
}

export async function addShoppingListForTodo(
  todoId: string,
  input: Omit<CreateShoppingListInput, 'todoId'>,
) {
  return addShoppingList({ ...input, todoId });
}

export function addItemToShoppingList(
  listId: string,
  item: CreateShoppingListItemInput,
) {
  const now = new Date().toISOString();
  shoppingListsCollection.update(listId, (draftRaw) => {
    const draft = draftRaw as ShoppingList;
    draft.items.push({
      id: mintTempId(),
      name: item.name,
      quantity: item.quantity,
      unit: item.unit ?? null,
      notes: item.notes ?? null,
      cost: item.cost ?? randInt(10, 15),
      shoppingListId: listId,
      createdAt: now,
      updatedAt: now,
    });
    draft.updatedAt = now;
  });
}

export function updateShoppingListItem(
  listId: string,
  itemId: string,
  patch: Partial<Pick<ShoppingListItem, 'name' | 'quantity' | 'unit' | 'notes'>>,
) {
  const now = new Date().toISOString();
  shoppingListsCollection.update(listId, (draftRaw) => {
    const draft = draftRaw as ShoppingList;
    const item = draft.items.find((i: ShoppingListItem) => i.id === itemId);
    if (!item) return;
    if (patch.name !== undefined) item.name = patch.name;
    if (patch.quantity !== undefined) item.quantity = patch.quantity;
    if (patch.unit !== undefined) item.unit = patch.unit;
    if (patch.notes !== undefined) item.notes = patch.notes;
    item.updatedAt = now;
    draft.updatedAt = now;
  });
}

export function removeItemFromShoppingList(listId: string, itemId: string) {
  const now = new Date().toISOString();
  shoppingListsCollection.update(listId, (draftRaw) => {
    const draft = draftRaw as ShoppingList;
    draft.items = draft.items.filter((item: ShoppingListItem) => item.id !== itemId);
    draft.updatedAt = now;
  });
}

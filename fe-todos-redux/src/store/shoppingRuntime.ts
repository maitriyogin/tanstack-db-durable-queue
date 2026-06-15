import { runner, type CollectionRuntime } from '../queue/runner';
import { api } from '../api/api';
import { store } from './store';
import { mintTempId } from '../queue/types';
import { patchShoppingLists, patchBudgets } from './cachePatches';
import { adjustBudgetForShoppingList } from './budgetIntents';
import type { QueueOpRow } from '../queue/types';
import type {
  ShoppingList,
  ShoppingListItem,
  Budget,
  UpdateShoppingListItemInput,
} from '../api/types';

// Diff helper: which item-level fields changed between two snapshots.
const ITEM_FIELDS = ['name', 'quantity', 'unit', 'notes', 'cost'] as const;
type ItemField = (typeof ITEM_FIELDS)[number];

function diffItemFields(
  original: ShoppingListItem,
  modified: ShoppingListItem,
): Partial<Pick<ShoppingListItem, ItemField>> {
  const out: Partial<Pick<ShoppingListItem, ItemField>> = {};
  for (const field of ITEM_FIELDS) {
    if (original[field] !== modified[field]) {
      (out as any)[field] = modified[field];
    }
  }
  return out;
}

// Net cost change: positive → spend, negative → refund.
export function netItemCostDelta(
  original: ShoppingList,
  modified: ShoppingList,
): number {
  const originalById = new Map(original.items.map((i) => [i.id, i]));
  const modifiedIds = new Set(modified.items.map((i) => i.id));
  const added = modified.items
    .filter((it) => !originalById.has(it.id))
    .reduce((s, it) => s + (it.cost ?? 0), 0);
  const removed = original.items
    .filter((it) => !modifiedIds.has(it.id))
    .reduce((s, it) => s + (it.cost ?? 0), 0);
  return added - removed;
}

// One parent shopping-list update fans out into N HTTP calls. Each needs its
// own client op id so the BFF caches them independently while staying
// deterministic across retries.
async function syncItems(
  resolvedListId: string,
  original: ShoppingList,
  modified: ShoppingList,
  parentOpId: string,
): Promise<void> {
  const originalById = new Map(original.items.map((it) => [it.id, it]));
  const modifiedById = new Map(modified.items.map((it) => [it.id, it]));

  const added = modified.items.filter((it) => !originalById.has(it.id));
  const removed = original.items.filter((it) => !modifiedById.has(it.id));
  const updated = modified.items.filter((it) => {
    const orig = originalById.get(it.id);
    if (!orig) return false;
    return Object.keys(diffItemFields(orig, it)).length > 0;
  });

  const resolveItemId = (id: string) =>
    runner.resolveServerId('shoppingListItems', id);
  const subOpId = (kind: string, itemId: string) => `${parentOpId}:${kind}:${itemId}`;

  // Adds first so their temp→server bindings exist before any same-batch
  // remove/update translates an item id.
  await Promise.all(
    added.map(async (it) => {
      const created = await store
        .dispatch(
          api.endpoints.addShoppingListItem.initiate({
            input: {
              shoppingListId: resolvedListId,
              name: it.name,
              quantity: it.quantity,
              unit: it.unit ?? undefined,
              notes: it.notes ?? undefined,
              cost: it.cost ?? 0,
            },
            clientOpId: subOpId('add', it.id),
          }),
        )
        .unwrap();
      const srvItem = created?.addShoppingListItem;
      if (srvItem?.id && srvItem.id !== it.id) {
        runner.bindServerId('shoppingListItems', it.id, srvItem.id);
      }
    }),
  );

  await Promise.all([
    ...removed.map((it) =>
      store
        .dispatch(
          api.endpoints.removeShoppingListItem.initiate({
            id: resolveItemId(it.id),
            clientOpId: subOpId('remove', it.id),
          }),
        )
        .unwrap(),
    ),
    ...updated.map((it) => {
      const orig = originalById.get(it.id)!;
      const changes = diffItemFields(orig, it);
      const input: UpdateShoppingListItemInput = {
        id: resolveItemId(it.id),
        ...Object.fromEntries(
          Object.entries(changes).map(([k, v]) => [k, v ?? undefined]),
        ),
      };
      return store
        .dispatch(
          api.endpoints.updateShoppingListItem.initiate({
            input,
            clientOpId: subOpId('update', it.id),
          }),
        )
        .unwrap();
    }),
  ]);
}

// ---- Runtimes ----

const shoppingListsRuntime: CollectionRuntime = {
  async dispatch(op: QueueOpRow) {
    if (op.type === 'insert') {
      const inserted = op.payload.modified as ShoppingList;
      const created = await store
        .dispatch(
          api.endpoints.createShoppingList.initiate({
            input: {
              name: inserted.name,
              description: inserted.description ?? undefined,
              todoId: inserted.todoId ?? undefined,
              items: inserted.items.map((it) => ({
                name: it.name,
                quantity: it.quantity,
                unit: it.unit ?? undefined,
                notes: it.notes ?? undefined,
                cost: it.cost ?? 0,
              })),
            },
            clientOpId: op.id,
          }),
        )
        .unwrap();
      // Server returns the list with server-side item ids. Bind each so
      // post-create item operations target the right rows.
      const srvList = created.createShoppingList;
      for (const [i, srvItem] of srvList.items.entries()) {
        const localItem = inserted.items[i];
        if (localItem && srvItem.id !== localItem.id) {
          runner.bindServerId('shoppingListItems', localItem.id, srvItem.id);
        }
      }
      return { serverId: srvList.id };
    }
    if (op.type === 'update') {
      const original = op.payload.original as ShoppingList;
      const modified = op.payload.modified as ShoppingList;
      await syncItems(op.key, original, modified, op.id);
      return;
    }
    if (op.type === 'delete') {
      await store
        .dispatch(
          api.endpoints.deleteShoppingList.initiate({
            id: op.key,
            clientOpId: op.id,
          }),
        )
        .unwrap();
      return;
    }
  },
  isRetrySafe: (op) => op.type === 'update',
  invalidates: () => [
    { type: 'ShoppingLists', id: 'LIST' },
    { type: 'Budgets', id: 'LIST' },
  ],
  // Item-add/remove triggers a budget adjustment on the linked budget row.
  // Done as a *projection* so the budget adjustment is its own queued op
  // (offline-survivable, retry/quarantine independent of the parent list).
  projections: {
    budgetAdjust: {
      optimistic: (op) => {
        if (op.type !== 'update') return () => {};
        const original = op.payload.original as ShoppingList | undefined;
        const modified = op.payload.modified as ShoppingList | undefined;
        if (!original || !modified) return () => {};
        const delta = netItemCostDelta(original, modified);
        if (delta === 0) return () => {};
        // Use the FE intent helper so the budget update flows through the
        // durable queue, with its own ack/retry/quarantine lifecycle.
        adjustBudgetForShoppingList(modified.id, delta);
        return () => {}; // budget op has its own rollback path
      },
      apply: async () => {},
      onError: 'tolerate',
    },
  },
  rehydrateOptimistic: (op) => {
    if (op.type === 'insert') {
      const list = op.payload.modified as ShoppingList | undefined;
      if (list)
        patchShoppingLists((draft) => {
          if (!draft.find((l) => l.id === list.id)) draft.unshift(list);
        });
    } else if (op.type === 'update') {
      const updated = op.payload.modified as ShoppingList | undefined;
      if (updated)
        patchShoppingLists((draft) => {
          const idx = draft.findIndex((l) => l.id === op.key);
          if (idx >= 0) draft[idx] = updated;
        });
    } else if (op.type === 'delete') {
      patchShoppingLists((draft) => {
        const idx = draft.findIndex((l) => l.id === op.key);
        if (idx >= 0) draft.splice(idx, 1);
      });
    }
  },
};

const budgetsRuntime: CollectionRuntime = {
  async dispatch(op: QueueOpRow) {
    if (op.type === 'insert') {
      const inserted = op.payload.modified as Budget;
      // shoppingListId is a payload field, not the row key, so the runner's
      // automatic rewriteKeyForDispatch doesn't help. Resolve manually.
      const resolvedListId = runner.resolveServerId(
        'shoppingLists',
        inserted.shoppingListId,
      );
      const created = await store
        .dispatch(
          api.endpoints.createBudget.initiate({
            input: { shoppingListId: resolvedListId, total: inserted.total },
            clientOpId: op.id,
          }),
        )
        .unwrap();
      return { serverId: created.createBudget.id };
    }
    if (op.type === 'update') {
      const original = op.payload.original as Budget;
      const modified = op.payload.modified as Budget;
      const delta = original.remaining - modified.remaining;
      if (delta === 0) return;
      const resolvedListId = runner.resolveServerId(
        'shoppingLists',
        modified.shoppingListId,
      );
      if (delta > 0) {
        await store
          .dispatch(
            api.endpoints.decrementBudget.initiate({
              shoppingListId: resolvedListId,
              amount: delta,
              clientOpId: op.id,
            }),
          )
          .unwrap();
      } else {
        await store
          .dispatch(
            api.endpoints.incrementBudget.initiate({
              shoppingListId: resolvedListId,
              amount: -delta,
              clientOpId: op.id,
            }),
          )
          .unwrap();
      }
      return;
    }
    // Budgets aren't deleted from the FE — server cascades on list delete.
  },
  isRetrySafe: (op) => op.type === 'update',
  invalidates: () => [{ type: 'Budgets', id: 'LIST' }],
  rehydrateOptimistic: (op) => {
    if (op.type === 'insert') {
      const b = op.payload.modified as Budget | undefined;
      if (b)
        patchBudgets((draft) => {
          if (!draft.find((x) => x.id === b.id)) draft.unshift(b);
        });
    } else if (op.type === 'update') {
      const updated = op.payload.modified as Budget | undefined;
      if (updated)
        patchBudgets((draft) => {
          const idx = draft.findIndex((x) => x.id === op.key);
          if (idx >= 0) draft[idx] = updated;
        });
    }
  },
};

runner.registerCollection('shoppingLists', shoppingListsRuntime);
runner.registerCollection('budgets', budgetsRuntime);
// shoppingListItems is a synthetic namespace used only for binding storage —
// no runtime registered, the actual item HTTP calls are fan-outs from
// shoppingLists.update.

// Helpers exported so intent files can reuse them.
export { mintTempId };
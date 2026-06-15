import { store } from './store';
import { api } from '../api/api';
import { enqueueMutation } from '../queue/durableEndpoint';
import { mintTempId } from '../queue/types';
import { patchShoppingLists } from './cachePatches';
import { addBudgetForShoppingList } from './budgetIntents';
import type {
  CreateShoppingListInput,
  CreateShoppingListItemInput,
  ShoppingList,
  ShoppingListItem,
} from '../api/types';

import { readShoppingLists } from './cacheReads';

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Helper to enqueue a list update with optimistic patch + diff capture.
// Mutates a deep clone via the recipe, then sends the resulting before/after
// pair into the queue.
function queueListUpdate(
  listId: string,
  recipe: (draft: ShoppingList) => void,
): void {
  const before = readShoppingLists().find((l) => l.id === listId);
  if (!before) return;
  const after: ShoppingList = JSON.parse(JSON.stringify(before));
  recipe(after);
  enqueueMutation(
    store,
    'shoppingLists',
    'update',
    listId,
    { original: before, modified: after },
    {
      optimistic: [
        {
          apply: () =>
            patchShoppingLists((draft) => {
              const idx = draft.findIndex((l) => l.id === listId);
              if (idx >= 0) draft[idx] = after;
            }),
        },
      ],
    },
  );
}

export async function addShoppingList(input: CreateShoppingListInput): Promise<ShoppingList> {
  const now = new Date().toISOString();
  const listId = mintTempId();
  const budgetTotal = randInt(70, 100);

  const optimistic: ShoppingList = {
    id: listId,
    name: input.name,
    description: input.description ?? null,
    todoId: input.todoId ?? null,
    items: input.items.map((it) => ({
      id: mintTempId(),
      name: it.name,
      quantity: it.quantity,
      unit: it.unit ?? null,
      notes: it.notes ?? null,
      cost: it.cost ?? randInt(10, 15),
      shoppingListId: listId,
      createdAt: now,
      updatedAt: now,
    })),
    createdAt: now,
    updatedAt: now,
  };

  enqueueMutation(
    store,
    'shoppingLists',
    'insert',
    listId,
    { modified: optimistic },
    {
      optimistic: [
        {
          apply: () =>
            patchShoppingLists((draft) => {
              draft.unshift(optimistic);
            }),
        },
      ],
    },
  );

  // Queue the budget create as a separate op.
  addBudgetForShoppingList(listId, budgetTotal);
  return optimistic;
}

export async function addShoppingListForTodo(
  todoId: string,
  input: Omit<CreateShoppingListInput, 'todoId'>,
): Promise<ShoppingList> {
  return addShoppingList({ ...input, todoId });
}

export function deleteShoppingList(listId: string): void {
  const before = readShoppingLists().find((l) => l.id === listId);
  if (!before) return;
  enqueueMutation(
    store,
    'shoppingLists',
    'delete',
    listId,
    { original: before },
    {
      optimistic: [
        {
          apply: () =>
            patchShoppingLists((draft) => {
              const idx = draft.findIndex((l) => l.id === listId);
              if (idx >= 0) draft.splice(idx, 1);
            }),
        },
      ],
    },
  );
}

export function addItemToShoppingList(
  listId: string,
  item: CreateShoppingListItemInput,
): void {
  const now = new Date().toISOString();
  queueListUpdate(listId, (draft) => {
    const newItem: ShoppingListItem = {
      id: mintTempId(),
      name: item.name,
      quantity: item.quantity,
      unit: item.unit ?? null,
      notes: item.notes ?? null,
      cost: item.cost ?? randInt(10, 15),
      shoppingListId: listId,
      createdAt: now,
      updatedAt: now,
    };
    draft.items.push(newItem);
    draft.updatedAt = now;
  });
}

export function updateShoppingListItem(
  listId: string,
  itemId: string,
  patch: Partial<Pick<ShoppingListItem, 'name' | 'quantity' | 'unit' | 'notes'>>,
): void {
  const now = new Date().toISOString();
  queueListUpdate(listId, (draft) => {
    const item = draft.items.find((i) => i.id === itemId);
    if (!item) return;
    if (patch.name !== undefined) item.name = patch.name;
    if (patch.quantity !== undefined) item.quantity = patch.quantity;
    if (patch.unit !== undefined) item.unit = patch.unit;
    if (patch.notes !== undefined) item.notes = patch.notes;
    item.updatedAt = now;
    draft.updatedAt = now;
  });
}

export function removeItemFromShoppingList(listId: string, itemId: string): void {
  const now = new Date().toISOString();
  queueListUpdate(listId, (draft) => {
    draft.items = draft.items.filter((i) => i.id !== itemId);
    draft.updatedAt = now;
  });
}

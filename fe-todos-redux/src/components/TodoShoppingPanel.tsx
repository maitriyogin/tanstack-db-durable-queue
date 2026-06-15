import { useState } from 'react';
import { useGetShoppingListsQuery, useGetBudgetsQuery } from '../api/api';
import {
  addShoppingListForTodo,
  addItemToShoppingList,
  removeItemFromShoppingList,
} from '../store/shoppingIntents';
import type { Budget, ShoppingList } from '../api/types';

// Inline shopping-list panel rendered under a todo row. Lazy expand/collapse;
// if no list exists for this todo yet, shows a single "Add shopping list"
// button. Once a list exists, shows the items + an add-item form.
//
// All mutations go through `shoppingIntents` (durable-queue wrapped) so item
// adds/removes survive offline and drain on reconnect just like todos.
export function TodoShoppingPanel({ todoId }: { todoId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [newItemQty, setNewItemQty] = useState(1);

  const listsResult = useGetShoppingListsQuery();
  const budgetsResult = useGetBudgetsQuery();
  const lists = (listsResult.data?.shoppingLists as ShoppingList[] | undefined) ?? [];
  const budgets = (budgetsResult.data?.budgets as Budget[] | undefined) ?? [];

  const list = lists.find((l) => l.todoId === todoId);
  const budget = list
    ? budgets.find((b) => b.shoppingListId === list.id)
    : undefined;

  if (!list) {
    return (
      <div className="mt-3">
        <button
          onClick={() =>
            addShoppingListForTodo(todoId, {
              name: 'Shopping list',
              items: [],
            })
          }
          className="text-sm bg-[#fbf0df]/10 hover:bg-[#fbf0df]/20 text-[#fbf0df] border border-[#fbf0df]/30 px-3 py-1 rounded transition-colors"
        >
          + Add shopping list
        </button>
      </div>
    );
  }

  const itemCount = list.items.length;

  return (
    <div className="mt-3">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="text-sm bg-[#fbf0df]/10 hover:bg-[#fbf0df]/20 text-[#fbf0df] border border-[#fbf0df]/30 px-3 py-1 rounded transition-colors"
      >
        🛒 Shopping list ({itemCount}){' '}
        <span className="text-[#fbf0df]/60">{expanded ? '▾' : '▸'}</span>
      </button>
      {budget && (
        <span
          title={`Budget total $${budget.total}`}
          className={`ml-2 inline-block text-sm px-2 py-1 rounded border ${
            budget.remaining < 0
              ? 'bg-red-500/10 text-red-300 border-red-500/30'
              : 'bg-[#fbf0df]/10 text-[#fbf0df] border-[#fbf0df]/30'
          }`}
        >
          💰 ${budget.remaining} / ${budget.total}
        </span>
      )}

      {expanded && (
        <div className="mt-2 px-3 py-2 rounded bg-[#fbf0df]/5 border border-[#fbf0df]/20">
          {itemCount === 0 ? (
            <p className="text-sm text-gray-400 mb-2">No items yet.</p>
          ) : (
            <ul className="space-y-1 mb-2">
              {list.items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between text-sm text-gray-200"
                >
                  <span>
                    {item.quantity}
                    {item.unit ? ` ${item.unit}` : ''} — {item.name}{' '}
                    <span className="text-gray-400">(${item.cost ?? 0})</span>
                  </span>
                  <button
                    onClick={() => removeItemFromShoppingList(list.id, item.id)}
                    className="text-red-300 hover:text-red-200 ml-2"
                    aria-label={`Remove ${item.name}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = newItemName.trim();
              if (!name) return;
              addItemToShoppingList(list.id, {
                name,
                quantity: newItemQty,
              });
              setNewItemName('');
              setNewItemQty(1);
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={newItemName}
              onChange={(e) => setNewItemName(e.target.value)}
              placeholder="Add item"
              className="flex-1 bg-[#1a1a1a] border border-[#fbf0df]/30 rounded px-2 py-1 text-sm text-white placeholder-gray-500"
            />
            <input
              type="number"
              value={newItemQty}
              onChange={(e) => setNewItemQty(Math.max(1, Number(e.target.value)))}
              min={1}
              className="w-16 bg-[#1a1a1a] border border-[#fbf0df]/30 rounded px-2 py-1 text-sm text-white"
            />
            <button
              type="submit"
              disabled={!newItemName.trim()}
              className="bg-[#fbf0df] text-[#1a1a1a] px-3 py-1 rounded text-sm font-bold hover:bg-[#f3d5a3] transition-colors disabled:opacity-50"
            >
              Add
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

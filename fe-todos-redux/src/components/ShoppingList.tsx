import { useState } from 'react';
import { useGetShoppingListsQuery } from '../api/api';
import {
  addShoppingList,
  deleteShoppingList,
  addItemToShoppingList,
  updateShoppingListItem,
  removeItemFromShoppingList,
} from '../store/shoppingIntents';
import type {
  CreateShoppingListItemInput,
  ShoppingList as ShoppingListType,
  ShoppingListItem as ShoppingListItemType,
} from '../api/types';

interface DraftItem extends CreateShoppingListItemInput {
  key: string;
}

export function ShoppingList() {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<DraftItem[]>([]);
  const [itemName, setItemName] = useState('');
  const [itemQuantity, setItemQuantity] = useState(1);
  const [itemUnit, setItemUnit] = useState('');

  const listsResult = useGetShoppingListsQuery();
  const lists = (listsResult.data?.shoppingLists as ShoppingListType[] | undefined) ?? [];
  const isLoading = listsResult.isLoading;

  const addDraftItem = () => {
    const trimmed = itemName.trim();
    if (!trimmed) return;
    setItems((prev) => [
      ...prev,
      {
        key: crypto.randomUUID(),
        name: trimmed,
        quantity: itemQuantity,
        unit: itemUnit.trim() || undefined,
      },
    ]);
    setItemName('');
    setItemQuantity(1);
    setItemUnit('');
  };

  const removeDraftItem = (key: string) => {
    setItems((prev) => prev.filter((item) => item.key !== key));
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await addShoppingList({
        name: trimmed,
        description: description.trim() || undefined,
        items: items.map(({ key, ...rest }) => rest),
      });
      setName('');
      setDescription('');
      setItems([]);
    } catch (error) {
      console.error('Failed to create shopping list:', error);
    }
  };

  if (isLoading && lists.length === 0) {
    return (
      <div className="mt-8 mx-auto w-full max-w-2xl text-center">
        <p className="text-gray-400">Loading shopping lists...</p>
      </div>
    );
  }

  return (
    <div className="mt-12 mx-auto w-full max-w-2xl">
      <h2 className="text-2xl font-bold mb-4">Shopping Lists</h2>

      <div className="bg-[#1a1a1a] border-2 border-[#fbf0df] rounded-lg p-4 mb-6 space-y-3 text-left">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="List name (e.g. Weekly groceries)"
          className="w-full bg-[#0f0f0f] border border-[#fbf0df]/40 rounded px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-[#f3d5a3]"
        />
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          className="w-full bg-[#0f0f0f] border border-[#fbf0df]/40 rounded px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-[#f3d5a3]"
        />

        <div className="flex gap-2">
          <input
            type="text"
            value={itemName}
            onChange={(e) => setItemName(e.target.value)}
            placeholder="Item"
            className="flex-1 bg-[#0f0f0f] border border-[#fbf0df]/40 rounded px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-[#f3d5a3]"
          />
          <input
            type="number"
            min={1}
            value={itemQuantity}
            onChange={(e) => setItemQuantity(Math.max(1, Number(e.target.value) || 1))}
            className="w-20 bg-[#0f0f0f] border border-[#fbf0df]/40 rounded px-3 py-2 text-white focus:outline-none focus:border-[#f3d5a3]"
          />
          <input
            type="text"
            value={itemUnit}
            onChange={(e) => setItemUnit(e.target.value)}
            placeholder="Unit"
            className="w-24 bg-[#0f0f0f] border border-[#fbf0df]/40 rounded px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-[#f3d5a3]"
          />
          <button
            type="button"
            onClick={addDraftItem}
            disabled={!itemName.trim()}
            className="bg-[#fbf0df] text-[#1a1a1a] px-3 py-2 rounded font-bold hover:bg-[#f3d5a3] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add item
          </button>
        </div>

        {items.length > 0 && (
          <ul className="space-y-1 text-sm">
            {items.map((item) => (
              <li
                key={item.key}
                className="flex items-center justify-between bg-[#0f0f0f] border border-[#fbf0df]/20 rounded px-3 py-1"
              >
                <span>
                  {item.quantity}
                  {item.unit ? ` ${item.unit}` : ''} × {item.name}
                </span>
                <button
                  type="button"
                  onClick={() => removeDraftItem(item.key)}
                  className="text-red-400 hover:text-red-300"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={handleCreate}
          disabled={!name.trim()}
          className="w-full bg-[#fbf0df] text-[#1a1a1a] px-4 py-2 rounded font-bold hover:bg-[#f3d5a3] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Create shopping list
        </button>
      </div>

      {lists.length === 0 ? (
        <p className="text-gray-400 text-center py-8">
          No shopping lists yet. Add one above to get started!
        </p>
      ) : (
        <div className="space-y-3">
          {lists.map((list) => (
            <ShoppingListCard
              key={list.id}
              list={list}
              onDelete={() => deleteShoppingList(list.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ShoppingListCardProps {
  list: ShoppingListType;
  onDelete: () => void;
}

function ShoppingListCard({ list, onDelete }: ShoppingListCardProps) {
  const [newItemName, setNewItemName] = useState('');
  const [newItemQuantity, setNewItemQuantity] = useState(1);
  const [newItemUnit, setNewItemUnit] = useState('');

  const handleAddItem = () => {
    const trimmed = newItemName.trim();
    if (!trimmed) return;
    addItemToShoppingList(list.id, {
      name: trimmed,
      quantity: newItemQuantity,
      unit: newItemUnit.trim() || undefined,
    });
    setNewItemName('');
    setNewItemQuantity(1);
    setNewItemUnit('');
  };

  return (
    <div className="bg-[#1a1a1a] border-2 border-[#fbf0df] rounded-lg p-4 text-left">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-bold text-lg">{list.name}</h3>
          {list.description && (
            <p className="text-gray-400 text-sm">{list.description}</p>
          )}
        </div>
        <button
          onClick={onDelete}
          className="bg-red-500 hover:bg-red-600 text-white px-3 py-1 rounded transition-colors"
        >
          Delete list
        </button>
      </div>

      <ul className="space-y-1 text-sm mb-3">
        {list.items.map((item) => (
          <ShoppingListItemRow key={item.id} listId={list.id} item={item} />
        ))}
      </ul>

      <div className="flex gap-2">
        <input
          type="text"
          value={newItemName}
          onChange={(e) => setNewItemName(e.target.value)}
          placeholder="Add item"
          className="flex-1 bg-[#0f0f0f] border border-[#fbf0df]/40 rounded px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#f3d5a3]"
        />
        <input
          type="number"
          min={1}
          value={newItemQuantity}
          onChange={(e) =>
            setNewItemQuantity(Math.max(1, Number(e.target.value) || 1))
          }
          className="w-16 bg-[#0f0f0f] border border-[#fbf0df]/40 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#f3d5a3]"
        />
        <input
          type="text"
          value={newItemUnit}
          onChange={(e) => setNewItemUnit(e.target.value)}
          placeholder="Unit"
          className="w-20 bg-[#0f0f0f] border border-[#fbf0df]/40 rounded px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#f3d5a3]"
        />
        <button
          type="button"
          onClick={handleAddItem}
          disabled={!newItemName.trim()}
          className="bg-[#fbf0df] text-[#1a1a1a] px-3 py-1.5 rounded text-sm font-bold hover:bg-[#f3d5a3] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Add
        </button>
      </div>
    </div>
  );
}

interface ShoppingListItemRowProps {
  listId: string;
  item: ShoppingListItemType;
}

function ShoppingListItemRow({ listId, item }: ShoppingListItemRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [quantity, setQuantity] = useState(item.quantity);
  const [unit, setUnit] = useState(item.unit ?? '');

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    updateShoppingListItem(listId, item.id, {
      name: trimmed,
      quantity,
      unit: unit.trim() || null,
    });
    setIsEditing(false);
  };

  const cancel = () => {
    setName(item.name);
    setQuantity(item.quantity);
    setUnit(item.unit ?? '');
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <li className="flex items-center gap-2 bg-[#0f0f0f] border border-[#fbf0df]/20 rounded px-3 py-1">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 bg-[#1a1a1a] border border-[#fbf0df]/30 rounded px-2 py-0.5 text-sm"
        />
        <input
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
          className="w-14 bg-[#1a1a1a] border border-[#fbf0df]/30 rounded px-2 py-0.5 text-sm"
        />
        <input
          type="text"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          placeholder="Unit"
          className="w-16 bg-[#1a1a1a] border border-[#fbf0df]/30 rounded px-2 py-0.5 text-sm"
        />
        <button
          onClick={save}
          className="text-green-400 hover:text-green-300 text-xs"
        >
          Save
        </button>
        <button
          onClick={cancel}
          className="text-gray-400 hover:text-gray-300 text-xs"
        >
          Cancel
        </button>
      </li>
    );
  }

  return (
    <li className="flex items-center justify-between bg-[#0f0f0f] border border-[#fbf0df]/20 rounded px-3 py-1">
      <span>
        <span className="text-gray-400 mr-2">
          {item.quantity}
          {item.unit ? ` ${item.unit}` : ''} ×
        </span>
        {item.name}
      </span>
      <div className="flex gap-3">
        <button
          onClick={() => setIsEditing(true)}
          className="text-blue-400 hover:text-blue-300 text-xs"
        >
          Edit
        </button>
        <button
          onClick={() => removeItemFromShoppingList(listId, item.id)}
          className="text-red-400 hover:text-red-300 text-xs"
        >
          Delete
        </button>
      </div>
    </li>
  );
}